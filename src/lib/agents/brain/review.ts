/**
 * The Brain's review cycle (FR-4.7, FR-4.8): weekly at first. It looks at
 * every lab's recent history, proposes SOP changes with evidence, replays
 * each proposal against the last two weeks, applies the ones inside the
 * bounds the SOP owners set (and tells them), and files the rest for
 * approval in the SOP library.
 *
 * Deterministic proposals first (timings from history); a model, when a key
 * is set, may add proposals from the misses' causes, still gated by replay.
 */
import prisma from "@/lib/db/client";
import { parseSop, withinBounds, changedPaths, type SopBody } from "../sop/schema";
import { loadLiveSops, invalidateSopCache } from "../sop/load";
import { replaySop } from "./replay";
import { loadDirectory } from "../directory";
import { LAB_OFFSETS } from "../journey/policy";
import { askModel } from "../llm";

type Proposal = { body: SopBody; rationale: string; evidence: Record<string, unknown> };

const MIN = 60_000;

/** Per lab: when it actually assigns phlebos, from met checkpoints in the last 30 days. */
async function phleboTimingProposals(live: SopBody): Promise<Proposal[]> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await prisma.agentCheckpoint.findMany({
    where: { name: "phlebo_assigned", status: "MET", metAt: { gte: since } },
    select: { metAt: true, journey: { select: { labId: true, consoleSnapshot: true } } },
  });
  const byLab = new Map<number, number[]>();
  for (const r of rows) {
    const labId = r.journey.labId; const slot = (r.journey.consoleSnapshot as { appointmentTime?: string } | null)?.appointmentTime;
    if (labId == null || !slot || !r.metAt) continue;
    const beforeMin = (Date.parse(slot) - r.metAt.getTime()) / MIN;
    // Marked after the slot is the console catching up (API labs), not when the lab assigned:
    // it proposed "Thyrocare assigns a median −166 min before the slot" on 25 Oct 2026.
    if (beforeMin < 0) continue;
    byLab.set(labId, [...(byLab.get(labId) ?? []), beforeMin]);
  }
  const dir = await loadDirectory();
  const proposals: Proposal[] = [];
  for (const [labId, mins] of byLab) {
    if (mins.length < 30) continue;
    const sorted = [...mins].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)];
    const current = LAB_OFFSETS[labId]?.phleboBeforeSlotMin ?? 120;
    // Ask when the lab usually has not yet assigned: 30 min before its median, clipped to the bounds.
    const proposed = Math.max(30, Math.min(180, Math.round((p50 + 30) / 15) * 15));
    if (Math.abs(proposed - current) < 30) continue;
    const body = JSON.parse(JSON.stringify(live)) as SopBody;
    body.overrides = [...body.overrides.filter((o) => o.when.labId !== labId), { when: { labId }, set: { asks: { phlebo_assigned: { intent: "PHLEBO", leadMin: Math.max(0, current - proposed), graceMin: 180, urgentWithinMin: 90, nightBefore: true } } } }];
    proposals.push({
      body, rationale: `${dir.labs.get(labId)?.labName ?? labId}: assigns phlebos a median ${Math.round(p50)} min before the slot (n=${mins.length}); ask at slot − ${proposed} min instead of − ${current}.`,
      evidence: { labId, sample: mins.length, p50BeforeSlotMin: Math.round(p50), currentMin: current, proposedMin: proposed },
    });
  }
  return proposals;
}

/** Labs that never answer the first ask but answer the reminder: shorten the rung gap. */
async function rungGapProposals(live: SopBody): Promise<Proposal[]> {
  const since = new Date(Date.now() - 14 * 86_400_000);
  const asks = await prisma.agentAction.groupBy({ by: ["action"], where: { createdAt: { gte: since }, action: { in: ["ask", "reminder", "manager_whatsapp"] }, outcome: "EXECUTED" }, _count: { _all: true } });
  const n = (a: string) => asks.find((x) => x.action === a)?._count._all ?? 0;
  if (n("ask") < 100) return [];
  const escalationRate = Math.min(1, n("reminder") / n("ask"));
  // Chasing faster is not the answer when labs do not answer the first ask (25 Oct 2026: it
  // auto-applied a 20-min gap from a "104%" rate). A high rate widens the gap instead —
  // fewer, better-timed asks — and only ever as a proposal for a person.
  if (escalationRate < 0.6 || live.params.rungGapMin >= 60) return [];
  const body = JSON.parse(JSON.stringify(live)) as SopBody;
  body.params.rungGapMin = Math.min(60, live.params.rungGapMin + 15);
  return [{ body, rationale: `${Math.round(escalationRate * 100)}% of asks needed a reminder in 14 days; a longer gap (${body.params.rungGapMin} min) gives the lab time to answer before we ask again.`, evidence: { asks: n("ask"), reminders: n("reminder"), manager: n("manager_whatsapp"), escalationRate } }];
}

