/**
 * The store desk grades itself (28 Oct 2026). For every store question the
 * desk, live or in shadow, drafts its reply; the team's own reply in the group
 * is kept beside it; a judge compares the two. Per kind of question (status,
 * report, reschedule, …) that gives a readiness score, and the desk can be
 * switched live for the kinds it is good at while the rest is handed to a
 * person in the group. No guesswork: the score is on Agents › Desks.
 *
 *   evaluateStore(storeId, since)   one row per question (agent_shadow_evals)
 *   scoreStore(storeId, days)       per-kind scores from those rows → desk state
 *   runReadiness(now)               nightly, every store with a group
 */
import { Prisma } from "@prisma/client";
import prisma from "@/lib/db/client";
import { fetchOrderSnapshots } from "../journey/window";
import { renderStoreText } from "../executors/storeReply";
import { isAutomated, loadTeam, makeTeamMatcher } from "@/lib/wa/team";
import { resolveMentionNames } from "@/lib/wa/mentionNames";
import { addressedToPerson, STORE_ACK_RE } from "./scope";
import { askModel } from "../llm";
import type { ProposedAction } from "../journey/step";

const MIN = 60_000;
const DAY = 86_400_000;
const STORE_ACTIONS = ["store_reply", "store_alert", "store_warning", "ack", "create_task", "store_handoff"];
export const STORE_INTENTS = ["status", "report", "slot", "reschedule", "cancel", "change_tests", "new_booking", "serviceability", "complaint", "other"] as const;
export type StoreIntent = (typeof STORE_INTENTS)[number];
export const INTENT_LABEL: Record<string, string> = { status: "status", report: "report", slot: "slots", reschedule: "reschedule", cancel: "cancel", change_tests: "change tests", new_booking: "new booking", serviceability: "serviceability", complaint: "complaint", other: "other" };

export type Verdict = "SAME" | "COMPATIBLE" | "CONTRADICTS" | "UNRELATED" | "BOT_ONLY" | "MISSED" | "NEITHER" | "WRONG_LINK" | "WOULD_FAIL" | "UNWANTED" | "UNJUDGED";

/**
 * The bot should have stayed quiet (28 Oct 2026): the question was for a named person, or the bot
 * only said "on it" while a team member answered within two minutes either side. Counts as wrong —
 * the first live afternoon's facts were right and its timing was the whole problem.
 */
export function unwanted(input: { forPerson: boolean; draft: string | null; botAt: Date | null; teamAt: Date | null }): boolean {
  if (!input.draft || input.draft.startsWith("[")) return false;
  if (input.forPerson) return true;
  return !!(input.botAt && input.teamAt && Math.abs(input.botAt.getTime() - input.teamAt.getTime()) <= 2 * MIN && STORE_ACK_RE.test(input.draft));
}

const one = (s: string, n = 300) => s.replace(/\s+/g, " ").trim().slice(0, n);
const written = (text: string) => [...new Set((text.match(/(?<![\d@+])\d{5,6}(?!\d)/g) ?? []).map(Number))];

