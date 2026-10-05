/**
 * The Node.js half of src/instrumentation.ts — everything that starts at boot.
 *
 * Kept in its own module so the Edge build never sees it: instrumentation.ts
 * imports this only inside `if (process.env.NEXT_RUNTIME === "nodejs")`, which
 * webpack can drop from the Edge bundle entirely. With the old early-return
 * guard the imports below stayed reachable, the Edge compile tried to bundle
 * `node:` modules (safeFetch's node:dns, node:net) and `next dev` failed.
 */
export async function registerNode() {

  // ── 0. Global BigInt → string serialization ─────────────────────────────────
  // Several Prisma models carry BigInt fields (e.g. Task.sourceEntityId).
  // NextResponse.json calls JSON.stringify, which throws TypeError on BigInt by
  // default. List endpoints sidestepped this by using `select` to drop the
  // BigInt fields, but single-record routes (GET/PATCH /api/tasks/[id],
  // /unarchive) returned the full record and 500'd. One toJSON shim fixes all
  // of them; routes that need numeric serialization can still call .toString()
  // explicitly.
  //
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };

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

  // ── 2b. Non-API lab communication tick ──────────────────────────────────────
  // Deliberately its own loop rather than a step in the poll cycle: reminders
  // and escalations only need primary-key lookups, so they must keep running
  // when the replica is too contended for the poller's bulk scans. Uses
  // polling-lock key 1001.
  try {
    const { startNonApiLabRunner } = await import("@/lib/non-api-labs/runner");
    await startNonApiLabRunner();
    console.log("[Instrumentation] Non-API lab communication tick started (every minute)");
  } catch (err) {
    console.error("[Instrumentation] Failed to start non-API lab tick:", err);
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
