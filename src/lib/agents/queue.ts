/** A send-only pg-boss handle for processes that are not the worker (the web app, executors), created lazily. */
import PgBoss from "pg-boss";

let boss: Promise<PgBoss> | null = null;

export const PORTAL_QUEUES = { read: "portal.read", signin: "portal.signin", health: "portal.health" } as const;

export async function queue(): Promise<PgBoss> {
  if (!boss) {
    boss = (async () => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error("DATABASE_URL is not set");
      const b = new PgBoss({ connectionString: url.split("?")[0], schema: process.env.PGBOSS_SCHEMA || "pgboss", max: 2 });
      b.on("error", (error) => console.error("[Queue] pg-boss:", error instanceof Error ? error.message : error));
      await b.start();
      for (const name of Object.values(PORTAL_QUEUES)) await b.createQueue(name, { name, policy: "stately", retryLimit: 1, expireInSeconds: 300 }).catch(() => undefined);
      return b;
    })();
  }
  return boss;
}

export async function enqueuePortalRead(labId: number, orderId: number, labRef: string | null, journeyId: string | null): Promise<boolean> {
  try {
    const b = await queue();
    const id = await b.send(PORTAL_QUEUES.read, { labId, orderId, labRef, journeyId }, { singletonKey: `read:${orderId}`, singletonSeconds: 600 });
    return !!id;
  } catch (error) {
    console.warn("[Queue] portal.read not queued:", error instanceof Error ? error.message : error);
    return false;
  }
}

export async function enqueuePortalSignin(labId: number): Promise<boolean> {
  try { const b = await queue(); return !!(await b.send(PORTAL_QUEUES.signin, { labId }, { singletonKey: `signin:${labId}`, singletonSeconds: 60 })); }
  catch (error) { console.warn("[Queue] portal.signin not queued:", error instanceof Error ? error.message : error); return false; }
}
