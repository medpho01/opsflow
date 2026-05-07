/**
 * Task Aggregator
 * Combines similar tasks to reduce volume
 * Supports: grouping, deduplication, consolidation
 */

import prisma from "@/lib/db/client";

export interface AggregationConfig {
  enabled: boolean;
  groupBy: string[]; // Fields to group by (e.g., ["storeId", "sourceType"])
  maxGroupSize: number; // Max tasks per group before creating group task
  aggregateMetadata: boolean; // Combine metadata from grouped tasks
}

export interface AggregatedTaskGroup {
  groupId: string;
  groupKey: Record<string, unknown>;
  originalTaskIds: number[];
  aggregatedTaskId?: number;
  entityCount: number;
  firstEntityId: number | string;
  lastEntityId: number | string;
  createdAt: Date;
  status: "CREATED" | "ASSIGNED" | "IN_PROGRESS" | "COMPLETED";
}

/**
 * Check if tasks should be aggregated
 */
export function shouldAggregateTasks(
  taskCount: number,
  config: AggregationConfig
): boolean {
  return (
    config.enabled &&
    taskCount > 1 &&
    taskCount >= config.maxGroupSize
  );
}

/**
 * Group similar tasks
 */
export function groupTasks(
  tasks: Array<any>,
  groupByFields: string[]
): Map<string, typeof tasks> {
  const groups = new Map<string, typeof tasks>();

  for (const task of tasks) {
    // Build group key from specified fields
    const keyParts: string[] = [];
    for (const field of groupByFields) {
      const value = task[field] || "null";
      keyParts.push(`${field}=${value}`);
    }
    const groupKey = keyParts.join("|");

    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey)!.push(task);
  }

  return groups;
}

/**
 * Aggregate tasks into a group task
 * Creates a parent task that represents multiple entities
 */
export async function aggregateTasksIntoGroup(
  taskIds: number[],
  groupBy: Record<string, unknown>,
  sourceId: string
): Promise<AggregatedTaskGroup> {
  try {
    // Get original tasks
    const tasks = await prisma.task.findMany({
      where: { id: { in: taskIds } },
      select: {
        id: true,
        sourceEntityId: true,
        metadata: true,
      },
    });

    if (tasks.length === 0) {
      throw new Error("No tasks found to aggregate");
    }

    // Create aggregated task
    const firstTask = tasks[0];
    const lastTask = tasks[tasks.length - 1];

    const groupTitle = `[AGGREGATED] ${tasks.length} items - ${Object.entries(groupBy)
      .map(([k, v]) => `${k}:${v}`)
      .join(", ")}`;

    // Combine metadata from all tasks
    const combinedMetadata: any = {
      aggregated: true,
      originalTaskCount: tasks.length,
      originalTaskIds: taskIds,
      groupKey: groupBy,
      sourceId,
    };

    if (tasks.length > 0) {
      const metadataArray = tasks
        .map((t) => t.metadata)
        .filter((m) => m);
      if (metadataArray.length > 0) {
        combinedMetadata.aggregatedItems = metadataArray;
      }
    }

    // For now, this function plans aggregation but doesn't create actual task
    // In production, you'd create a parent task here:
    /*
    const groupTask = await prisma.task.create({
      data: {
        title: groupTitle,
        // ... other fields
        metadata: combinedMetadata
      }
    });
    */

    return {
      groupId: `agg-${Date.now()}`,
      groupKey: groupBy,
      originalTaskIds: taskIds,
      entityCount: tasks.length,
      firstEntityId: firstTask.sourceEntityId || firstTask.id,
      lastEntityId: lastTask.sourceEntityId || lastTask.id,
      createdAt: new Date(),
      status: "CREATED",
    };
  } catch (error) {
    console.error("[TaskAggregator] Error aggregating tasks:", error);
    throw error;
  }
}

/**
 * Get aggregation statistics
 */
export async function getAggregationStats(sourceId: string) {
  try {
    const totalTasks = await prisma.task.count({
      where: { source: sourceId },
    });

    const aggregatedTasks = await prisma.task.count({
      where: {
        source: sourceId,
        metadata: {
          path: ["aggregated"],
          equals: true,
        },
      },
    });

    const avgTasksPerEntity = await prisma.$queryRaw<[{ avg: number }]>`
      SELECT AVG(CAST(metadata->>'originalTaskCount' AS INTEGER)) as avg
      FROM tasks
      WHERE source = ${sourceId}
      AND metadata->>'aggregated' = 'true'
    `;

    return {
      sourceId,
      totalTasks,
      aggregatedTasks,
      volumeReduction: {
        percent: aggregatedTasks > 0
          ? Math.round(((aggregatedTasks / totalTasks) * 100))
          : 0,
        tasksConsolidated: aggregatedTasks,
      },
      avgTasksPerGroup: avgTasksPerEntity[0]?.avg || 1,
    };
  } catch (error) {
    console.error("[TaskAggregator] Error getting stats:", error);
    return {
      sourceId,
      totalTasks: 0,
      aggregatedTasks: 0,
      volumeReduction: { percent: 0, tasksConsolidated: 0 },
      avgTasksPerGroup: 1,
    };
  }
}

/**
 * Deduplication: Remove duplicate tasks for same entity
 */
export async function deduplicateTasks(
  sourceId: string,
  sourceEntityId: number | string
): Promise<number> {
  try {
    // Find all tasks for this entity
    const tasks = await prisma.task.findMany({
      where: {
        source: sourceId,
        sourceEntityId: Number(sourceEntityId),
      },
      orderBy: {
        createdAt: "desc", // Keep most recent
      },
    });

    if (tasks.length <= 1) {
      return 0; // No duplicates
    }

    const tasksToDelete = tasks.slice(1).map((t) => t.id);

    // Delete duplicates
    const result = await prisma.task.deleteMany({
      where: {
        id: { in: tasksToDelete },
      },
    });

    console.log(
      `[TaskAggregator] Deduped ${tasksToDelete.length} duplicate tasks for ${sourceId}:${sourceEntityId}`
    );

    return result.count;
  } catch (error) {
    console.error("[TaskAggregator] Error deduplicating:", error);
    return 0;
  }
}

/**
 * Consolidate related tasks (same rule, same entity type)
 */
export async function consolidateRelatedTasks(
  sourceId: string,
  ruleId: string,
  entityType: string
) {
  try {
    // Find all tasks matching criteria
    const tasks = await prisma.task.findMany({
      where: {
        source: sourceId,
        taskRuleId: ruleId,
        sourceType: entityType,
        status: "CREATED",
      },
      select: {
        id: true,
        sourceEntityId: true,
        storeId: true,
      },
      orderBy: { createdAt: "asc" },
    });

    if (tasks.length < 2) {
      return { consolidated: 0, groups: [] };
    }

    // Group by store
    const groups = new Map<number | null, number[]>();
    for (const task of tasks) {
      const storeId = task.storeId ?? null;
      if (!groups.has(storeId)) {
        groups.set(storeId, []);
      }
      groups.get(storeId)!.push(task.id);
    }

    // Consolidate each group
    let consolidated = 0;
    const groupResults = [];

    for (const [storeId, taskIds] of groups) {
      if (taskIds.length > 1) {
        const group = await aggregateTasksIntoGroup(
          taskIds,
          { storeId, ruleId, entityType },
          sourceId
        );
        groupResults.push(group);
        consolidated += taskIds.length - 1;
      }
    }

    return {
      consolidated,
      groups: groupResults,
    };
  } catch (error) {
    console.error("[TaskAggregator] Error consolidating:", error);
    return { consolidated: 0, groups: [] };
  }
}
