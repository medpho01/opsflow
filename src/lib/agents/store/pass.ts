/**
 * The Store desk pass (DESIGN.md §4.10, FR-9): every minute, read the store
 * group messages that arrived since the last pass, link each to an order,
 * classify its intent, and hand it to the order's journey as a `store_message`
 * event. The journey's step decides the outcome (answer, chase the lab, task).
 *
 * Built in Phase 3 (store/reader.ts); this pass is the entry point the worker
 * schedules from Phase 1 on.
 */
import { runStoreReader } from "./reader";
import { runCoachReader } from "../brain/coach";
import { runOpsReader } from "../ops/reader";
import { sweepThreads } from "./threads";

export type StorePassResult = { read: number; linked: number; answered: number; tasks: number; review: number; opsTaken?: number; opsDone?: number; threadsClosed?: number; threadsReminded?: number; coached?: number };

export async function runStorePass(now = new Date()): Promise<StorePassResult> {
  // Coaching first: a lesson given a moment ago applies to the messages read in this same pass.
  const coach = await runCoachReader(now).catch((e) => { console.error("[Agents] coach reader failed:", e instanceof Error ? e.message : e); return { read: 0, lessons: 0, commands: 0 }; });
  const r = await runStoreReader(now);
  // The ops group's "on it" / "done" replies move the tasks the agent posted there (27 Oct 2026).
  const ops = await runOpsReader(now).catch((e) => { console.error("[Agents] ops reader failed:", e instanceof Error ? e.message : e); return { read: 0, taken: 0, done: 0 }; });
  // Store requests are tracked until closed; the rest get reminders (threads.ts).
  const threads = await sweepThreads(now).catch((e) => { console.error("[Agents] thread sweep failed:", e instanceof Error ? e.message : e); return { open: 0, closed: 0, reminded: 0, escalated: 0 }; });
  return { ...r, opsTaken: ops.taken, opsDone: ops.done, threadsClosed: threads.closed, threadsReminded: threads.reminded, coached: coach.lessons + coach.commands };
}
