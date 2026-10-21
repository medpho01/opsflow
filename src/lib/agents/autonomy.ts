/**
 * Autonomy bookkeeping (FR-13.2, decision 2 of 21 Oct): every review
 * decision is an agreement data point for the action at the lab's tier (and
 * at the lab or store itself). Promotion unlocks at ≥98% agreement over
 * ≥200 cases, at the tier; a lab or store may demote on its own, or promote
 * on its own 200.
 */
import prisma from "@/lib/db/client";
import { LEVELS, type Level } from "./guard/guard";

export const PROMOTE_MIN_RATE = 0.98;
export const PROMOTE_MIN_CASES = 200;

export async function recordDecision(input: { action: string; desk: string; labTier: string | null; labId: number | null; storeId: number | null; agreed: boolean }) {
  const scopes: Array<[string, string]> = [["ALL", "*"]];
  if (input.labTier) scopes.push(["TIER", input.labTier]);
  if (input.desk === "STORE" && input.storeId != null) scopes.push(["STORE", String(input.storeId)]);
  else if (input.labId != null) scopes.push(["LAB", String(input.labId)]);
  for (const [scopeKind, scopeKey] of scopes) {
    const row = await prisma.agentAutonomy.findUnique({ where: { action_desk_scopeKind_scopeKey: { action: input.action, desk: input.desk, scopeKind, scopeKey } } });
    const n = (row?.sampleSize ?? 0) + 1;
    const agreed = Math.round((row?.agreementRate ?? 0) * (row?.sampleSize ?? 0)) + (input.agreed ? 1 : 0);
    await prisma.agentAutonomy.upsert({
      where: { action_desk_scopeKind_scopeKey: { action: input.action, desk: input.desk, scopeKind, scopeKey } },
      update: { sampleSize: n, agreementRate: agreed / n },
      create: { action: input.action, desk: input.desk, scopeKind, scopeKey, level: row?.level ?? "SUGGEST", sampleSize: n, agreementRate: agreed / n },
    });
  }
}

export function canPromote(row: { level: string; agreementRate: number | null; sampleSize: number }): boolean {
  return row.level !== "ACT" && (row.agreementRate ?? 0) >= PROMOTE_MIN_RATE && row.sampleSize >= PROMOTE_MIN_CASES;
}

export function nextLevel(level: string): Level { return LEVELS[Math.min(LEVELS.indexOf(level as Level) + 1, LEVELS.length - 1)]; }
export function prevLevel(level: string): Level { return LEVELS[Math.max(LEVELS.indexOf(level as Level) - 1, 0)]; }
