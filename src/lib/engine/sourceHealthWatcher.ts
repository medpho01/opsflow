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

// W5 — polling_logs timestamps are now TIMESTAMPTZ (see W5 migration), so
// `lastSuccess.startedAt` arrives as a real UTC Date. The fromNaiveIst()
// shim that used to live here is gone.

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
  // Per-source attribution ONLY (July 2026 fix). The previous version used
  // the GLOBAL legacy polling_logs as a proxy for every source, which
  // produced provably false alerts the moment more than one source was
  // registered: "Requests: zero rows across 10 successful polls" quoted the
  // ORDERS poller's history against a source nothing had ever polled —
  // right next to a "No polls yet" header. A health check that can't
  // attribute its evidence must stay silent, not guess.
  //
  // data_source_polling_logs is written by the legacy poller's mirror (for
  // sourceId="orders") and by any future per-source poller. A source with
  // NO rows here has no poller wired up — that is a configuration state,
  // not a health incident; the UI already shows "No polls yet" for it.
  const recentPolls = await prisma.dataSourcePollingLog.findMany({
    where: { dataSourceId: source.id },
    take: ERROR_RATE_WINDOW,
    orderBy: { pollStartedAt: "desc" },
    select: {
      pollStartedAt: true,
      status: true,
      entitiesFound: true,
    },
  });

  if (recentPolls.length === 0) {
    return []; // never polled → nothing to alert on
  }

  const failing: ConditionResult[] = [];
  const now = new Date();

  // ── 1. STALE_POLLS ──────────────────────────────────────────────────────
  const staleAfterMinutes = STALE_MULTIPLIER * source.pollingIntervalMinutes;
  const lastSuccess = recentPolls.find((p) => p.status === "SUCCESS");
  const minutesSinceSuccess = lastSuccess
    ? Math.floor((now.getTime() - lastSuccess.pollStartedAt.getTime()) / 60_000)
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
  // Honest window: query the FULL noRowsHours window (the old version
  // sampled only the last 10 polls — ~20 minutes at a 2-min cadence —
  // while the message claimed 24h, so a quiet stretch false-alarmed on a
  // healthy source). Require a minimum number of successful polls so a
  // source that just came online doesn't trip it instantly.
  const windowStart = new Date(now.getTime() - NO_ROWS_HOURS * 60 * 60_000);
  const windowAgg = await prisma.dataSourcePollingLog.aggregate({
    where: {
      dataSourceId: source.id,
      status: "SUCCESS",
      pollStartedAt: { gte: windowStart },
    },
    _count: { _all: true },
    _sum: { entitiesFound: true },
  });
  const successCount = windowAgg._count._all;
  const rowsInWindow = windowAgg._sum.entitiesFound ?? 0;
  if (successCount >= 3 && rowsInWindow === 0) {
    failing.push({
      condition: "NO_ROWS",
      severity: "MEDIUM",
      threshold: `0 rows for ${NO_ROWS_HOURS}h`,
      observed: `${successCount} successful polls returned 0 rows`,
      message: `${source.displayName}: zero rows fetched in last ${NO_ROWS_HOURS}h across ${successCount} successful polls`,
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
