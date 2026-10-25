/**
 * The OpsFlow worker (DESIGN.md §8.1): the agent loops, out of the web app,
 * on pg-boss queues in the existing Postgres database. No new infrastructure.
 *
 *   agent.sweep       every minute — opens, wakes and closes journeys
 *   journey.wake      one job per order; singletonKey = orderId, policy "stately",
 *                     so an order is never worked twice at once (FR-1.2)
 *   dispatch.urgent   every minute — asks that cannot wait go alone, at once
 *   dispatch.flush    at :00 and :30 — one combined message per lab and ask
 *   risk.batch        05:45 (today) and 19:00 (tomorrow) — every journey re-scored
 *   brain.monitor     every 30 min, 06:00–21:00; brain.nightly 21:30
 *   lab.scorecard     Monday 10:30 — last week's numbers to each lab's coordinator
 *
 * Run: `npm run worker`. Stop with SIGINT/SIGTERM; in-flight jobs finish.
 */
import PgBoss from "pg-boss";
import { sweep } from "@/lib/agents/journey/detector";
import { wakeJourney, type WakeReason } from "@/lib/agents/journey/run";
import type { OrderSnapshot } from "@/lib/agents/journey/policy";
import { flushOutbox } from "@/lib/agents/executors/dispatcher";
import { ensureBaselineSops } from "@/lib/agents/sop/baseline";
import { ensureAgentTaskTypes } from "@/lib/agents/executors/tasks";
import { verifyAgentTasks } from "@/lib/agents/executors/verify";
import { runStorePass } from "@/lib/agents/store/pass";
import { runBrain } from "@/lib/agents/brain";
import { runLabScorecards } from "@/lib/agents/brain/scorecard";

export const QUEUES = {
  sweep: "agent.sweep", wake: "journey.wake", urgent: "dispatch.urgent", flush: "dispatch.flush", risk: "risk.batch",
  verify: "tasks.verify", store: "store.pass", monitor: "brain.monitor", nightly: "brain.nightly", review: "brain.review", scorecard: "lab.scorecard",
} as const;

type WakeJob = { orderId: number; reason: WakeReason; order?: OrderSnapshot; labSilentHours?: number | null };

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url.split("?")[0];
}

const TZ = () => process.env.TIMEZONE || "Asia/Kolkata";

