/**
 * The Brain's style pass (27 Oct 2026): the wording of every message kind is
 * learned, not fixed. Nightly, for each kind in STYLE_CONTRACTS:
 *
 *   1. Score engagement over the last 14 days — the live body against the
 *      trial variant, if one is running: for labs, was there a reply in the
 *      group about those orders within 2 h; for stores, did the store stay
 *      quiet on the order for an hour (the answer settled it).
 *   2. Decide a finished trial: promote it (it becomes the live body) when it
 *      engaged clearly better, retire it otherwise. A trial finishes once both
 *      arms have enough sends.
 *   3. Where nothing is on trial and the live body has enough sends, ask the
 *      model for a challenger — short, within the contract, informed by the
 *      stats and by the wording lessons the hourly learning wrote down — and
 *      start it on half the counterparties.
 *
 * Every send is logged against its variant (agents/style), so this never
 * guesses which wording a reply was to.
 */
import { Prisma } from "@prisma/client";
import prisma from "@/lib/db/client";
import { STYLE_CONTRACTS, STYLE_KEYS, checkVariant, liveBody, invalidateStyleCache, type StyleContract } from "../style";
import { askModel } from "../llm";
import { lessonsSince } from "./learn";

const MIN = 60_000;
const DAY = 86_400_000;
const LOOKBACK_DAYS = 14;
const MIN_SENDS = Number(process.env.AGENT_STYLE_MIN_SENDS ?? 30);
const MAX_NEW_TRIALS = Number(process.env.AGENT_STYLE_MAX_TRIALS ?? 3);
const LAB_WINDOW_MIN = 120;
const STORE_WINDOW_MIN = 60;

export type ArmStats = { sends: number; engaged: number; rate: number; medianMin: number | null };
export type Decision = "promote" | "retire" | "continue";

/** Promote when the trial engaged clearly better; retire when it did not; wait while either arm is short. */
export function decide(live: ArmStats, trial: ArmStats, minSends = MIN_SENDS): Decision {
  if (live.sends < minSends || trial.sends < minSends) return "continue";
  const lift = trial.rate - live.rate;
  if (lift >= 0.03 && (trial.medianMin == null || live.medianMin == null || trial.medianMin <= live.medianMin * 1.25)) return "promote";
  return "retire";
}

