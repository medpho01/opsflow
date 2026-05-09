/**
 * Rule Audit Logging - Track changes to task rules for debugging and accountability
 */

import prisma from "@/lib/db/client";

export interface AuditLogEntry {
  action: "CREATE" | "UPDATE" | "DELETE" | "ACTIVATE" | "DEACTIVATE";
  ruleId: string;
  changedById?: number;
  changesSummary?: Record<string, any>;
  metadata?: Record<string, any>;
}

/**
 * Log a rule change to the audit trail.
 * Non-blocking: audit logging failure doesn't block rule operations.
 */
export async function logRuleAudit(entry: AuditLogEntry): Promise<void> {
  try {
    await prisma.taskRuleAudit.create({
      data: {
        ruleId: entry.ruleId,
        changedById: entry.changedById,
        action: entry.action,
        changesSummary: entry.changesSummary ?? undefined,
        metadata: entry.metadata ?? undefined,
      },
    });
  } catch (err) {
    console.error("[RuleAudit] Failed to log:", err);
    // Don't throw — audit logging failure shouldn't block rule operations
  }
}

/**
 * Retrieve the audit log for a specific rule.
 */
export async function getRuleAuditLog(ruleId: string, limit: number = 50) {
  return prisma.taskRuleAudit.findMany({
    where: { ruleId },
    include: { changedBy: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
