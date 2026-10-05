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
  // Only the Node.js runtime starts anything. The import sits inside the check
  // so the Edge bundle never includes Node-only modules.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