/** One row per store question in the window: the draft, the team's reply, the verdict. */
export async function evaluateStore(storeId: number, since: Date, until = new Date(), opts: { judge?: boolean } = { judge: true }): Promise<{ questions: number; judged: number }> {
  const groups = await prisma.waGroup.findMany({ where: { role: "SUPPORT", storeId }, select: { id: true } });
  if (!groups.length) return { questions: 0, judged: 0 };
  const teamRoster = await loadTeam();
  const isTeam = makeTeamMatcher(teamRoster);
  const msgs = await prisma.waMessage.findMany({
    where: { groupId: { in: groups.map((g) => g.id) }, ts: { gte: since, lte: until } }, orderBy: { ts: "asc" },
    select: { id: true, waMsgId: true, ts: true, fromMe: true, sender: true, senderJid: true, text: true, intent: true, replyToWaId: true },
  });
  const byWaId = new Map(msgs.map((m) => [m.waMsgId, m]));
  const team = msgs.filter((m) => !isAutomated(m) && (m.fromMe || !!isTeam(m.sender, m.senderJid)) && m.text?.trim());
  const questions = msgs.filter((m) => !m.fromMe && !isTeam(m.sender, m.senderJid) && !isAutomated(m) && m.intent?.startsWith("STORE_") && m.intent !== "STORE_NOISE" && m.text?.trim());
  if (!questions.length) return { questions: 0, judged: 0 };
  const mentionNames = await resolveMentionNames(questions.map((q) => q.text), { team: teamRoster }).catch(() => ({} as Record<string, string>));
  const ourWaIds = new Set((await prisma.waOutbound.findMany({ where: { groupId: { in: groups.map((g) => g.id) }, createdAt: { gte: new Date(since.getTime() - 7 * DAY) }, sentWaMsgId: { not: null } }, select: { sentWaMsgId: true } })).map((o) => o.sentWaMsgId!));

  const events = await prisma.agentJourneyEvent.findMany({ where: { kind: "store_message", at: { gte: since } }, select: { payload: true, journey: { select: { orderId: true } } } });
  const linked = new Map<string, number[]>();
  for (const e of events) { const pl = e.payload as { messageId?: string }; if (pl?.messageId) linked.set(pl.messageId, [...(linked.get(pl.messageId) ?? []), e.journey.orderId]); }
  const actions = await prisma.agentAction.findMany({
    where: { createdAt: { gte: since }, desk: "STORE", action: { in: STORE_ACTIONS } }, orderBy: { createdAt: "asc" },
    select: { id: true, orderId: true, action: true, params: true, reason: true, outcome: true, createdAt: true, idemKey: true },
  });
  const asked = new Set((await prisma.agentOutboxItem.findMany({ where: { counterparty: `STORE:${storeId}`, idemKey: { startsWith: "askid:" }, createdAt: { gte: since } }, select: { idemKey: true } })).map((o) => o.idemKey.slice(6)));
  const snaps = await fetchOrderSnapshots([...new Set(actions.map((a) => a.orderId).filter((x): x is number => x != null))]).catch(() => new Map());
  const mine = actions.filter((a) => ((a.params as { storeId?: number | null })?.storeId ?? (a.orderId != null ? snaps.get(a.orderId)?.storeId : null)) === storeId);

  let judged = 0;
  const used = new Set<string>();
  for (const q of questions) {
    const intent = (q.intent ?? "STORE_OTHER").replace("STORE_", "").toLowerCase();
    const ids = written(q.text);
    const bot = mine.filter((a) => !used.has(a.id) && ((a.idemKey ?? "").includes(q.id) || (a.idemKey ?? "").includes(q.waMsgId) || (a.params as { quotedWaId?: string })?.quotedWaId === q.waMsgId));
    bot.forEach((a) => used.add(a.id));
    // The team's reply to THIS question: quoting it, naming its order, or — naming no other order —
    // within 15 minutes (28 Oct 2026: one "ignore the appointment" message was paired with three questions).
    const reply = team.find((m) => m.ts > q.ts && m.ts.getTime() - q.ts.getTime() <= 60 * MIN && (
      m.replyToWaId === q.waMsgId || written(m.text).some((x) => ids.includes(x)) || (m.ts.getTime() - q.ts.getTime() <= 15 * MIN && !written(m.text).some((x) => !ids.includes(x)))));
    const links = linked.get(q.id) ?? [];
    const wrongLink = ids.length > 0 && links.some((l) => !ids.includes(l));
    let draft: string | null = null; let wouldFail = false;
    const first = bot[0];
    if (first) {
      const o = first.orderId != null ? snaps.get(first.orderId) : undefined;
      if (first.action === "create_task") draft = `[task] ${one(String((first.params as { action?: string }).action ?? first.reason))}`;
      else if (first.action === "store_handoff") draft = `[handoff] ${one(first.reason)}`;
      else {
        try { draft = one(await renderStoreText({ desk: "STORE", action: first.action, params: first.params as Record<string, unknown>, reason: first.reason, idemKey: first.idemKey ?? "" } as unknown as ProposedAction, { orderId: first.orderId ?? 0, labName: o?.labName ?? null, appointmentTime: o?.appointmentTime ?? null, patientName: o?.patientName ?? null })); }
        catch (e) { wouldFail = true; draft = `(would fail: ${e instanceof Error ? e.message : e})`; }
      }
    } else if (asked.has(q.id)) draft = "[asks which order]";
    const mentionOnly = !q.text.replace(/@\d{6,}/g, "").replace(/[\s⁨⁩]/g, "").length;
    if (mentionOnly) continue;   // a bare @mention asks nothing; not a question to grade
    // For a named person, or a reply to a person's message: not ours to answer. Silence is right
    // and is not graded; an answer is UNWANTED.
    const quotedMsg = q.replyToWaId ? byWaId.get(q.replyToWaId) : undefined;
    const forPerson = !!addressedToPerson(q.text, mentionNames, isTeam) || (!!quotedMsg && !ourWaIds.has(q.replyToWaId!) && (quotedMsg.fromMe || !!isTeam(quotedMsg.sender, quotedMsg.senderJid)));
    if (forPerson && !draft) continue;
    let verdict: Verdict = wrongLink ? "WRONG_LINK" : wouldFail ? "WOULD_FAIL" : unwanted({ forPerson, draft, botAt: first?.createdAt ?? null, teamAt: reply?.ts ?? null }) ? "UNWANTED" : draft && reply ? "UNJUDGED" : draft ? "BOT_ONLY" : reply ? "MISSED" : "NEITHER";
    let note: string | null = null;
    if (verdict === "UNJUDGED" && opts.judge !== false && draft && reply && !draft.startsWith("[")) {
      const j = await judge(q.text, draft, reply.text).catch(() => null);
      if (j) { verdict = j.verdict; note = j.note; judged += 1; }
    }
    const data = {
      storeId, messageId: q.id, intent, orderId: links[0] ?? ids[0] ?? null, at: q.ts, question: one(q.text, 400),
      botDraft: draft, botAt: first?.createdAt ?? (asked.has(q.id) ? q.ts : null), teamReply: reply ? one(reply.text, 400) : null, teamAt: reply?.ts ?? null, verdict, note,
    };
    await prisma.agentShadowEval.upsert({ where: { messageId: q.id }, update: data, create: data }).catch(() => undefined);
  }
  return { questions: questions.length, judged };
}

