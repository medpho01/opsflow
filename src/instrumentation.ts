/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Launches:
 *   1. Legacy single-source Labstack poller (handles all SOP task rules)
 *   2. Archive scheduler (daily at 2 AM)
 *   3. SLA watcher / daily summary (if configured)
 *
 * NOTE: The multi-source polling engine is intentionally disabled — it created
 * duplicate per-source cron jobs that ran in parallel with the legacy poller,
 * tripling DB load every 15 minutes. The legacy poller already handles all
 * active task rules and data sources via the unified poll cycle.
 *
 * Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  // Only run in the Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // ── 1. Multi-source polling engine (DISABLED — duplicates legacy poller) ───
  // The multi-source engine started a separate cron per DataSource (every 15 min),
  // running the same queries as the legacy poller. Disabled to prevent 3× DB load.
  //
  // try {
  //   const { initializePollingEngine } = await import("@/lib/polling/init-polling-engine");
  //   const { startPollingSchedulers } = await import("@/lib/polling/polling-scheduler");
  //   await initializePollingEngine();
  //   await startPollingSchedulers();
  // } catch (err) {
  //   console.error("[Instrumentation] Failed to start multi-source polling engine:", err);
  // }

  // ── 2. Legacy Labstack poller ───────────────────────────────────────────────
  try {
    const { startPoller } = await import("@/lib/engine/poller");
    await startPoller();
    console.log("[Instrumentation] Legacy Labstack poller started");
  } catch (err) {
    console.error("[Instrumentation] Failed to start legacy poller:", err);
  }

  // ── 3. Archive scheduler ─────────────────────────────────────────────────────
  try {
    const { initializeArchiveScheduler } = await import(
      "@/lib/engine/archiveScheduler"
    );
    await initializeArchiveScheduler();
    console.log("[Instrumentation] Archive scheduler started (runs daily at 2 AM)");
  } catch (err) {
    console.error("[Instrumentation] Failed to start archive scheduler:", err);
  }
}
