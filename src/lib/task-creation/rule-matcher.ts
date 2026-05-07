/**
 * Rule Matcher
 * Determines which task rules apply to a source entity
 * Handles source-aware matching with type/status filtering
 */

import prisma from "@/lib/db/client";
import { SourceEntity } from "@/types/multi-source";

export interface RuleMatchResult {
  taskRuleId: string;
  ruleName: string;
  ruleScopeId: string;
  priority: string;
  slaMinutesOverride?: number;
  assignmentStrategy: string;
  assignmentStrategyConfig?: Record<string, unknown>;
}

/**
 * Find matching task rules for a source entity
 */
export async function findMatchingRules(
  sourceId: string,
  entity: SourceEntity
): Promise<RuleMatchResult[]> {
  try {
    // Find all active task rule source scopes for this source
    const ruleScopes = await prisma.taskRuleSourceScope.findMany({
      where: {
        dataSourceId: sourceId,
        isActive: true,
      },
      include: {
        taskRule: {
          include: {
            taskType: true,
          },
        },
      },
    });

    const matches: RuleMatchResult[] = [];

    for (const scope of ruleScopes) {
      // Parse allowed types and statuses from JSON
      const allowedTypes = Array.isArray(scope.allowedTypes)
        ? scope.allowedTypes
        : (scope.allowedTypes as any)?.value || [];
      const allowedStatuses = Array.isArray(scope.allowedStatuses)
        ? scope.allowedStatuses
        : (scope.allowedStatuses as any)?.value || [];

      // Check if entity type matches
      const typeMatches =
        allowedTypes.length === 0 || allowedTypes.includes(entity.type);

      // Check if entity status matches
      const statusMatches =
        allowedStatuses.length === 0 ||
        allowedStatuses.includes(entity.status);

      // If both type and status match, this is a matching rule
      if (typeMatches && statusMatches) {
        matches.push({
          taskRuleId: scope.taskRule.id,
          ruleName: scope.taskRule.name,
          ruleScopeId: scope.id,
          priority: scope.taskRule.priority,
          slaMinutesOverride: scope.slaMinutesOverride || undefined,
          assignmentStrategy: scope.assignmentStrategy,
          assignmentStrategyConfig: scope.assignmentStrategyConfig as any,
        });
      }
    }

    return matches;
  } catch (error) {
    console.error(
      `[RuleMatcher] Error finding matching rules for source ${sourceId}, entity ${entity.id}:`,
      error
    );
    throw error;
  }
}

/**
 * Check if entity matches rule scope filters
 */
export function entityMatchesRuleScope(
  entity: SourceEntity,
  allowedTypes: string[],
  allowedStatuses: string[]
): boolean {
  const typeMatches =
    allowedTypes.length === 0 || allowedTypes.includes(entity.type);
  const statusMatches =
    allowedStatuses.length === 0 || allowedStatuses.includes(entity.status);

  return typeMatches && statusMatches;
}

/**
 * Get the highest priority matching rule
 * Returns first matching rule (rules should be ordered by priority)
 */
export async function getHighestPriorityRule(
  sourceId: string,
  entity: SourceEntity
): Promise<RuleMatchResult | null> {
  const matches = await findMatchingRules(sourceId, entity);
  return matches.length > 0 ? matches[0] : null;
}

/**
 * Get all matching rules sorted by priority
 */
export async function getAllMatchingRulesSorted(
  sourceId: string,
  entity: SourceEntity
): Promise<RuleMatchResult[]> {
  const matches = await findMatchingRules(sourceId, entity);

  // Sort by priority: URGENT > HIGH > MEDIUM > LOW
  const priorityOrder = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const sortOrder = (priority: string) =>
    priorityOrder[priority as keyof typeof priorityOrder] ?? 999;

  return matches.sort((a, b) => sortOrder(a.priority) - sortOrder(b.priority));
}
