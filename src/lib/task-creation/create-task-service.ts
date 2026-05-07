/**
 * Task Creation Service
 * Creates tasks from source entities using matched rules
 * Handles assignment, roster validation, and metadata storage
 */

import prisma from "@/lib/db/client";
import { SourceEntity, TaskCreationContext, TaskCreationResult } from "@/types/multi-source";
import { RuleMatchResult } from "./rule-matcher";
import { assignTaskWithFallback, TaskAssignmentRequest } from "./assignment-service";

/**
 * Generate a task title from template and entity metadata
 */
function generateTaskTitle(
  titleTemplate: string,
  entity: SourceEntity,
  sourceInfo: { displayName: string }
): string {
  let title = titleTemplate;

  // Replace placeholders like {patientName}, {orderId}, etc.
  for (const [key, value] of Object.entries(entity.metadata)) {
    const placeholder = `{${key}}`;
    if (title.includes(placeholder)) {
      title = title.replace(new RegExp(placeholder, "g"), String(value || ""));
    }
  }

  // Replace {sourceType} and {sourceStatus}
  title = title.replace("{sourceType}", entity.type);
  title = title.replace("{sourceStatus}", entity.status);

  // Ensure title isn't empty
  if (!title.trim()) {
    title = `Task from ${sourceInfo.displayName} #${entity.id}`;
  }

  return title;
}

/**
 * Create a task from a source entity and matching rule
 */
export async function createTaskFromSourceEntity(
  sourceId: string,
  entity: SourceEntity,
  rule: RuleMatchResult,
  sourceDisplayName: string,
  storeId?: number
): Promise<TaskCreationResult> {
  try {
    // Check if task already exists for this rule and entity
    const existingTask = await prisma.task.findFirst({
      where: {
        taskRuleId: rule.taskRuleId,
        source: sourceId,
        sourceEntityId: Number(entity.id),
      },
    });

    if (existingTask) {
      return {
        taskId: existingTask.id,
        source: sourceId,
        sourceEntityId: entity.id,
        success: false,
        error: "Task already exists for this entity and rule",
      };
    }

    // Get the task rule for more details
    const taskRule = await prisma.taskRule.findUnique({
      where: { id: rule.taskRuleId },
      include: { taskType: true },
    });

    if (!taskRule) {
      return {
        taskId: 0,
        source: sourceId,
        sourceEntityId: entity.id,
        success: false,
        error: `Task rule not found: ${rule.taskRuleId}`,
      };
    }

    // Generate task title
    const taskTitle = generateTaskTitle(
      taskRule.titleTemplate,
      entity,
      { displayName: sourceDisplayName }
    );

    // Calculate SLA deadline
    const slaMinutes = rule.slaMinutesOverride || taskRule.slaMinutes;
    const slaDeadline = new Date();
    slaDeadline.setMinutes(slaDeadline.getMinutes() + slaMinutes);

    // Attempt to assign the task to an agent
    console.log(
      `[TaskCreationService] Assigning task using strategy: ${rule.assignmentStrategy}`
    );

    const appointmentDate = entity.metadata.appointmentTime
      ? new Date(entity.metadata.appointmentTime as string)
      : new Date();

    const assignmentRequest: TaskAssignmentRequest = {
      sourceId,
      entity,
      strategyName: rule.assignmentStrategy,
      strategyConfig: rule.assignmentStrategyConfig,
      storeId,
      taskDate: appointmentDate,
      enforceRosterValidation: true,
    };

    const assignmentResult = await assignTaskWithFallback(assignmentRequest);

    // Create the task
    const task = await prisma.task.create({
      data: {
        taskRuleId: rule.taskRuleId,
        taskTypeId: taskRule.taskTypeId,
        title: taskTitle,
        entityType: sourceId.toUpperCase(),
        entityId: Number(entity.id),
        orderType: "HOME_SAMPLE", // Default, can be overridden from entity metadata
        priority: taskRule.priority,
        status: "CREATED",
        storeId,
        slaDeadline,
        appointmentTime: appointmentDate,

        // Assignment fields (filled if assignment succeeded)
        assignedToId: assignmentResult.success ? assignmentResult.assignedToId : null,
        teamMemberId: assignmentResult.success ? assignmentResult.teamMemberId : null,
        assignedAt: assignmentResult.success ? new Date() : null,
        assignmentMethod: assignmentResult.success ? "auto" : null,

        // Multi-source fields
        source: sourceId,
        sourceType: entity.type,
        sourceStatus: entity.status,
        sourceEntityId: Number(entity.id),
        sourceLastSyncedAt: null,
        sourceHandlerContext: entity.metadata,

        // Assignment tracking
        assignmentRuleId: rule.ruleScopeId,

        // Metadata
        metadata: {
          ruleName: rule.ruleName,
          assignmentStrategy: rule.assignmentStrategy,
          assignmentResult: assignmentResult,
          sourceEntity: {
            id: entity.id,
            type: entity.type,
            status: entity.status,
          },
        },
      },
    });

    // Log assignment outcome
    if (assignmentResult.success) {
      console.log(
        `[TaskCreationService] ✓ Task #${task.id} created and assigned to user #${assignmentResult.assignedToId}`
      );
    } else {
      console.warn(
        `[TaskCreationService] ⚠ Task #${task.id} created but NOT assigned: ${assignmentResult.reason}`
      );
    }

    return {
      taskId: task.id,
      source: sourceId,
      sourceEntityId: entity.id,
      success: true,
    };
  } catch (error) {
    console.error(
      `[TaskCreationService] Error creating task from source entity:`,
      error
    );

    return {
      taskId: 0,
      source: sourceId,
      sourceEntityId: entity.id,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Create tasks for multiple source entities
 */
export async function createTasksFromSourceEntities(
  sourceId: string,
  entities: SourceEntity[],
  rules: RuleMatchResult[],
  sourceDisplayName: string,
  storeId?: number
): Promise<TaskCreationResult[]> {
  const results: TaskCreationResult[] = [];

  for (const entity of entities) {
    // For each entity, create a task for each matching rule
    // Or alternatively, create just one task per entity (first matching rule)
    for (const rule of rules) {
      const result = await createTaskFromSourceEntity(
        sourceId,
        entity,
        rule,
        sourceDisplayName,
        storeId
      );
      results.push(result);
    }
  }

  return results;
}

/**
 * Sync task status back to source system
 */
export async function syncTaskStatusToSource(
  taskId: number,
  handler: any // ISourceHandler type
): Promise<void> {
  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (!task.source || !task.sourceEntityId) {
      console.warn(
        `[TaskCreationService] Task ${taskId} has no source information`
      );
      return;
    }

    // Call the handler's sync method
    await handler.syncTaskStatusToSource(
      taskId,
      task.sourceEntityId,
      task.status,
      task.sourceHandlerContext || {}
    );

    // Update sync timestamp
    await prisma.task.update({
      where: { id: taskId },
      data: {
        sourceLastSyncedAt: new Date(),
      },
    });

    console.log(
      `[TaskCreationService] Synced task ${taskId} status (${task.status}) back to source`
    );
  } catch (error) {
    console.error(
      `[TaskCreationService] Error syncing task ${taskId} to source:`,
      error
    );
    throw error;
  }
}
