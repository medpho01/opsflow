/** The live SOP per desk, cached per minute; the baseline is seeded on first use. */
import prisma from "@/lib/db/client";
import { parseSop, resolveParams, type Desk, type SopBody, type SopContext, type SopParams } from "./schema";
import { ensureBaselineSops } from "./baseline";

export type LiveSop = { sopId: string; versionId: string; version: number; body: SopBody };

let cache: { at: number; value: Map<string, LiveSop> } | null = null;
const TTL_MS = 60_000;

export async function loadLiveSops(force = false): Promise<Map<string, LiveSop>> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  await ensureBaselineSops();
  const sops = await prisma.agentSop.findMany({ include: { versions: { where: { status: "LIVE" }, orderBy: { version: "desc" }, take: 1 } } });
  const value = new Map<string, LiveSop>();
  for (const sop of sops) {
    const v = sop.versions.find((x) => x.id === sop.currentVersionId) ?? sop.versions[0];
    if (!v) continue;
    try {
      value.set(sop.desk, { sopId: sop.id, versionId: v.id, version: v.version, body: parseSop(v.body) });
    } catch (error) {
      console.error(`[Agents] SOP ${sop.desk} v${v.version} does not parse:`, error instanceof Error ? error.message : error);
    }
  }
  cache = { at: Date.now(), value };
  return value;
}

export function invalidateSopCache() { cache = null; }

export async function liveSop(desk: Desk): Promise<LiveSop | null> {
  return (await loadLiveSops()).get(desk) ?? null;
}

export function paramsFor(sop: LiveSop | null | undefined, ctx: SopContext): SopParams | null {
  return sop ? resolveParams(sop.body, ctx) : null;
}
