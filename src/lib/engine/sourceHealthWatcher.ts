/**
 * Source Health Watcher
 *
 * Evaluates the health of each active data source and emits / resolves
 * Alerts of type SOURCE_HEALTH. Runs at the end of each polling cycle.
 *
 * Health is degraded when ANY of these conditions are true:
 *   1. STALE_POLLS — no SUCCESS poll in `staleAfterMinutes` (default = 3× pollingInterval).
 *   2. NO_ROWS    — source is active and zero rows fetched in last `noRowsHours` (default 24h).
 *   3. ERROR_RATE — error rate > `maxErrorRatePercent` (default 50%) over last `errorRateWindow` polls (default 10).
 *
 * The watcher creates ONE open PENDING alert per source-condition pair and
 * resolves it (sets status=DISMISSED) when the condition clears.
 *
 * Defaults are intentionally conservative — adjust via env vars or, in a
 * future iteration, per-source columns on DataSource.
 *
 * Storage shape:
 *   alertType   = SOURCE_HEALTH
 *   entityType  = "DATA_SOURCE"
 *   entityId    = null (DataSource.id is a cuid string, not int)
 *   metadata    = { dataSourceId, sourceId, displayName, condition, threshold, observed }
 *   message     = human-readable e.g. "Diagnostics Orders has had no successful poll in 47 minutes"
 *   severity    = HIGH for STALE_POLLS / ERROR_RATE, MEDIUM for NO_ROWS
 */

import prisma from "@/lib/db/client";
import { AlertStatus, TaskPriority } from "@prisma/client";

// ── Tunables (env-overridable) ───────────────────────────────────────────────
const STALE_MULTIPLIER     = Number(process.env.SOURCE_HEALTH_STALE_MULTIPLIER ?? 3);
const NO_ROWS_HOURS        = Number(process.env.SOURCE_HEALTH_NO_ROWS_HOURS ?? 24);
const MAX_ERROR_RATE_PCT   = Number(process.env.SOURCE_HEALTH_MAX_ERROR_RATE ?? 50);
const ERROR_RATE_WINDOW    = Number(process.env.SOURCE_HEALTH_ERROR_RATE_WINDOW ?? 10);

// ── Condition codes (kept in metadata for machine-readable matching) ─────────
type Condition = "STALE_POLLS" | "NO_ROWS" | "ERROR_RATE";

interface ConditionResult {
  condition: Condition;
  message: string;
  severity: TaskPriority;
  threshold: string;
  observed: string;
}

interface SourceForHealthCheck {
  id: string;
  sourceId: string;
  displayName: string;
  pollingIntervalMinutes: number;
  isActive: boolean;
}