export async function startWorker(): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: connectionString(), schema: process.env.PGBOSS_SCHEMA || "pgboss", max: 6 });
  boss.on("error", (error) => console.error("[Worker] pg-boss:", error instanceof Error ? error.message : error));
  await boss.start();

  const seeded = await ensureBaselineSops();
  if (seeded.length) console.log(`[Worker] baseline SOPs seeded: ${seeded.join(", ")}`);
  await ensureAgentTaskTypes();

  const single = (name: string, expireInSeconds: number) => boss.createQueue(name, { name, policy: "singleton", retryLimit: 0, expireInSeconds });
  await single(QUEUES.sweep, 110);
  await boss.createQueue(QUEUES.wake, { name: QUEUES.wake, policy: "stately", retryLimit: 2, retryDelay: 5, expireInSeconds: 60 });
  await single(QUEUES.urgent, 50);
  await single(QUEUES.flush, 600);
  await single(QUEUES.risk, 1200);
  await single(QUEUES.verify, 300);
  await single(QUEUES.store, 110);
  await single(QUEUES.monitor, 600);
  await single(QUEUES.nightly, 1800);
  await single(QUEUES.review, 3600);
  await single(QUEUES.scorecard, 1200);

  const enqueueWake = async (orderId: number, reason: WakeReason, order?: OrderSnapshot, labSilentHours?: number | null) => {
    await boss.send(QUEUES.wake, { orderId, reason, order, labSilentHours } satisfies WakeJob, { singletonKey: String(orderId) });
  };

  await boss.work<WakeJob>(QUEUES.wake, { batchSize: 1, pollingIntervalSeconds: 1 }, async (jobs) => {
    for (const job of jobs) {
      const { orderId, reason, order, labSilentHours } = job.data;
      const result = await wakeJourney(orderId, reason, { order: order ? reviveDates(order) : undefined, labSilentHours });
      if (result.opened || result.events || result.actions || result.closed) {
        console.log(`[Agents] wake ${orderId} (${reason}): ${result.opened ? "opened " : ""}${result.closed ? "closed " : ""}events=${result.events} actions=${result.actions} executed=${result.executed} review=${result.review}`);
      }
    }
  });

  const log = (label: string, result: Record<string, number>, ms: number) => {
    if (Object.values(result).some((v) => v > 0)) console.log(`[Agents] ${label}: ${Object.entries(result).map(([k, v]) => `${k}=${v}`).join(" ")} in ${ms} ms`);
  };
  const timed = async (label: string, fn: () => Promise<Record<string, number>>) => { const t = Date.now(); log(label, await fn(), Date.now() - t); };

  await boss.work(QUEUES.sweep, { batchSize: 1, pollingIntervalSeconds: 2 }, async () => timed("sweep", () => sweep(new Date(), enqueueWake)));
  await boss.work<{ all?: boolean }>(QUEUES.risk, { batchSize: 1, pollingIntervalSeconds: 5 }, async () => timed("risk batch", () => sweep(new Date(), enqueueWake, { all: true, reason: "risk_batch" })));
  await boss.work(QUEUES.urgent, { batchSize: 1, pollingIntervalSeconds: 5 }, async () => timed("dispatch urgent", () => flushOutbox(new Date(), { urgentOnly: true })));
  await boss.work(QUEUES.flush, { batchSize: 1, pollingIntervalSeconds: 5 }, async () => timed("dispatch flush", () => flushOutbox(new Date())));
  await boss.work(QUEUES.verify, { batchSize: 1, pollingIntervalSeconds: 10 }, async () => timed("verify tasks", () => verifyAgentTasks(new Date())));
  await boss.work(QUEUES.store, { batchSize: 1, pollingIntervalSeconds: 2 }, async () => timed("store pass", () => runStorePass(new Date())));
  await boss.work(QUEUES.monitor, { batchSize: 1, pollingIntervalSeconds: 10 }, async () => timed("brain monitor", () => runBrain("monitor")));
  await boss.work(QUEUES.nightly, { batchSize: 1, pollingIntervalSeconds: 10 }, async () => timed("brain nightly", () => runBrain("nightly")));
  await boss.work(QUEUES.review, { batchSize: 1, pollingIntervalSeconds: 10 }, async () => timed("brain review", () => runBrain("review")));
  // Queue the cards, then flush at once: the 10:30 dispatch may already have run.
  await boss.work(QUEUES.scorecard, { batchSize: 1, pollingIntervalSeconds: 10 }, async () => timed("lab scorecards", async () => { const r = await runLabScorecards(new Date()); const f = await flushOutbox(new Date()); return { ...r, sent: f.messages }; }));

  const tz = TZ();
  await boss.schedule(QUEUES.sweep, process.env.AGENT_SWEEP_CRON || "* * * * *", {}, { tz });
  await boss.schedule(QUEUES.urgent, "* * * * *", {}, { tz });
  await boss.schedule(QUEUES.flush, process.env.AGENT_FLUSH_CRON || "0,30 * * * *", {}, { tz });
  await boss.schedule(QUEUES.risk, process.env.AGENT_RISK_CRON || "45 5,19 * * *", {}, { tz });
  await boss.schedule(QUEUES.verify, "*/5 * * * *", {}, { tz });
  await boss.schedule(QUEUES.store, "* * * * *", {}, { tz });
  await boss.schedule(QUEUES.monitor, "*/30 6-21 * * *", {}, { tz });
  await boss.schedule(QUEUES.nightly, process.env.AGENT_NIGHTLY_CRON || "30 21 * * *", {}, { tz });
  await boss.schedule(QUEUES.review, process.env.AGENT_REVIEW_CRON || "0 22 * * *", {}, { tz }); // daily (was Sunday) — 25 Oct 2026
  await boss.schedule(QUEUES.scorecard, process.env.AGENT_SCORECARD_CRON || "30 10 * * 1", {}, { tz });
  await boss.send(QUEUES.sweep, {}, { singletonKey: "boot" });
  console.log("[Worker] started: sweep, wake, dispatch, risk, verify, store pass, brain, scorecard");
  return boss;
}

function reviveDates(o: OrderSnapshot): OrderSnapshot {
  const d = (v: unknown) => (v ? new Date(v as string) : null);
  return { ...o, appointmentTime: d(o.appointmentTime), createdAt: d(o.createdAt) ?? new Date(), statusUpdatedAt: d(o.statusUpdatedAt) };
}

if (require.main === module) {
  startWorker()
    .then((boss) => {
      const stop = async () => { console.log("[Worker] stopping"); await boss.stop({ graceful: true, timeout: 30_000 }); process.exit(0); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    })
    .catch((error) => { console.error("[Worker] failed to start:", error); process.exit(1); });
}
