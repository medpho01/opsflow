/**
 * Task auto-retirement
 * ─────────────────────
 * Closes open OpsFlow tasks whose source order has progressed past the
 * rule's `statusIn`. Without this, every rule that fires on a transient
 * status (e.g. R5 on SAMPLE_COLLECTED) leaves tasks orphaned in OpsFlow
 * forever — the lab work is done but the task is still "open" because
 * nothing told OpsFlow to close it.
 *
 * Observed before this fix: 260 open R5 tasks where only 42 were actually
 * still at SAMPLE_COLLECTED — the other 218 were at REPORT_DELIVERED /
 * SAMPLE_DELIVERED / etc. Smart View's "Stuck" tab ballooned to ~6×
 * reality, making the dashboard untrustworthy.
 *
 * Design choices:
 *  - Closes by setting status=CANCELLED with a TaskHistory note explaining
 *    the auto-close. CANCELLED is the only non-success terminal status the
 *    enum offers, and the history note distinguishes engine retirement
 *    from a human cancel.
 *  - Only retires tasks whose rule has a `statusIn` constraint. Rules
 *    without one (status-agnostic timers, etc.) are left alone.
 *  - Skips MANUAL tasks (taskRuleId='MANUAL') — humans own those.
 *  - Skips tasks newer than RETIRE_MIN_AGE_MS (default 10 min) — gives
 *    operators a small grace window where the task is visible even if
 *    the order has just advanced.
 *  - Bulk-fetches orderStatus from labstack (one query, IN-list of ids)
 *    instead of N round-trips.
 *
 * Returned stats are merged into the cycle's PollingLog metadata so
 * operators can see "R5 retired 218" on the dashboard.
 */
import prisma from "@/lib/db/client";
// Retirer is a poller-side housekeeping job → worker pool, isolated
// from API request slots.
import { labstackWorker as labstack } from "@/lib/db/labstack";
import { TaskStatus } from "@prisma/client";

const TERMINAL_TASK_STATUSES: TaskStatus[] = [
  TaskStatus.COMPLETED,
  TaskStatus.CANCELLED,
];

const RETIRE_MIN_AGE_MS = parseInt(
  process.env.TASK_RETIRE_MIN_AGE_MS ?? `${10 * 60_000}`,
  10
);

export interface RetirementStats {
  ruleId: string;
  ruleName: string;
  retired: number;
}

export interface RetirementResult {
  totalRetired: number;
  perRule: RetirementStats[];
}

/**
 * Scan open engine-created tasks, compare each one's source order status
 * to the originating rule's `statusIn`, and close any task whose order
 * has advanced past the rule's expected statuses.
 *
 * Safe to run every poll cycle: idempotent (no-op when nothing to retire)
 * and cheap when steady-state (one query for the open task set, one bulk
 * status query against labstack).
 */