interface PollSummary {
  startedAt: Date;
  status: string;
  ordersFound: number;
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function runSourceHealthWatcher(): Promise<{ openedAlerts: number; resolvedAlerts: number }> {
  const sources = await prisma.dataSource.findMany({
    where: { isActive: true },
    select: {
      id: true,
      sourceId: true,
      displayName: true,
      pollingIntervalMinutes: true,
      isActive: true,
    },
  });

  let opened = 0;
  let resolved = 0;

  for (const source of sources) {
    try {
      const failingConditions = await evaluateSourceHealth(source);
      const result = await reconcileAlerts(source, failingConditions);
      opened += result.opened;
      resolved += result.resolved;
    } catch (err) {
      // One bad source must not stop the rest. Log and continue.
      console.error(`[SourceHealthWatcher] Failed to evaluate source ${source.sourceId}:`, err);
    }
  }

  if (opened || resolved) {
    console.log(`[SourceHealthWatcher] cycle complete — opened=${opened}, resolved=${resolved}`);
  }
  return { openedAlerts: opened, resolvedAlerts: resolved };
}

// ── Per-source evaluation ────────────────────────────────────────────────────

async function evaluateSourceHealth(source: SourceForHealthCheck): Promise<ConditionResult[]> {
  // The legacy poller writes to taskos.polling_logs without a sourceId, so we
  // can't cleanly attribute polls to a specific source. To keep this watcher
  // useful even with the legacy poller, we treat the *global* polling_logs
  // as a proxy when the per-source table has no rows for this source.
  //
  // When the multi-source poller comes online, this query gets swapped to
  // data_source_polling_logs scoped by sourceId.
  const recentPolls: PollSummary[] = await prisma.pollingLog.findMany({
    take: ERROR_RATE_WINDOW,
    orderBy: { startedAt: "desc" },
    select: {
      startedAt: true,
      status: true,
      ordersFound: true,
    },
  });

  const failing: ConditionResult[] = [];
  const now = new Date();

  // ── 1. STALE_POLLS ──────────────────────────────────────────────────────
  const staleAfterMinutes = STALE_MULTIPLIER * source.pollingIntervalMinutes;
  const lastSuccess = recentPolls.find((p) => p.status === "SUCCESS");
  const minutesSinceSuccess = lastSuccess
    ? Math.floor((now.getTime() - lastSuccess.startedAt.getTime()) / 60_000)
    : Number.POSITIVE_INFINITY;

  if (minutesSinceSuccess > staleAfterMinutes) {
    failing.push({
      condition: "STALE_POLLS",
      severity: "HIGH",
      threshold: `${staleAfterMinutes}m`,
      observed: lastSuccess
        ? `${minutesSinceSuccess}m since last successful poll`
        : `no successful poll on record`,
      message: lastSuccess
        ? `${source.displayName}: no successful poll in ${minutesSinceSuccess} minutes (threshold ${staleAfterMinutes}m)`
        : `${source.displayName}: no successful poll on record`,
    });
  }

  // ── 2. NO_ROWS ──────────────────────────────────────────────────────────
  // "Source is producing zero rows" — only meaningful if at least one
  // SUCCESS poll has run in the window; otherwise STALE_POLLS already covers it.
  const windowStart = new Date(now.getTime() - NO_ROWS_HOURS * 60 * 60_000);
  const successInWindow = recentPolls.filter(
    (p) => p.status === "SUCCESS" && p.startedAt >= windowStart
  );
  if (successInWindow.length > 0 && successInWindow.every((p) => p.ordersFound === 0)) {
    failing.push({
      condition: "NO_ROWS",
      severity: "MEDIUM",
      threshold: `0 rows for ${NO_ROWS_HOURS}h`,
      observed: `${successInWindow.length} successful polls returned 0 rows`,
      message: `${source.displayName}: zero rows fetched in last ${NO_ROWS_HOURS}h across ${successInWindow.length} successful polls`,
    });
  }

  // ── 3. ERROR_RATE ───────────────────────────────────────────────────────
  if (recentPolls.length >= Math.min(3, ERROR_RATE_WINDOW)) {
    const errorCount = recentPolls.filter((p) => p.status !== "SUCCESS").length;
    const errorRate = Math.round((errorCount / recentPolls.length) * 100);
    if (errorRate > MAX_ERROR_RATE_PCT) {
      failing.push({
        condition: "ERROR_RATE",
        severity: "HIGH",
        threshold: `>${MAX_ERROR_RATE_PCT}% error rate`,
        observed: `${errorRate}% (${errorCount}/${recentPolls.length})`,
        message: `${source.displayName}: poll error rate ${errorRate}% over last ${recentPolls.length} cycles (threshold ${MAX_ERROR_RATE_PCT}%)`,
      });
    }
  }

  return failing;
}

// ── Alert reconciliation ─────────────────────────────────────────────────────

async function reconcileAlerts(
  source: SourceForHealthCheck,
  failing: ConditionResult[]
): Promise<{ opened: number; resolved: number }> {
  // Find currently open SOURCE_HEALTH alerts for this source, keyed by
  // metadata.dataSourceId since Alert.entityId is Int and source ids are cuids.
  const openAlerts = await prisma.alert.findMany({
    where: {
      alertType: "SOURCE_HEALTH",
      entityType: "DATA_SOURCE",
      status: { in: [AlertStatus.PENDING, AlertStatus.SENT] },
    },
  });
  const openForThisSource = openAlerts.filter((a) => {
    const md = a.metadata as { dataSourceId?: string } | null;
    return md?.dataSourceId === source.id;
  });

  const failingByCondition = new Map<Condition, ConditionResult>();
  for (const f of failing) failingByCondition.set(f.condition, f);

  let opened = 0;
  let resolved = 0;

  // Open alerts for new failing conditions; skip ones already alerted.
  for (const [condition, fail] of failingByCondition) {
    const existing = openForThisSource.find((a) => {
      const md = a.metadata as { condition?: string } | null;
      return md?.condition === condition;
    });
    if (existing) continue; // already raised

    await prisma.alert.create({
      data: {
        alertType: "SOURCE_HEALTH",
        severity: fail.severity,
        entityType: "DATA_SOURCE",
        entityId: null, // DataSource.id is a cuid string; carried in metadata instead
        message: fail.message,
        metadata: {
          dataSourceId: source.id,
          sourceId: source.sourceId,
          displayName: source.displayName,
          condition: fail.condition,
          threshold: fail.threshold,
          observed: fail.observed,
        },
        status: AlertStatus.PENDING,
      },
    });
    opened++;
  }

  // Resolve alerts for conditions that have cleared.
  for (const alert of openForThisSource) {
    const md = alert.metadata as { condition?: string } | null;
    const condition = md?.condition as Condition | undefined;
    if (!condition || !failingByCondition.has(condition)) {
      await prisma.alert.update({
        where: { id: alert.id },
        data: {
          status: AlertStatus.DISMISSED,
          acknowledgedAt: new Date(),
        },
      });
      resolved++;
    }
  }

  return { opened, resolved };
}
