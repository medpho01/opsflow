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
import { runOpsReader } from "../ops/reader";

export type StorePassResult = { read: number; linked: number; answered: number; tasks: number; review: number; opsTaken?: number; opsDone?: number };

export async function runStorePass(now = new Date()): Promise<StorePassResult> {
  const r = await runStoreReader(now);
  // The ops group's "on it" / "done" replies move the tasks the agent posted there (27 Oct 2026).
  const ops = await runOpsReader(now).catch((e) => { console.error("[Agents] ops reader failed:", e instanceof Error ? e.message : e); return { read: 0, taken: 0, done: 0 }; });
  return { ...r, opsTaken: ops.taken, opsDone: ops.done };
}