async function scoreArm(contract: StyleContract, sends: Array<{ groupId: string | null; counterparty: string; orderIds: number[]; sentAt: Date }>): Promise<ArmStats> {
  const minutes: number[] = [];
  let engaged = 0;
  for (const s of sends) {
    if (contract.audience === "store") {
      // Settled: no further store message about the order within the hour.
      const nudge = await prisma.waMessage.findFirst({ where: { groupId: s.groupId ?? undefined, direction: "IN", fromMe: false, orderIds: { hasSome: s.orderIds }, ts: { gt: s.sentAt, lte: new Date(s.sentAt.getTime() + STORE_WINDOW_MIN * MIN) } }, select: { id: true } });
      if (!nudge) engaged += 1;
      continue;
    }
    const until = new Date(s.sentAt.getTime() + LAB_WINDOW_MIN * MIN);
    const reply = s.groupId
      ? await prisma.waMessage.findFirst({ where: { groupId: s.groupId, direction: "IN", fromMe: false, ts: { gt: s.sentAt, lte: until }, ...(s.orderIds.length ? { OR: [{ orderIds: { hasSome: s.orderIds } }, { replyToWaId: { not: null } }] } : {}) }, orderBy: { ts: "asc" }, select: { ts: true } })
      : null;
    const fact = !reply && s.orderIds.length ? await prisma.providerOrderFact.findFirst({ where: { orderId: { in: s.orderIds }, createdAt: { gt: s.sentAt, lte: until } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }) : null;
    const at = reply?.ts ?? fact?.createdAt ?? null;
    if (at) { engaged += 1; minutes.push((at.getTime() - s.sentAt.getTime()) / MIN); }
  }
  minutes.sort((a, b) => a - b);
  return { sends: sends.length, engaged, rate: sends.length ? engaged / sends.length : 0, medianMin: minutes.length ? Math.round(minutes[Math.floor(minutes.length / 2)]) : null };
}

/** Engagement for one key: the live arm and each trial arm, over the lookback. */
export async function styleStats(key: string, now: Date): Promise<{ live: ArmStats; trials: Array<{ id: string; stats: ArmStats }> }> {
  const contract = STYLE_CONTRACTS[key];
  const since = new Date(now.getTime() - LOOKBACK_DAYS * DAY);
  const settledBy = new Date(now.getTime() - (contract.audience === "store" ? STORE_WINDOW_MIN : LAB_WINDOW_MIN) * MIN);
  const sends = await prisma.agentMessageSend.findMany({ where: { key, sentAt: { gte: since, lte: settledBy } }, select: { variantId: true, groupId: true, counterparty: true, orderIds: true, sentAt: true }, take: 2000 });
  const live = await scoreArm(contract, sends.filter((s) => !s.variantId));
  const byTrial = new Map<string, typeof sends>();
  for (const s of sends) if (s.variantId) byTrial.set(s.variantId, [...(byTrial.get(s.variantId) ?? []), s]);
  const trials = [];
  for (const [id, rows] of byTrial) trials.push({ id, stats: await scoreArm(contract, rows) });
  return { live, trials };
}

const pct = (r: number) => `${Math.round(r * 100)}%`;

async function writeChallenger(key: string, live: string, stats: ArmStats, retired: Array<{ body: string; rationale: string | null; stats: Prisma.JsonValue | null }>, lessons: string[]): Promise<{ body: string; rationale: string } | null> {
  const c = STYLE_CONTRACTS[key];
  const system = [
    "You write WhatsApp messages for LabStack's operations team to diagnostic labs' coordinators and to pharmacy stores in India. Short, warm, plain Indian English; one idea per message; no 'Dear', no sign-off, no exclamation marks, no corporate phrasing.",
    "You are rewriting ONE message template to get more replies, faster, without losing anything it must carry. Keep every REQUIRED variable exactly as {{name}}; use only ALLOWED variables; never add a link, a promise, a threat or a discount; never mention the patient's condition.",
    "Return JSON only: {\"body\": \"...\", \"rationale\": \"one sentence on why this should engage better\"}.",
  ].join("\n");
  const user = [
    `Message kind: ${key}`, `Purpose: ${c.purpose}`, `Audience: ${c.audience}`,
    `Required variables: ${c.required.map((v) => `{{${v}}}`).join(", ")}`, `Allowed variables: ${c.allowed.map((v) => `{{${v}}}`).join(", ")}`,
    `Maximum length: ${c.maxChars} characters. WhatsApp formatting (*bold*, _italic_) is fine. Lines with only empty optional variables disappear on their own.`,
    "", "CURRENT BODY:", live, "",
    `Its engagement over ${LOOKBACK_DAYS} days: ${stats.sends} sends, ${pct(stats.rate)} ${c.audience === "store" ? "settled the store's question" : "got a reply within 2 h"}${stats.medianMin != null ? `, median reply ${stats.medianMin} min` : ""}.`,
    ...(retired.length ? ["", "VARIANTS ALREADY TRIED AND RETIRED (do not repeat them):", ...retired.slice(0, 3).map((r) => `- ${JSON.stringify(r.body)} → ${r.stats ? JSON.stringify(r.stats) : "no better"}`)] : []),
    ...(lessons.length ? ["", "WHAT THE HOURLY LEARNING NOTICED ABOUT WORDING:", ...lessons.slice(0, 8).map((l) => `- ${l}`)] : []),
    "", "Write the challenger.",
  ].join("\n");
  const r = await askModel({ purpose: "brain", system, user, maxTokens: 600 });
  if (!r) return null;
  const m = r.text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { body?: unknown; rationale?: unknown };
    if (typeof parsed.body !== "string") return null;
    return { body: parsed.body.trim(), rationale: typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 300) : "" };
  } catch { return null; }
}

export type StyleResult = { keys: number; promoted: number; retired: number; started: number; skipped: number };

