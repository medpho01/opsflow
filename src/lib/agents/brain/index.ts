/**
 * The Brain (DESIGN.md §5): one planning agent above the order agents. It
 * never sends messages and never sits in a per-order decision.
 *
 *   monitor  every 30 min — deterministic checks; the model only when one trips
 *   nightly  21:30 — misses with causes, tomorrow's plan, the brief, the audit sample
 *   review   weekly — SOP proposals with evidence and a replay
 *
 * Built in Phase 5 (brain/monitor.ts, nightly.ts, review.ts). This entry point
 * is what the worker schedules.
 */
import { runMonitor } from "./monitor";
import { runNightly } from "./nightly";
import { runReview } from "./review";

export type BrainKind = "monitor" | "nightly" | "review";

export async function runBrain(kind: BrainKind): Promise<Record<string, number>> {
  switch (kind) {
    case "monitor": return runMonitor();
    case "nightly": return runNightly();
    case "review": return runReview();
  }
}
