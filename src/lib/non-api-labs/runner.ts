/**
 * The provider-communication tick — every minute, independent of the 5-minute
 * LabStack poll cycle (whose replica probe must not silence lab messages).
 *
 * Three steps, in this order, under one lock:
 *   1. poll answers   — a tap is applied before anything else is decided;
 *   2. lab replies    — what labs wrote, read as facts on their orders, so a
 *                       reply that answers a question stops it repeating;
 *   3. message rules  — every lab communication: new orders, reminders,
 *                       checks, chasers and the daily summaries
 *                       (lib/provider-rules).
 *
 * Lock key 1001 is separate from the poller's 1000, so the two loops never
 * block each other.
 */
import { acquireLock, releaseLock, NON_API_LAB_LOCK_KEY } from "@/lib/engine/pollingLock";
import { processPollVotes } from "./poll-votes";
import { runMessageRulesPass } from "@/lib/provider-rules/engine";
import { runReplyPass } from "@/lib/provider-rules/replies";

const TICK_CRON = process.env.NON_API_LAB_TICK_CRON ?? "* * * * *";
// Short TTL: a tick is seconds of work, and a dead process should not hold the
// lock for long. Still comfortably longer than a slow batch.
const TICK_LOCK_TTL_MS = parseInt(process.env.NON_API_LAB_LOCK_TTL_MS ?? "120000", 10);

export async function runNonApiLabTick(now = new Date()): Promise<void> {
  const acquired = await acquireLock(NON_API_LAB_LOCK_KEY, TICK_LOCK_TTL_MS, "NonApiLabTick");
  if (!acquired) return;
  try {
    try {
      const votes = await processPollVotes();
      if (votes.applied || votes.reasonsAttached || votes.skipped || votes.failed) {
        console.log(`[PollVotes] applied=${votes.applied} reasons=${votes.reasonsAttached} skipped=${votes.skipped} failed=${votes.failed}`);
      }
    } catch (error) {
      console.error("[PollVotes] Cycle error:", error);
    }

    try {
      const replies = await runReplyPass(now);
      if (replies.read) console.log(`[Replies] read=${replies.read} attributed=${replies.attributed} facts=${replies.facts}`);
    } catch (error) {
      console.error("[Replies] Cycle error:", error);
    }

    try {
      const pass = await runMessageRulesPass(now);
      if (pass.sent || pass.summaries || pass.missed || pass.failed || pass.confirmed || pass.skipped) {
        console.log(
          `[MessageRules] orders=${pass.orders} sent=${pass.sent} summaries=${pass.summaries} missed=${pass.missed} ` +
          `skipped=${pass.skipped} confirmed=${pass.confirmed} failed=${pass.failed}`,
        );
      }
    } catch (error) {
      console.error("[MessageRules] Cycle error:", error);
    }
  } finally {
    await releaseLock(NON_API_LAB_LOCK_KEY, "NonApiLabTick");
  }
}

let scheduledTask: { stop: () => void } | null = null;

export async function startNonApiLabRunner(): Promise<void> {
  if (scheduledTask) {
    console.log("[NonApiLabTick] Already started.");
    return;
  }

  // Dynamic import with webpackIgnore: node-cron v4 reaches for node:crypto /
  // path / url, which this project's webpack config will not bundle.
  const cron = (await import(/* webpackIgnore: true */ "node-cron")).default;
  scheduledTask = cron.schedule(TICK_CRON, () => {
    runNonApiLabTick().catch((error) => console.error("[NonApiLabTick] Scheduled run error:", error));
  });
  console.log(`[NonApiLabTick] Started with cron expression: "${TICK_CRON}"`);
}

export function stopNonApiLabRunner(): void {
  if (!scheduledTask) return;
  scheduledTask.stop();
  scheduledTask = null;
  console.log("[NonApiLabTick] Stopped.");
}
