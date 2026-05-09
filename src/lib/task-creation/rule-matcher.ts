/**
 * Rule Matcher
 * Determines which task rules apply to a source entity.
 * Queries TaskRule directly — rules now own their dataSourceId, allowedTypes, and allowedStatuses.
 */

import prisma from "@/lib/db/client";
import { SourceEntity } from "@/types/multi-source";

export interface RuleMatchResult {
  taskRuleId: string;
  ruleName: string;
  priority: string;
  slaMinutes: number;
  assignmentStrategy: string;
}

/**
 * Find all active task rules that match this source entity.
 * Matching logic:
 *   - Rule.dataSourceId matches the source
 *   - Rule.allowedTypes is empty (any type) OR includes entity.type
 *   - Rule.allowedStatuses is empty (any status) OR includes entity.status
 */
export async function findMatchingRules(
  sourceId: string,
  entity: SourceEntity
): Promise<RuleMatchResult[]> {
  try {
    // Load data source to get its DB id
    const dataSource = await prisma.dataSource.findFirst({
      where: { sourceId, isActive: true },
      select: { id: true },
    });

    if (!dataSource) {
      return [];
    }

    // Find all active rules for this data source
    const rules = await prisma.taskRule.findMany({
      where: {
        dataSourceId: dataSource.id,
        isActive: true,
        id: { not: "MANUAL" },
      },
      include: {
        taskType: true,
      },
    });

    const matches: RuleMatchResult[] = [];

    for (const rule of rules) {
      const allowedTypes = Array.isArray(rule.allowedTypes)
        ? (rule.allowedTypes as string[])
        : [];
      const allowedStatuses = Array.isArray(rule.allowedStatuses)
        ? (rule.allowedStatuses as string[])
        : [];

      const typeMatches = allowedTypes.length === 0 || allowedTypes.includes(entity.type);
      const statusMatches = allowedStatuses.length === 0 || allowedStatuses.includes(entity.status);

      if (typeMatches && statusMatches) {
        matches.push({
          taskRuleId: rule.id,
          ruleName: rule.name,
          priority: rule.priority,
          slaMinutes: rule.slaMinutes,
          assignmentStrategy: "round_robin", // default; extendable
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
 * Check if entity matches rule filters
 */
export function entityMatchesRuleScope(
  entity: SourceEntity,
  allowedTypes: string[],
  allowedStatuses: string[]
): boolean {
  const typeMatches = allowedTypes.length === 0 || allowedTypes.includes(entity.type);
  const statusMatches = allowedStatuses.length === 0 || allowedStatuses.includes(entity.status);
  return typeMatches && statusMatches;
}

/**
 * Get the highest priority matching rule
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
  const priorityOrder = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const sortOrder = (priority: string) =>
    priorityOrder[priority as keyof typeof priorityOrder] ?? 999;
  return matches.sort((a, b) => sortOrder(a.priority) - sortOrder(b.priority));
}