export async function runStyle(now = new Date()): Promise<StyleResult> {
  const result: StyleResult = { keys: 0, promoted: 0, retired: 0, started: 0, skipped: 0 };
  const lessons = (await lessonsSince(new Date(now.getTime() - 7 * DAY)).catch(() => null))?.wrong.filter((w) => w.kind === "wording").map((w) => `${w.what}${w.fix ? ` — fix: ${w.fix}` : ""}`) ?? [];
  const run = await prisma.agentBrainRun.create({ data: { kind: "style", startedAt: now } });
  const findings: Array<Record<string, unknown>> = [];
  try {
    for (const key of STYLE_KEYS) {
      result.keys += 1;
      const stats = await styleStats(key, now);
      const open = await prisma.agentMessageVariant.findMany({ where: { key, status: "TRIAL" } });
      for (const trial of open) {
        const arm = stats.trials.find((t) => t.id === trial.id)?.stats ?? { sends: 0, engaged: 0, rate: 0, medianMin: null };
        const d = decide(stats.live, arm);
        findings.push({ key, trial: trial.id, decision: d, live: stats.live, arm });
        if (d === "continue") continue;
        const statsJson = { live: stats.live, trial: arm, decidedAt: now.toISOString() } as Prisma.InputJsonValue;
        if (d === "promote") {
          // The live body only changes if nobody edited it meanwhile (the trial was written against it).
          const current = await liveBody(key);
          if (current.body === trial.against) {
            await prisma.labCommunicationTemplate.updateMany({ where: { key, body: current.body }, data: { body: trial.body } });
            await prisma.agentMessageVariant.update({ where: { id: trial.id }, data: { status: "PROMOTED", stats: statsJson, decidedAt: now } });
            result.promoted += 1;
          } else {
            await prisma.agentMessageVariant.update({ where: { id: trial.id }, data: { status: "RETIRED", stats: statsJson, decidedAt: now, rationale: `${trial.rationale ?? ""} (live body was edited during the trial; not promoted)`.trim() } });
            result.retired += 1;
          }
        } else {
          await prisma.agentMessageVariant.update({ where: { id: trial.id }, data: { status: "RETIRED", stats: statsJson, decidedAt: now } });
          result.retired += 1;
        }
      }
      // A new challenger where nothing is on trial and the live body has a track record.
      const stillOpen = open.length > 0 && findings.some((f) => f.key === key && f.decision === "continue");
      if (stillOpen || stats.live.sends < MIN_SENDS || result.started >= MAX_NEW_TRIALS) { if (!stillOpen && stats.live.sends < MIN_SENDS) result.skipped += 1; continue; }
      const live = await liveBody(key);
      const retired = await prisma.agentMessageVariant.findMany({ where: { key, status: "RETIRED" }, orderBy: { createdAt: "desc" }, take: 3, select: { body: true, rationale: true, stats: true } });
      const draft = await writeChallenger(key, live.body, stats.live, retired, lessons);
      if (!draft) { findings.push({ key, challenger: "none (no model or unparsable)" }); continue; }
      const problem = checkVariant(key, draft.body, live.body);
      if (problem || draft.body === live.body) { findings.push({ key, challenger: "rejected", problem: problem ?? "same as live" }); await prisma.agentMessageVariant.create({ data: { key, version: (await nextVersion(key)), body: draft.body, status: "REJECTED", share: 0, author: "BRAIN", rationale: `${draft.rationale} — rejected: ${problem ?? "same as live"}`, against: live.body } }); continue; }
      await prisma.agentMessageVariant.create({ data: { key, version: await nextVersion(key), body: draft.body, status: "TRIAL", share: 0.5, author: "BRAIN", rationale: draft.rationale, against: live.body } });
      findings.push({ key, challenger: "started", body: draft.body, rationale: draft.rationale });
      result.started += 1;
    }
    invalidateStyleCache();
    await prisma.agentBrainRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), findings: { ...result, items: findings } as unknown as Prisma.InputJsonValue } });
  } catch (error) {
    await prisma.agentBrainRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), error: error instanceof Error ? error.message.slice(0, 500) : String(error) } }).catch(() => undefined);
    throw error;
  }
  return result;
}

async function nextVersion(key: string): Promise<number> {
  const last = await prisma.agentMessageVariant.findFirst({ where: { key }, orderBy: { version: "desc" }, select: { version: true } });
  return (last?.version ?? 0) + 1;
}

/** One line for the nightly brief: what the style pass did in the last day. */
export async function styleBriefLine(since: Date): Promise<string | null> {
  const rows = await prisma.agentMessageVariant.findMany({ where: { OR: [{ createdAt: { gte: since } }, { decidedAt: { gte: since } }] }, select: { key: true, status: true, stats: true, createdAt: true, decidedAt: true } });
  if (!rows.length) return null;
  const started = rows.filter((r) => r.createdAt >= since && r.status !== "REJECTED").length;
  const promoted = rows.filter((r) => r.status === "PROMOTED" && r.decidedAt && r.decidedAt >= since);
  const retired = rows.filter((r) => r.status === "RETIRED" && r.decidedAt && r.decidedAt >= since).length;
  const open = await prisma.agentMessageVariant.count({ where: { status: "TRIAL" } });
  const won = promoted.map((p) => { const s = p.stats as { live?: ArmStats; trial?: ArmStats } | null; return `${p.key}${s?.live && s?.trial ? ` ${pct(s.live.rate)}→${pct(s.trial.rate)}` : ""}`; });
  return `Message style: ${open} wording trial(s) running, ${started} started, ${promoted.length} promoted${won.length ? ` (${won.join(", ")})` : ""}, ${retired} retired.`;
}