export async function runTaskRetirer(): Promise<RetirementResult> {
  const now = new Date();
  const ageCutoff = new Date(now.getTime() - RETIRE_MIN_AGE_MS);

  // Pull open, engine-created, non-archived, sufficiently-aged tasks with
  // the originating rule's statusIn so we can compare in one pass.
  const openTasks = await prisma.task.findMany({
    where: {
      isArchived: false,
      status: { notIn: TERMINAL_TASK_STATUSES },
      taskRuleId: { not: "MANUAL" },
      entityType: "ORDER",
      createdAt: { lt: ageCutoff },
    },
    select: {
      id: true,
      entityId: true,
      taskRuleId: true,
      taskRule: {
        select: {
          id: true,
          name: true,
          triggerCondition: true,
        },
      },
    },
  });

  if (openTasks.length === 0) {
    return { totalRetired: 0, perRule: [] };
  }

  // Build a per-rule statusIn map. Rules without a statusIn constraint
  // are skipped — we can't tell whether their tasks are stale just from
  // the order's status.
  const ruleStatusInById = new Map<string, Set<string>>();
  for (const t of openTasks) {
    const ruleId = t.taskRule.id;
    if (ruleStatusInById.has(ruleId)) continue;
    const cond = (t.taskRule.triggerCondition ?? {}) as Record<string, unknown>;
    const statusIn = Array.isArray(cond.statusIn)
      ? cond.statusIn.filter((s): s is string => typeof s === "string")
      : null;
    if (statusIn && statusIn.length > 0) {
      ruleStatusInById.set(ruleId, new Set(statusIn));
    } else {
      // Mark as "no constraint" so we skip its tasks without re-parsing.
      ruleStatusInById.set(ruleId, new Set());
    }
  }

  // Filter to tasks whose rule has a usable statusIn.
  const candidateTasks = openTasks.filter(
    (t) => (ruleStatusInById.get(t.taskRule.id)?.size ?? 0) > 0
  );

  if (candidateTasks.length === 0) {
    return { totalRetired: 0, perRule: [] };
  }

  // Bulk-fetch current order status from labstack. One query, regardless
  // of task count, scoped to the IN-list of order ids we actually care
  // about. Casts orderStatus to text so we don't have to bind the custom
  // OrderStatus enum from a JS string.
  const orderIds = Array.from(
    new Set(candidateTasks.map((t) => t.entityId).filter((id): id is number => id != null))
  );
  if (orderIds.length === 0) {
    return { totalRetired: 0, perRule: [] };
  }

  type OrderStatusRow = { id: number; status: string };
  const statusRows = await labstack.$queryRawUnsafe<OrderStatusRow[]>(
    `SELECT id, "orderStatus"::text AS status FROM public."Order" WHERE id = ANY($1::int[])`,
    orderIds
  );
  const currentStatusById = new Map<number, string>();
  statusRows.forEach((r) => currentStatusById.set(r.id, r.status));

  // Decide which tasks to retire: rule has statusIn AND current order
  // status is NOT in it. Tasks whose order has been deleted from labstack
  // also retire (defensive — keeps the queue clean).
  const toRetire: { id: number; ruleId: string; ruleName: string; oldStatus: string }[] = [];
  for (const t of candidateTasks) {
    const statusIn = ruleStatusInById.get(t.taskRule.id);
    if (!statusIn || statusIn.size === 0) continue;
    const current = currentStatusById.get(t.entityId) ?? "<order-not-found>";
    if (!statusIn.has(current)) {
      toRetire.push({
        id: t.id,
        ruleId: t.taskRule.id,
        ruleName: t.taskRule.name,
        oldStatus: current,
      });
    }
  }

  if (toRetire.length === 0) {
    return { totalRetired: 0, perRule: [] };
  }

  // Retire in a single transaction so the count and the history rows stay
  // consistent. Update + history insert per task — Prisma doesn't bulk-
  // insert relations, so we batch but iterate. 218 rows is fine; if this
  // ever needs to retire 10K+ at once, a CTE-based raw query would scale
  // better.
  const idsToRetire = toRetire.map((x) => x.id);
  await prisma.$transaction(async (tx) => {
    await tx.task.updateMany({
      where: { id: { in: idsToRetire } },
      data: {
        status: TaskStatus.CANCELLED,
        completedAt: now,
        lastStatusUpdate: now,
      },
    });
    // Stamp metadata.autoRetiredByEngine=true via raw SQL so the UI can
    // distinguish engine cancellations from human ones (Smart View splits
    // "Done today" into team-completed vs auto-closed). One statement for
    // the whole batch; jsonb_set merges into existing metadata, defaulting
    // to '{}' for tasks that had no metadata.
    await tx.$executeRawUnsafe(
      `UPDATE taskos."tasks"
         SET metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{autoRetiredByEngine}',
           'true'::jsonb
         )
       WHERE id = ANY($1::int[])`,
      idsToRetire
    );
    await tx.taskHistory.createMany({
      data: toRetire.map((t) => ({
        taskId: t.id,
        status: TaskStatus.CANCELLED,
        changedById: null, // engine, not a user
        note: `Auto-closed by engine — source order advanced to ${t.oldStatus} (out of rule's statusIn)`,
      })),
    });
  });

  // Per-rule breakdown for PollingLog metadata.
  const perRuleMap = new Map<string, RetirementStats>();
  for (const t of toRetire) {
    const existing = perRuleMap.get(t.ruleId);
    if (existing) {
      existing.retired++;
    } else {
      perRuleMap.set(t.ruleId, {
        ruleId: t.ruleId,
        ruleName: t.ruleName,
        retired: 1,
      });
    }
  }

  return {
    totalRetired: toRetire.length,
    perRule: Array.from(perRuleMap.values()),
  };
}
