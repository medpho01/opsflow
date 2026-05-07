/**
 * Assignment Strategies
 * Implements different strategies for assigning tasks to agents
 * Supports: round-robin, skill-based, store-affinity, least-loaded, geo-based
 */

import prisma from "@/lib/db/client";
import { SourceEntity } from "@/types/multi-source";

export interface AssignmentContext {
  sourceId: string;
  entity: SourceEntity;
  storeId?: number;
  requiredSkills?: string[];
  strategyConfig?: Record<string, unknown>;
}

export interface AssignmentResult {
  success: boolean;
  assignedToId?: number; // User ID
  teamMemberId?: number;
  strategy: string;
  reason: string;
  error?: string;
}

/**
 * Base interface for assignment strategies
 */
export interface IAssignmentStrategy {
  name: string;
  assign(context: AssignmentContext): Promise<AssignmentResult>;
}

/**
 * Round-Robin Strategy
 * Distributes tasks evenly across active agents
 */
export class RoundRobinStrategy implements IAssignmentStrategy {
  name = "round_robin";

  async assign(context: AssignmentContext): Promise<AssignmentResult> {
    try {
      const key = `assignment:rr:${context.sourceId}`;

      // Get all active team members
      const activeMembers = await prisma.teamMember.findMany({
        where: { isActive: true },
        include: {
          user: true,
          assignedTasks: {
            where: { status: { notIn: ["COMPLETED", "CANCELLED"] } },
          },
        },
      });

      if (activeMembers.length === 0) {
        return {
          success: false,
          strategy: this.name,
          reason: "No active team members available",
          error: "NO_AGENTS_AVAILABLE",
        };
      }

      // Get last assigned member for this source
      const lastAssignment = await prisma.task.findFirst({
        where: { source: context.sourceId, assignedToId: { not: null } },
        orderBy: { assignedAt: "desc" },
        select: { teamMemberId: true },
      });

      let lastMemberId = lastAssignment?.teamMemberId;

      // Find next member in rotation
      const currentIndex = lastMemberId
        ? activeMembers.findIndex((m) => m.id === lastMemberId)
        : -1;
      const nextIndex = (currentIndex + 1) % activeMembers.length;
      const assignedMember = activeMembers[nextIndex];

      return {
        success: true,
        assignedToId: assignedMember.userId,
        teamMemberId: assignedMember.id,
        strategy: this.name,
        reason: `Assigned via round-robin (member ${nextIndex + 1}/${activeMembers.length})`,
      };
    } catch (error) {
      return {
        success: false,
        strategy: this.name,
        reason: "Round-robin assignment failed",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}

/**
 * Skill-Based Strategy
 * Assigns to agents with required skills
 */
export class SkillBasedStrategy implements IAssignmentStrategy {
  name = "skill_based";

  async assign(context: AssignmentContext): Promise<AssignmentResult> {
    try {
      if (!context.requiredSkills || context.requiredSkills.length === 0) {
        // Fallback to round-robin if no skills required
        const rrStrategy = new RoundRobinStrategy();
        return rrStrategy.assign(context);
      }

      // Find agents with matching skills
      const skillMatches = await prisma.teamMember.findMany({
        where: {
          isActive: true,
          skills: {
            some: {
              skillTag: {
                name: { in: context.requiredSkills },
              },
            },
          },
        },
        include: {
          user: true,
          skills: { include: { skillTag: true } },
          assignedTasks: {
            where: { status: { notIn: ["COMPLETED", "CANCELLED"] } },
          },
        },
      });

      if (skillMatches.length === 0) {
        return {
          success: false,
          strategy: this.name,
          reason: `No agents with required skills: ${context.requiredSkills.join(", ")}`,
          error: "NO_SKILLED_AGENTS",
        };
      }

      // Assign to agent with fewest current tasks (least loaded)
      const assigned = skillMatches.reduce((prev, curr) =>
        curr.assignedTasks.length < prev.assignedTasks.length ? curr : prev
      );

      return {
        success: true,
        assignedToId: assigned.userId,
        teamMemberId: assigned.id,
        strategy: this.name,
        reason: `Assigned to agent with skills: ${context.requiredSkills.join(", ")}`,
      };
    } catch (error) {
      return {
        success: false,
        strategy: this.name,
        reason: "Skill-based assignment failed",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}

/**
 * Store Affinity Strategy
 * Assigns to agents assigned to the same store
 */
export class StoreAffinityStrategy implements IAssignmentStrategy {
  name = "store_affinity";

  async assign(context: AssignmentContext): Promise<AssignmentResult> {
    try {
      if (!context.storeId) {
        // Fallback to round-robin if no store specified
        const rrStrategy = new RoundRobinStrategy();
        return rrStrategy.assign(context);
      }

      // Find agents assigned to this store
      const storeAgents = await prisma.teamMember.findMany({
        where: {
          isActive: true,
          storeAssignments: {
            some: { storeId: context.storeId },
          },
        },
        include: {
          user: true,
          assignedTasks: {
            where: { status: { notIn: ["COMPLETED", "CANCELLED"] } },
          },
        },
      });

      if (storeAgents.length === 0) {
        // Fallback to any active agent
        const anyAgent = await prisma.teamMember.findFirst({
          where: { isActive: true },
          include: { user: true },
        });

        if (!anyAgent) {
          return {
            success: false,
            strategy: this.name,
            reason: "No agents available (store fallback failed)",
            error: "NO_AGENTS_AVAILABLE",
          };
        }

        return {
          success: true,
          assignedToId: anyAgent.userId,
          teamMemberId: anyAgent.id,
          strategy: this.name,
          reason: `No agents for store ${context.storeId}, assigned to available agent`,
        };
      }

      // Assign to least loaded agent in store
      const assigned = storeAgents.reduce((prev, curr) =>
        curr.assignedTasks.length < prev.assignedTasks.length ? curr : prev
      );

      return {
        success: true,
        assignedToId: assigned.userId,
        teamMemberId: assigned.id,
        strategy: this.name,
        reason: `Assigned to store agent (store ${context.storeId})`,
      };
    } catch (error) {
      return {
        success: false,
        strategy: this.name,
        reason: "Store affinity assignment failed",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}

/**
 * Least Loaded Strategy
 * Assigns to agent with fewest current tasks
 */
export class LeastLoadedStrategy implements IAssignmentStrategy {
  name = "least_loaded";

  async assign(context: AssignmentContext): Promise<AssignmentResult> {
    try {
      const activeMembers = await prisma.teamMember.findMany({
        where: { isActive: true },
        include: {
          user: true,
          assignedTasks: {
            where: { status: { notIn: ["COMPLETED", "CANCELLED"] } },
          },
        },
      });

      if (activeMembers.length === 0) {
        return {
          success: false,
          strategy: this.name,
          reason: "No active team members available",
          error: "NO_AGENTS_AVAILABLE",
        };
      }

      // Find agent with least tasks
      const assigned = activeMembers.reduce((prev, curr) =>
        curr.assignedTasks.length < prev.assignedTasks.length ? curr : prev
      );

      return {
        success: true,
        assignedToId: assigned.userId,
        teamMemberId: assigned.id,
        strategy: this.name,
        reason: `Assigned to least loaded agent (${assigned.assignedTasks.length} current tasks)`,
      };
    } catch (error) {
      return {
        success: false,
        strategy: this.name,
        reason: "Least loaded assignment failed",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}

/**
 * Geo-Based Strategy
 * Assigns based on agent location (requires location data in metadata)
 */
export class GeoBasedStrategy implements IAssignmentStrategy {
  name = "geo_based";

  async assign(context: AssignmentContext): Promise<AssignmentResult> {
    try {
      // For now, fallback to least loaded since location data isn't in schema
      // In future: use coordinates from entity metadata and team member location
      const strategy = new LeastLoadedStrategy();
      const result = await strategy.assign(context);
      result.strategy = this.name;
      result.reason = `[GEO] ${result.reason}`;
      return result;
    } catch (error) {
      return {
        success: false,
        strategy: this.name,
        reason: "Geo-based assignment failed",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}

/**
 * Priority-Based Strategy
 * Assigns to agents with matching priority expertise
 */
export class PriorityBasedStrategy implements IAssignmentStrategy {
  name = "priority_based";

  async assign(context: AssignmentContext): Promise<AssignmentResult> {
    try {
      // Priority can be: URGENT, HIGH, MEDIUM, LOW
      // Assign URGENT tasks to senior/experienced agents
      // For now, use least loaded but could be enhanced with agent seniority

      const strategy = new LeastLoadedStrategy();
      const result = await strategy.assign(context);
      result.strategy = this.name;
      result.reason = `[PRIORITY] ${result.reason}`;
      return result;
    } catch (error) {
      return {
        success: false,
        strategy: this.name,
        reason: "Priority-based assignment failed",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}

/**
 * Get strategy instance by name
 */
export function getAssignmentStrategy(
  strategyName: string
): IAssignmentStrategy {
  const strategies: Record<string, IAssignmentStrategy> = {
    round_robin: new RoundRobinStrategy(),
    skill_based: new SkillBasedStrategy(),
    store_affinity: new StoreAffinityStrategy(),
    least_loaded: new LeastLoadedStrategy(),
    geo_based: new GeoBasedStrategy(),
    priority_based: new PriorityBasedStrategy(),
  };

  return (
    strategies[strategyName] ||
    strategies.round_robin // Default fallback
  );
}

/**
 * Get all available strategies
 */
export function getAllStrategies(): IAssignmentStrategy[] {
  return [
    new RoundRobinStrategy(),
    new SkillBasedStrategy(),
    new StoreAffinityStrategy(),
    new LeastLoadedStrategy(),
    new GeoBasedStrategy(),
    new PriorityBasedStrategy(),
  ];
}