async function judge(question: string, draft: string, teamReply: string): Promise<{ verdict: Verdict; note: string } | null> {
  const r = await askModel({
    purpose: "audit", maxTokens: 200, redactUser: true,
    system: [
      "You compare two replies to a pharmacy store's WhatsApp question about a lab order: the bot's draft and what the human team actually replied. Judge ONLY whether the bot stated a fact the team's reply shows to be false.",
      "Return JSON: {\"verdict\": \"SAME\" | \"COMPATIBLE\" | \"CONTRADICTS\" | \"UNRELATED\", \"note\": \"one short sentence\"}.",
      "SAME: the same answer. COMPATIBLE: no conflict — different words, more detail, a later step; the bot saying 'checking with the lab', 'noted, we'll confirm' or 'raising it with the team' while the team gives the answer is ALWAYS compatible; the bot stating the console's status while the team adds what happens next is compatible.",
      "CONTRADICTS: only when the bot asserted a fact — collected / not collected, delivered / not delivered, a time, a phlebo name — that the team's reply shows was wrong at that moment.",
      "UNRELATED: the team's reply is about a different order or a different matter (a different order id, a consult, a new booking), or is itself a question or an instruction to someone else — it does not answer this question.",
    ].join("\n"),
    user: `STORE ASKED: ${question}\n\nBOT DRAFT: ${draft}\n\nTEAM REPLIED: ${teamReply}`,
  });
  if (!r) return null;
  const m = r.text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const p = JSON.parse(m[0]) as { verdict?: string; note?: string };
    const v = p.verdict === "SAME" || p.verdict === "COMPATIBLE" || p.verdict === "CONTRADICTS" || p.verdict === "UNRELATED" ? p.verdict : null;
    return v ? { verdict: v, note: String(p.note ?? "").slice(0, 200) } : null;
  } catch { return null; }
}

export type IntentScore = { intent: string; n: number; covered: number; bad: number; contradicts: number; wrongLinks: number; wouldFail: number; unwanted: number; missed: number; botFirst: number; both: number; score: number | null; ready: boolean };
export type Readiness = { days: number; at: string; n: number; score: number | null; intents: IntentScore[]; recommended: string[] };

