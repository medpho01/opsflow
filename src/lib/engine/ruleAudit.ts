/**
 * Rule Audit Logging — track changes to task rules for debugging and accountability.
 *
 * IMPORTANT: this is an APPLICATION-LEVEL audit, not a DB-trigger audit. Any
 * write that bypasses the API (raw SQL, Prisma Studio, direct migration)
 * will NOT generate an audit row. We deliberately don't install a Postgres
 * trigger to mirror this because the trigger would double-log every API
 * write (one app row + one trigger row) and the dual-write pattern would
 * make `task_rule_audits.changedById` ambiguous.
 *
 * Operational rule: all rule changes go through /api/task-rules. If you
 * find yourself reaching for `psql` to fix a rule, also write a one-off
 * `logRuleAudit({ action: "UPDATE", ... })` call so the trail stays clean.
 *
 * Tracked in DOCS/audit/features/02-task-rules.md (W1.8).
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
