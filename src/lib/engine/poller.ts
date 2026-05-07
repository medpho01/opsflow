/**
 * OpsFlow Polling Engine
 * ──────────────────────
 * Runs on a cron schedule (default every 5 minutes).
 * 1. Fetches all active orders from labstack public schema
 * 2. Loads active TaskRules from taskos schema
 * 3. Evaluates trigger conditions → creates Tasks
 * 4. Runs SLA watcher (breach detection + warnings)
 * 5. Writes a PollingLog entry with run stats
 *
 * Start it once via startPoller() from the app server entry point.
 */
import cron from "node-cron";
import prisma from "@/lib/db/client";
import { fetchAllActiveOrders } from "./labstack";
import { evaluateAndCreateTasks, loadActiveRules, archiveObsoleteTasks } from "./taskCreator";
import { runSlaWatcher } from "./slaWatcher";
import { sendDailySummary } from "./dailySummary";

const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_MS ?? "300000", 10);
const CRON_EXPRESSION = intervalToCron(POLLING_INTERVAL_MS);

// C1.2: Database-level polling lock (prevent concurrent polling cycles)
const POLLING_LOCK_KEY = 1000;
const LOCK_TIMEOUT_MS = 60000; // 60 second lock timeout

async function acquirePollingLock(): Promise<boolean> {
  try {
    const now = new Date();
    const lockUntil = new Date(now.getTime() + LOCK_TIMEOUT_MS);

    // Try to acquire lock using upsert
    // If lock doesn't exist, create it; if exists, update only if expired
    const result = await prisma.$queryRaw<
      Array<{ acquired: boolean }>
    >`
      INSERT INTO taskos."polling_locks" ("lockKey", "lockedAt", "lockedUntil")
      VALUES (${POLLING_LOCK_KEY}, ${now}, ${lockUntil})
      ON CONFLICT ("lockKey")
      DO UPDATE SET "lockedUntil" = ${lockUntil}
      WHERE "polling_locks"."lockedUntil" < ${now}
      RETURNING TRUE as "acquired";
    `;

    return result.length > 0;
  } catch (err) {
    console.error("[Poller] Lock acquisition error:", err);
    return false;
  }
}

async function releasePollingLock(): Promise<void> {
  try {
    await prisma.$executeRaw`
      DELETE FROM taskos."polling_locks"
      WHERE "lockKey" = ${POLLING_LOCK_KEY};
    `;
  } catch (err) {
    console.error("[Poller] Lock release error:", err);
  }
}

// ── Core poll cycle ───────────────────────────────────────────────────────────

export async function runPollCycle(): Promise<void> {
  // C1.2: Use database lock instead of in-memory flag
  const lockAcquired = await acquirePollingLock();
  if (!lockAcquired) {
    console.log("[Poller] Another process holds the lock, skipping.");
    return;
  }

  const startedAt = new Date();
  let status: "SUCCESS" | "ERROR" = "SUCCESS";
  let errorMessage: string | null = null;
  let ordersFound = 0;
  let tasksCreated = 0;

  try {
    console.log(`[Poller] Cycle started at ${startedAt.toISOString()}`);

    // 1. Fetch orders from labstack
    const orders = await fetchAllActiveOrders();
    ordersFound = orders.length;
    console.log(`[Poller] ${ordersFound} active orders fetched from labstack`);

    // 2. Load active rules
    const rules = await loadActiveRules();
    console.log(`[Poller] ${rules.length} active task rules loaded`);

    // 3. Evaluate rules → create tasks
    if (orders.length > 0 && rules.length > 0) {
      const result = await evaluateAndCreateTasks(orders, rules);
      tasksCreated = result.created;
      console.log(`[Poller] Tasks created: ${result.created}, skipped: ${result.skipped}`);

      // 3b. Archive obsolete tasks (hybrid approach)
      const archived = await archiveObsoleteTasks(orders, rules);
      if (archived > 0) {
        console.log(`[Poller] Tasks archived: ${archived}`);
      }
    }

    // 4. SLA watcher
    await runSlaWatcher();
    console.log("[Poller] SLA watcher completed");
  } catch (err) {
    status = "ERROR";
    errorMessage = err instanceof Error ? err.message : String(err);
    console.error("[Poller] Cycle error:", errorMessage);
  } finally {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    try {
      await prisma.pollingLog.create({
        data: {
          startedAt,
          finishedAt,
          durationMs,
          ordersFound,
          tasksCreated,
          status,
          errorMessage,
        },
      });
    } catch (logErr) {
      console.error("[Poller] Failed to write PollingLog:", logErr);
    }

    // Always release lock
    await releasePollingLock();
    console.log(`[Poller] Cycle finished in ${durationMs}ms — status: ${status}`);
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;

let dailySummaryTask: ReturnType<typeof cron.schedule> | null = null;

export function startPoller(): void {
  if (scheduledTask) {
    console.log("[Poller] Already started.");
    return;
  }

  console.log(`[Poller] Starting with cron expression: "${CRON_EXPRESSION}" (~${POLLING_INTERVAL_MS / 60000} min)`);

  // Run once immediately on startup
  runPollCycle().catch((e) => console.error("[Poller] Initial run error:", e));

  scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
    runPollCycle().catch((e) => console.error("[Poller] Scheduled run error:", e));
  });

  // Daily summary at 20:30 IST = 15:00 UTC (cron: "0 15 * * *")
  const summaryCron = process.env.DAILY_SUMMARY_CRON ?? "0 15 * * *";
  dailySummaryTask = cron.schedule(summaryCron, () => {
    sendDailySummary().catch((e) => console.error("[DailySummary] Error:", e));
  });
  console.log(`[Poller] Daily summary cron scheduled: "${summaryCron}"`);
}

export function stopPoller(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
  if (dailySummaryTask) {
    dailySummaryTask.stop();
    dailySummaryTask = null;
  }
  console.log("[Poller] Stopped.");
}

// ── Utility: convert interval ms → cron expression ────────────────────────────

function intervalToCron(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));

  if (minutes < 60) {
    // e.g. "*/5 * * * *"
    return `*/${minutes} * * * *`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `0 */${hours} * * *`;
  }

  return "0 */6 * * *"; // fallback: every 6h
}
