/**
 * Assignment Service
 * Orchestrates task assignment using strategies and roster validation
 * Ensures agents are available before assignment
 */

import { SourceEntity } from "@/types/multi-source";
import {
  AssignmentContext,
  AssignmentResult,
  getAssignmentStrategy,
} from "./assignment-strategies";
import {
  getAgentAvailability,
  validateAssignmentByRoster,
} from "./roster-validator";

export interface TaskAssignmentRequest {
  sourceId: string;
  entity: SourceEntity;
  strategyName: string;
  strategyConfig?: Record<string, unknown>;
  storeId?: number;
  requiredSkills?: string[];
  taskDate?: Date;
  enforceRosterValidation?: boolean; // Default: true
}

/**
 * Assign a task using the specified strategy
 * Returns the assigned agent ID or null if assignment fails
 */
export async function assignTask(
  request: TaskAssignmentRequest
): Promise<AssignmentResult> {
  console.log(
    `[AssignmentService] Assigning task from ${request.sourceId} entity ${request.entity.id} using ${request.strategyName}`
  );

  try {
    // Get the assignment strategy
    const strategy = getAssignmentStrategy(request.strategyName);

    // Execute assignment strategy
    const context: AssignmentContext = {
      sourceId: request.sourceId,
      entity: request.entity,
      storeId: request.storeId,
      requiredSkills: request.requiredSkills,
      strategyConfig: request.strategyConfig,
    };

    const assignmentResult = await strategy.assign(context);

    if (!assignmentResult.success) {
      console.warn(
        `[AssignmentService] Assignment failed: ${assignmentResult.error} - ${assignmentResult.reason}`
      );
      return assignmentResult;
    }

    // Validate roster if enforcement is enabled
    if (request.enforceRosterValidation !== false && assignmentResult.teamMemberId) {
      const rosterValidation = await validateAssignmentByRoster(
        assignmentResult.teamMemberId,
        request.taskDate
      );

      if (!rosterValidation.valid) {
        console.warn(
          `[AssignmentService] Roster validation failed: ${rosterValidation.reason}`
        );

        // Try alternative strategy: least loaded (ignoring roster)
        if (request.strategyName !== "least_loaded") {
          console.log(
            `[AssignmentService] Retrying with least_loaded strategy`
          );
          return assignTask({
            ...request,
            strategyName: "least_loaded",
            enforceRosterValidation: false,
          });
        }

        // If least loaded also failed, return original failure
        return {
          success: false,
          strategy: request.strategyName,
          reason: rosterValidation.reason,
          error: "ROSTER_VALIDATION_FAILED",
        };
      }

      // Roster validation passed
      console.log(
        `[AssignmentService] ✓ Assignment validated: ${assignmentResult.reason}`
      );
    }

    console.log(
      `[AssignmentService] ✓ Task assigned to user #${assignmentResult.assignedToId} (team member #${assignmentResult.teamMemberId})`
    );

    return assignmentResult;
  } catch (error) {
    console.error("[AssignmentService] Assignment error:", error);

    return {
      success: false,
      strategy: request.strategyName,
      reason: "Assignment service error",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Simulate assignment without executing
 * Useful for testing and validation
 */
export async function simulateAssignment(
  request: TaskAssignmentRequest
): Promise<AssignmentResult & { simulatedAt: Date }> {
  const result = await assignTask(request);

  return {
    ...result,
    simulatedAt: new Date(),
  };
}

/**
 * Get agent availability information for decision making
 */
export async function getAssignmentInfo(
  teamMemberId: number,
  taskDate?: Date
) {
  const availability = await getAgentAvailability(
    teamMemberId,
    taskDate || new Date()
  );

  return {
    teamMemberId,
    availability: {
      available: availability.available,
      status: availability.status,
      workingHours: availability.workingHours,
      reason: availability.reason,
    },
  };
}

/**
 * Fallback assignment if primary strategy fails
 * Tries strategies in order: least_loaded → round_robin
 */
export async function assignTaskWithFallback(
  request: TaskAssignmentRequest
): Promise<AssignmentResult> {
  // Try primary strategy
  const primary = await assignTask(request);

  if (primary.success) {
    return primary;
  }

  console.warn(
    `[AssignmentService] Primary strategy "${request.strategyName}" failed, trying fallbacks`
  );

  // Fallback 1: Try least loaded
  if (request.strategyName !== "least_loaded") {
    const fallback1 = await assignTask({
      ...request,
      strategyName: "least_loaded",
      enforceRosterValidation: false,
    });

    if (fallback1.success) {
      console.log("[AssignmentService] ✓ Fallback to least_loaded succeeded");
      return fallback1;
    }
  }

  // Fallback 2: Try round robin
  if (request.strategyName !== "round_robin") {
    const fallback2 = await assignTask({
      ...request,
      strategyName: "round_robin",
      enforceRosterValidation: false,
    });

    if (fallback2.success) {
      console.log("[AssignmentService] ✓ Fallback to round_robin succeeded");
      return fallback2;
    }
  }

  // All strategies failed
  console.error(
    "[AssignmentService] All assignment strategies failed for entity",
    request.entity.id
  );

  return {
    success: false,
    strategy: request.strategyName,
    reason: "All assignment strategies exhausted",
    error: "ASSIGNMENT_EXHAUSTED",
  };
}