/** The score from the rows: coverage (did the bot have a reply) and correctness (nothing wrong among its replies). */
export function scoreRows(rows: Array<{ intent: string; verdict: string; botAt: Date | null; teamAt: Date | null; at: Date }>, days: number, now = new Date()): Readiness {
  const byIntent = new Map<string, typeof rows>();
  for (const r of rows) byIntent.set(r.intent, [...(byIntent.get(r.intent) ?? []), r]);
  const recent = new Date(now.getTime() - 3 * DAY);
  const intents: IntentScore[] = [];
  for (const intent of [...new Set([...STORE_INTENTS, ...byIntent.keys()])]) {
    const rs = byIntent.get(intent) ?? [];
    const n = rs.length;
    const covered = rs.filter((r) => !["MISSED", "NEITHER"].includes(r.verdict)).length;   // UNRELATED: the bot answered; the team's message was about something else
    const contradicts = rs.filter((r) => r.verdict === "CONTRADICTS").length;
    const wrongLinks = rs.filter((r) => r.verdict === "WRONG_LINK").length;
    const wouldFail = rs.filter((r) => r.verdict === "WOULD_FAIL").length;
    const unwantedN = rs.filter((r) => r.verdict === "UNWANTED").length;
    const bad = contradicts + wrongLinks + wouldFail + unwantedN;
    const missed = rs.filter((r) => r.verdict === "MISSED").length;
    const both = rs.filter((r) => r.botAt && r.teamAt).length;
    const botFirst = rs.filter((r) => r.botAt && r.teamAt && r.botAt <= r.teamAt).length;
    const score = n >= 5 ? Math.round(100 * (0.4 * (covered / n) + 0.6 * (1 - bad / Math.max(covered, 1)))) : null;
    const recentBad = rs.filter((r) => r.at >= recent && ["CONTRADICTS", "WRONG_LINK", "WOULD_FAIL", "UNWANTED"].includes(r.verdict)).length;
    intents.push({ intent, n, covered, bad, contradicts, wrongLinks, wouldFail, unwanted: unwantedN, missed, botFirst, both, score, ready: score != null && score >= 85 && n >= 15 && recentBad === 0 });
  }
  const scored = intents.filter((i) => i.score != null);
  const total = scored.reduce((s, i) => s + i.n, 0);
  const overall = total ? Math.round(scored.reduce((s, i) => s + i.score! * i.n, 0) / total) : null;
  return { days, at: now.toISOString(), n: rows.length, score: overall, intents: intents.filter((i) => i.n > 0 || (STORE_INTENTS as readonly string[]).includes(i.intent)), recommended: intents.filter((i) => i.ready).map((i) => i.intent) };
}

/** Score a store over the last `days` and write it to its desk row. */
export async function scoreStore(storeId: number, days = 7, now = new Date()): Promise<Readiness> {
  const rows = await prisma.agentShadowEval.findMany({ where: { storeId, at: { gte: new Date(now.getTime() - days * DAY) } }, select: { intent: true, verdict: true, botAt: true, teamAt: true, at: true } });
  const readiness = scoreRows(rows, days, now);
  const where = { desk_scopeKind_scopeId: { desk: "STORE", scopeKind: "STORE", scopeId: storeId } };
  await prisma.agentDeskState.upsert({ where, update: { readiness: readiness as unknown as Prisma.InputJsonValue, readinessAt: now }, create: { desk: "STORE", scopeKind: "STORE", scopeId: storeId, state: "OFF", readiness: readiness as unknown as Prisma.InputJsonValue, readinessAt: now } }).catch(() => undefined);
  return readiness;
}

/** Nightly: every store with a group — evaluate the last day (judging what both answered), then score the last week. */
export async function runReadiness(now = new Date(), opts: { storeId?: number; hours?: number; scoreDays?: number } = {}): Promise<Record<string, number>> {
  const result = { stores: 0, questions: 0, judged: 0 };
  const groups = await prisma.waGroup.findMany({ where: { role: "SUPPORT", storeId: opts.storeId ?? { not: null }, archivedAt: null }, select: { storeId: true }, distinct: ["storeId"] });
  for (const g of groups) {
    if (g.storeId == null) continue;
    const r = await evaluateStore(g.storeId, new Date(now.getTime() - (opts.hours ?? 26) * 3_600_000), now).catch((e) => { console.warn(`[Readiness] store ${g.storeId}:`, e instanceof Error ? e.message : e); return null; });
    if (!r) continue;
    await scoreStore(g.storeId, opts.scoreDays ?? 7, now);
    result.stores += 1; result.questions += r.questions; result.judged += r.judged;
  }
  return result;
}
