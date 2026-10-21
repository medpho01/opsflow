/**
 * The OpsFlow worker (DESIGN.md §8.1): the agent loops, out of the web app,
 * on pg-boss queues in the existing Postgres database. No new infrastructure.
 *
 *   agent.sweep     every minute — opens, wakes and closes journeys
 *   journey.wake    one job per order; singletonKey = orderId, policy "stately",
 *                   so an order is never worked twice at once (FR-1.2)
 *
 * Run: `npm run worker` (tsx). Stop with SIGINT/SIGTERM; in-flight jobs finish.
 * Today's node-cron loops in the web process keep running; they move here
 * once each has a queue of its own.
 */
import PgBoss from "pg-boss";
import { sweep } from "@/lib/agents/journey/detector";
import { wakeJourney, type WakeReason } from "@/lib/agents/journey/run";
import type { OrderSnapshot } from "@/lib/agents/journey/policy";

export const QUEUES = { sweep: "agent.sweep", wake: "journey.wake" } as const;

type WakeJob = { orderId: number; reason: WakeReason; order?: OrderSnapshot };

/** pg-boss keeps its tables in its own schema; strip Prisma's `?schema=` from the URL. */
function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url.split("?")[0];
}

export async function startWorker(): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: connectionString(), schema: process.env.PGBOSS_SCHEMA || "pgboss", max: 5 });
  boss.on("error", (error) => console.error("[Worker] pg-boss:", error instanceof Error ? error.message : error));
  await boss.start();

  await boss.createQueue(QUEUES.sweep, { name: QUEUES.sweep, policy: "singleton", retryLimit: 0, expireInSeconds: 110 });
  await boss.createQueue(QUEUES.wake, { name: QUEUES.wake, policy: "stately", retryLimit: 2, retryDelay: 5, expireInSeconds: 60 });

  const enqueueWake = async (orderId: number, reason: WakeReason, order?: OrderSnapshot) => {
    await boss.send(QUEUES.wake, { orderId, reason, order } satisfies WakeJob, { singletonKey: String(orderId) });
  };

  await boss.work<WakeJob>(QUEUES.wake, { batchSize: 1, pollingIntervalSeconds: 1 }, async (jobs) => {
    for (const job of jobs) {
      const { orderId, reason, order } = job.data;
      const snap = order ? reviveDates(order) : undefined;
      const result = await wakeJourney(orderId, reason, { order: snap });
      if (result.opened || result.events || result.actions || result.closed) {
        console.log(`[Agents] wake ${orderId} (${reason}): ${result.opened ? "opened " : ""}${result.closed ? "closed " : ""}events=${result.events} actions=${result.actions}`);
      }
    }
  });

  await boss.work(QUEUES.sweep, { batchSize: 1, pollingIntervalSeconds: 2 }, async () => {
    const started = Date.now();
    const result = await sweep(new Date(), enqueueWake);
    const ms = Date.now() - started;
    if (result.opened || result.changed || result.due || result.closedOut || result.errors) {
      console.log(`[Agents] sweep: window=${result.window} opened=${result.opened} changed=${result.changed} due=${result.due} closed=${result.closedOut} errors=${result.errors} in ${ms} ms`);
    }
  });

  await boss.schedule(QUEUES.sweep, process.env.AGENT_SWEEP_CRON || "* * * * *", {}, { tz: process.env.TIMEZONE || "Asia/Kolkata" });
  // One sweep right away, so a restart never waits a minute.
  await boss.send(QUEUES.sweep, {}, { singletonKey: "boot" });
  console.log("[Worker] started: agent.sweep every minute, journey.wake per order");
  return boss;
}

/** Dates survive the queue as ISO strings. */
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