async function modelProposals(live: SopBody): Promise<Proposal[]> {
  const latest = await prisma.agentBrainRun.findFirst({ where: { kind: "nightly", brief: { not: null } }, orderBy: { startedAt: "desc" }, select: { inputs: true } });
  const causes = (latest?.inputs as { causes?: Array<{ cause: string; count: number }> } | null)?.causes ?? [];
  if (!causes.length) return [];
  const answer = await askModel({
    purpose: "brain", maxTokens: 1200,
    system: "You revise an operations SOP (typed JSON) for a diagnostics ops team. Propose at most 2 small, specific parameter changes that address the top miss causes. Return ONLY JSON: {\"proposals\":[{\"path\":\"params.<key>\",\"value\":<number>,\"rationale\":\"...\"}]}. Only paths listed under bounds may be changed. Never add actions or templates.",
    user: `Current SOP params: ${JSON.stringify(live.params)}\nBounds: ${JSON.stringify(live.bounds)}\nTop miss causes this week: ${JSON.stringify(causes)}`,
  });
  if (!answer) return [];
  try {
    const parsed = JSON.parse(answer.text.slice(answer.text.indexOf("{"), answer.text.lastIndexOf("}") + 1)) as { proposals?: Array<{ path: string; value: number; rationale: string }> };
    return (parsed.proposals ?? []).filter((p) => live.bounds[p.path] && typeof p.value === "number").map((p) => {
      const body = JSON.parse(JSON.stringify(live)) as SopBody;
      const keys = p.path.split("."); let o: Record<string, unknown> = body as unknown as Record<string, unknown>;
      for (const k of keys.slice(0, -1)) o = o[k] as Record<string, unknown>;
      o[keys[keys.length - 1]] = p.value;
      return { body: parseSop(body), rationale: `Brain: ${p.rationale}`, evidence: { causes, path: p.path, value: p.value, model: answer.model } };
    });
  } catch { return []; }
}

export async function runReview(now = new Date()): Promise<Record<string, number>> {
  const run = await prisma.agentBrainRun.create({ data: { kind: "review" }, select: { id: true } });
  try {
    const sops = await loadLiveSops(true);
    const lab = sops.get("LAB");
    if (!lab) return { proposals: 0 };
    const candidates = [...await phleboTimingProposals(lab.body), ...await rungGapProposals(lab.body), ...await modelProposals(lab.body)];
    let filed = 0; let applied = 0;
    for (const c of candidates) {
      const paths = changedPaths(lab.body, c.body);
      const open = await prisma.agentSopProposal.findFirst({ where: { sopId: lab.sopId, decision: null }, select: { diff: true } });
      if (open && JSON.stringify((open.diff as { paths?: string[] }).paths) === JSON.stringify(paths)) continue;
      const replay = await replaySop(c.body, lab.body, 14, 150).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      const bounds = withinBounds(lab.body, c.body);
      const proposal = await prisma.agentSopProposal.create({
        data: { sopId: lab.sopId, baseVersionId: lab.versionId, body: c.body as object, diff: { paths, summary: c.rationale } as object, rationale: c.rationale, evidence: c.evidence as object, replay: replay as object, inBounds: bounds.inBounds },
        select: { id: true },
      });
      filed += 1;
      // More messages is never applied on its own: a shorter gap between asks, or a shorter
      // hold after an answer, always waits for a person.
      const louder = c.body.params.rungGapMin < lab.body.params.rungGapMin || c.body.params.answerHoldMin < lab.body.params.answerHoldMin;
      if (bounds.inBounds && !louder) {
        const version = await prisma.agentSopVersion.create({ data: { sopId: lab.sopId, version: lab.version + 1 + applied, body: c.body as object, author: "BRAIN", status: "LIVE", approvedAt: now, summary: c.rationale } });
        await prisma.agentSopVersion.updateMany({ where: { sopId: lab.sopId, status: "LIVE", id: { not: version.id } }, data: { status: "RETIRED" } });
        await prisma.agentSop.update({ where: { id: lab.sopId }, data: { currentVersionId: version.id } });
        await prisma.agentSopProposal.update({ where: { id: proposal.id }, data: { decision: "APPLIED", decidedAt: now, appliedVersionId: version.id } });
        applied += 1;
        invalidateSopCache();
      }
    }
    await prisma.agentBrainRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), findings: { candidates: candidates.length, filed, applied } } });
    return { candidates: candidates.length, filed, applied };
  } catch (error) {
    await prisma.agentBrainRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), error: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}
