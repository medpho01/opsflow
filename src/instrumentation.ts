/**
 * Next.js instrumentation hook — runs once when the server starts.
 * We use it to launch the OpsFlow polling engine and archive scheduler
 * so they run in the same Node.js process as the Next.js server.
 *
 * Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  // Only run in Node.js runtime (not in Edge runtime)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { startPoller } = await import("@/lib/engine/poller");
      startPoller();

      // Initialize archive scheduler (runs daily at 2 AM)
      const { initializeArchiveScheduler } = await import("@/lib/engine/archiveScheduler");
      initializeArchiveScheduler();
      console.log("[ArchiveScheduler] Initialized - archive runs daily at 2 AM");
    } catch (err) {
      console.error("[Instrumentation] Failed to start poller/archiveScheduler:", err);
      // Don't crash the server if poller fails to start
    }
  }
}
