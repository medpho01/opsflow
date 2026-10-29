/**
 * Coaching from WhatsApp (28 Oct 2026). A team member marked "coach" on
 * Connections › Team can correct the agent where the work happens, and the
 * agent takes it on at once — no deploy, no nightly wait:
 *
 *   - reply to one of the agent's messages, in any connected group:
 *       "this was for Sushma, not you"   "too long — just the id and the time"
 *   - or, in the internal ops group, a line starting with "bot:" / "bot," / "agent:":
 *       "bot: never say 'chasing' to Plum unless the lab group is live"
 *       "bot: pause store plum"   "bot: resume lab star"
 *
 * What happens, within the next store pass (seconds):
 *   1. the words become a lesson (the Brain reads them with the message they
 *      were about: kind, one-line rule, scope — this store, this lab, or all);
 *   2. the rule is read into every model prompt from then on — the reader that
 *      classifies store and lab messages, the judge that grades the desk, the
 *      Brain that rewrites wording — ahead of everything else it is told;
 *   3. if the message replied to used a trial wording, that wording is retired now;
 *   4. pause / resume commands flip the kill switches;
 *   5. the coach hears "Noted" in the internal group, with the rule as understood.
 *
 * The weekly review counts coaching as causes, so recurring lessons become SOP
 * proposals; `scripts/coaching.ts` lists and retires them. Nobody's number is
 * in code: coaching rights are a flag on the roster.
 */
import prisma from "@/lib/db/client";
import { askModel } from "../llm";
import { loadTeam, makeTeamMatcher, type TeamContact } from "@/lib/wa/team";
import { opsGroup } from "../ops/group";
import { postToOps } from "../ops/post";
import { sendWhatsApp } from "../executors/dispatcher";

const FIRST_RUN_LOOKBACK_MS = 30 * 60_000;
const last10 = (s: string | null | undefined) => (s || "").replace(/\D/g, "").slice(-10);

export const COACH_PREFIX_RE = /^\s*@?(bot|agent|coach)\s*[:,\-–—]\s*/i;
export const COMMAND_RE = /^\s*(pause|stop|resume|start|unpause)\s+(all|everything|store|lab)\s*(.*?)\s*$/i;
export const RENAME_RE = /^\s*(?:hey[,!]?\s*)?(?:your (?:name|number) is|call yourself|you are called|we(?:'ll| will) call you|name\s*[:=])\s*([A-Za-z][A-Za-z .'-]{0,23})\s*[.!]?\s*$/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "Asha: …", "@Asha …", "hey Asha, …" — the agent answers to its name as well as to "bot:". */
export function coachPrefixRe(agentName: string | null): RegExp {
  const names = ["bot", "agent", "coach", ...(agentName?.trim() ? [escapeRe(agentName.trim())] : [])].join("|");
  return new RegExp(`^\\s*(?:(?:hey|hi|hello)\\s+)?@?(?:${names})\\s*[:,\\-–—]?\\s+`, "i");
}

export type CoachLesson = {
  kind: "wording" | "timing" | "linking" | "rule" | "handover" | "repeat" | "missed" | "scope" | "praise";
  rule: string;
  applies: Array<"reader" | "judge" | "wording" | "handoff" | "digest" | "lab" | "store">;
  retireWording: boolean;
};

export type CoachCommand = { verb: "pause" | "resume"; target: "all" | "store" | "lab"; name: string } | { verb: "rename"; target: "self"; name: string };

/** "pause store plum" → { pause, store, "plum" }; "your name is Asha" → rename; null when the text is not a command. */
export function parseCommand(text: string, agentName: string | null = null): CoachCommand | null {
  const words = text.replace(coachPrefixRe(agentName), "");
  const r = RENAME_RE.exec(words);
  if (r) return { verb: "rename", target: "self", name: r[1].trim().replace(/\s+/g, " ") };
  const m = COMMAND_RE.exec(words);
  if (!m) return null;
  const verb = /^(pause|stop)$/i.test(m[1]) ? "pause" : "resume";
  const target = /^(all|everything)$/i.test(m[2]) ? "all" : (m[2].toLowerCase() as "store" | "lab");
  return { verb, target, name: m[3].trim() };
}

type Contact = TeamContact & { coach: boolean };

/** The coaches on the roster, and a matcher: a message's sender and jid → the coach it came from. */
export async function coachMatcher(): Promise<(sender: string, senderJid: string | null) => Contact | null> {
  const team = (await prisma.waContact.findMany({ where: { active: true, coach: true }, select: { id: true, name: true, phone: true, aliases: true, team: true, coach: true } })) as Contact[];
  if (!team.length) return () => null;
  const byPhone = new Map(team.filter((c) => last10(c.phone).length >= 10).map((c) => [last10(c.phone), c]));
  const byName = makeTeamMatcher(team);
  return (sender, senderJid) => {
    const lp = (senderJid ?? "").split("@")[0].split(":")[0];
    if (lp && byPhone.has(last10(lp))) return byPhone.get(last10(lp))!;
    const named = byName(sender, null);
    return named ? (team.find((c) => c.id === named.id) ?? null) : null;
  };
}

/** A LID sender resolved to a phone through the identity table, for coaches who write from a LID. */
async function phoneBehind(senderJid: string | null): Promise<string | null> {
  const lp = (senderJid ?? "").split("@")[0].split(":")[0];
  if (!lp || !senderJid?.includes("@lid")) return null;
  const row = await prisma.waIdentity.findUnique({ where: { localpart: lp }, select: { counterpart: true } }).catch(() => null);
  return row?.counterpart ?? null;
}

export type CoachReaderResult = { read: number; lessons: number; commands: number };

/** Every store pass: new messages from coaches that reply to the agent or address it become lessons. */
export async function runCoachReader(now = new Date()): Promise<CoachReaderResult> {
  const result: CoachReaderResult = { read: 0, lessons: 0, commands: 0 };
  const isCoach = await coachMatcher();
  const settings = await prisma.agentSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
  const since = settings.coachWatermark ?? new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS);
  // Connected groups, plus each coach's direct chat with the ops number (a row the gateway
  // creates on first contact: role IGNORE, subject "Coaching · <name>", jid not a group).
  const groups = await prisma.waGroup.findMany({ where: { active: true, archivedAt: null, OR: [{ role: { in: ["SUPPORT", "PROVIDER", "INTERNAL"] } }, { role: "IGNORE", subject: { startsWith: "Coaching · " } }] }, select: { id: true, jid: true, role: true, subject: true, storeId: true, labId: true } });
  if (!groups.length) return result;
  const byGroup = new Map(groups.map((g) => [g.id, g]));
  const isDirect = (g: { jid: string }) => !g.jid.endsWith("@g.us");
  // Words that name a connected store or lab ("plum", "star pathology"), for lessons given in a direct chat.
  const named = groups.filter((g) => !isDirect(g) && (g.storeId != null || g.labId != null)).map((g) => ({ g, words: g.subject.toLowerCase().replace(/labstack|<>|ops|lab\b|group|\(.*?\)/g, " ").split(/[^a-z0-9]+/).filter((w) => w.length >= 4) }));
  const scopeFromWords = (text: string): string | null => {
    const t = text.toLowerCase();
    const hit = named.find((n) => n.words.some((w) => t.includes(w)));
    return hit ? (hit.g.storeId != null ? `STORE:${hit.g.storeId}` : `LAB:${hit.g.labId}`) : null;
  };
  // Where the coach hears back: the internal group, or the direct chat the lesson came from.
  const reply = async (g: { id: string; jid: string }, m: { id: string; waMsgId: string }, text: string) => {
    if (isDirect(g)) { await sendWhatsApp({ targetJid: g.jid, groupId: g.id, text, quotedWaId: m.waMsgId, now }).catch(() => undefined); return; }
    if (ops) await postToOps({ kind: "OPS_QUESTION", orderId: 0, idemKey: `coach:${m.id}`, now, quotedWaId: g.id === ops.id ? m.waMsgId : null, text }).catch(() => undefined);
  };
  const messages = await prisma.waMessage.findMany({
    where: { groupId: { in: groups.map((g) => g.id) }, direction: "IN", ts: { gt: since, lte: now } },
    orderBy: { ts: "asc" }, take: 300,
    select: { id: true, waMsgId: true, groupId: true, ts: true, sender: true, senderJid: true, fromMe: true, text: true, replyToWaId: true },
  });
  if (!messages.length) return result;
  const ops = await opsGroup();
  let agentName = settings.agentName ?? null;
  let prefixRe = coachPrefixRe(agentName);
  const signed = () => (agentName ? `\n— ${agentName}` : "");
  for (const m of messages) {
    result.read += 1;
    const text = (m.text ?? "").trim();
    if (!text) continue;
    let coach = isCoach(m.sender, m.senderJid);
    if (!coach) { const phone = await phoneBehind(m.senderJid); if (phone) coach = isCoach(m.sender, `${phone}@s.whatsapp.net`); }
    if (!coach) continue;
    const g = byGroup.get(m.groupId)!;
    // What it replies to: one of ours, with the outbox item that produced it (scope, order, wording).
    const ours = m.replyToWaId ? await prisma.waOutbound.findFirst({ where: { sentWaMsgId: m.replyToWaId }, select: { id: true, text: true } }).catch(() => null) : null;
    // In a direct chat every message is coaching; in the internal group only a prefixed one.
    const addressed = isDirect(g) || (g.role === "INTERNAL" && prefixRe.test(text));
    if (!ours && !addressed) continue;
    try {
      const item = ours ? await prisma.agentOutboxItem.findFirst({ where: { outboundId: ours.id }, select: { counterparty: true, orderId: true, ask: true } }).catch(() => null) : null;
      const scope = item?.counterparty?.startsWith("STORE:") || item?.counterparty?.startsWith("LAB:") ? item.counterparty : g.storeId != null ? `STORE:${g.storeId}` : g.labId != null ? `LAB:${g.labId}` : scopeFromWords(text) ?? "GLOBAL";
      const words = text.replace(prefixRe, "").trim();
      // "undo" in reply to a Noted post drops that lesson.
      if (ours && /^undo\b/i.test(words) && /📝 Noted/.test(ours.text)) {
        const dropped = await undoByNoted(ours.text);
        await reply(g, m, dropped ? "↩️ Dropped." : "That lesson was already gone.");
        continue;
      }
      // A question in the direct chat is answered from the agent's own record, not stored as a lesson.
      if (isDirect(g) && isQuestion(words)) {
        await reply(g, m, (await answerQuestion(words, agentName)) + signed());
        continue;
      }
      const command = parseCommand(text, agentName);
      if (command) {
        const done = await applyCommand(command, now);
        if (command.verb === "rename" && done.ok) { agentName = command.name; prefixRe = coachPrefixRe(agentName); }
        await prisma.agentCoaching.create({ data: { contactId: coach.id, contactName: coach.name, groupId: m.groupId, waMsgId: m.waMsgId, outboundId: ours?.id ?? null, orderId: item?.orderId || null, scope: "GLOBAL", text: words, lesson: { command, done } , status: "COMMAND" } });
        result.commands += 1;
        await reply(g, m, (done.ok ? `✅ ${done.note}` : `⚠️ ${done.note}`) + signed());
        continue;
      }
      const lesson = await readLesson({ words, about: ours?.text ?? null, ask: item?.ask ?? null, scope, groupSubject: g.subject });
      const row = await prisma.agentCoaching.create({ data: { contactId: coach.id, contactName: coach.name, groupId: m.groupId, waMsgId: m.waMsgId, outboundId: ours?.id ?? null, orderId: item?.orderId || null, scope, text: words, lesson, status: lesson.kind === "praise" ? "RETIRED" : "ACTIVE" }, select: { id: true } });
      result.lessons += 1;
      // A trial wording the coach disliked is retired on the spot.
      let retired: string | null = null;
      if (ours && lesson.retireWording) {
        const send = await prisma.agentMessageSend.findFirst({ where: { outboundId: ours.id, variantId: { not: null } }, select: { variantId: true, key: true } }).catch(() => null);
        if (send?.variantId) {
          await prisma.agentMessageVariant.update({ where: { id: send.variantId }, data: { status: "RETIRED", decidedAt: now, rationale: `retired by ${coach.name}: ${words.slice(0, 120)}` } }).catch(() => undefined);
          retired = send.key;
        }
      }
      const where = scope === "GLOBAL" ? "everywhere" : scope.startsWith("STORE:") ? (isDirect(g) ? `for ${named.find((n) => `STORE:${n.g.storeId}` === scope)?.g.subject ?? "that store"}` : "this store") : (isDirect(g) ? `for ${named.find((n) => `LAB:${n.g.labId}` === scope)?.g.subject ?? "that lab"}` : "this lab");
      await reply(g, m, `📝 Noted, ${coach.name.split(/\s+/)[0]} — from now, ${where}: ${lesson.rule}${retired ? `\n(the "${retired}" wording that message used is retired)` : ""}\nReply *undo* to this message to drop it. #${row.id.slice(-6)}${signed()}`);
    } catch (error) {
      console.error(`[Coach] message ${m.id} failed:`, error instanceof Error ? error.message : error);
    }
  }
  await prisma.agentSettings.update({ where: { id: "default" }, data: { coachWatermark: messages[messages.length - 1].ts } });
  return result;
}

/** The words as a lesson: the Brain reads them with the message they were about; the words themselves when no model is available. */
export async function readLesson(input: { words: string; about: string | null; ask: string | null; scope: string; groupSubject: string }): Promise<CoachLesson> {
  const fallback: CoachLesson = { kind: "rule", rule: input.words.slice(0, 300), applies: ["reader", "judge", "wording"], retireWording: /\b(wording|too long|shorter|tone|phrase|don'?t say|never say)\b/i.test(input.words) };
  if (!process.env.ANTHROPIC_API_KEY || process.env.AGENT_LLM === "off") return fallback;
  const r = await askModel({
    purpose: "brain", maxTokens: 300,
    system: [
      "The head of operations is coaching a WhatsApp ops agent that handles diagnostic-lab orders for pharmacy stores. Turn one piece of feedback into one rule the agent can follow from now on.",
      "Return JSON only: {\"kind\": \"wording\"|\"timing\"|\"linking\"|\"rule\"|\"handover\"|\"repeat\"|\"missed\"|\"scope\"|\"praise\", \"rule\": \"one imperative sentence, concrete, no names of people\", \"applies\": [\"reader\",\"judge\",\"wording\",\"handoff\",\"digest\",\"lab\",\"store\"], \"retireWording\": boolean}.",
      "wording = how a message is phrased; timing = when to speak or stay quiet; linking = which order a message is about; handover = what to leave to a person; repeat = saying things twice; missed = something it should have done; scope = what kinds of question it may answer; praise = approval with nothing to change.",
      "retireWording is true only when the feedback is about the phrasing of the message it replied to.",
    ].join("\n"),
    user: `Group: ${input.groupSubject}\nScope: ${input.scope}${input.about ? `\nThe agent's message being replied to (${input.ask ?? "message"}): ${JSON.stringify(input.about.slice(0, 500))}` : ""}\nFeedback: ${JSON.stringify(input.words.slice(0, 600))}`,
  }).catch(() => null);
  if (!r) return fallback;
  try {
    const j = JSON.parse(r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1)) as Partial<CoachLesson>;
    const kinds: CoachLesson["kind"][] = ["wording", "timing", "linking", "rule", "handover", "repeat", "missed", "scope", "praise"];
    return {
      kind: kinds.includes(j.kind as CoachLesson["kind"]) ? (j.kind as CoachLesson["kind"]) : "rule",
      rule: String(j.rule ?? "").trim().slice(0, 300) || fallback.rule,
      applies: Array.isArray(j.applies) && j.applies.length ? (j.applies.filter((a): a is CoachLesson["applies"][number] => typeof a === "string") as CoachLesson["applies"]) : fallback.applies,
      retireWording: j.retireWording === true,
    };
  } catch { return fallback; }
}

/** pause / resume a store, a lab or everything, by the name on its connected group. */
export async function applyCommand(cmd: CoachCommand, now = new Date()): Promise<{ ok: boolean; note: string }> {
  const settings = await prisma.agentSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
  if (cmd.verb === "rename") {
    await prisma.agentSettings.update({ where: { id: "default" }, data: { agentName: cmd.name } });
    return { ok: true, note: `From now I sign as ${cmd.name} and answer to "${cmd.name}:" here.` };
  }
  if (cmd.target === "all") {
    await prisma.agentSettings.update({ where: { id: "default" }, data: { pausedAll: cmd.verb === "pause" } });
    return { ok: true, note: cmd.verb === "pause" ? "Everything paused: no desk sends anything until 'bot: resume all'." : "Everything resumed." };
  }
  if (!cmd.name) return { ok: false, note: `Which ${cmd.target}? Say "bot: ${cmd.verb} ${cmd.target} <name>".` };
  const groups = await prisma.waGroup.findMany({ where: { active: true, archivedAt: null, role: cmd.target === "store" ? "SUPPORT" : "PROVIDER" }, select: { subject: true, storeId: true, labId: true } });
  const needle = cmd.name.toLowerCase();
  const hits = groups.filter((g) => g.subject.toLowerCase().includes(needle) && (cmd.target === "store" ? g.storeId != null : g.labId != null));
  const ids = [...new Set(hits.map((g) => (cmd.target === "store" ? g.storeId! : g.labId!)))];
  if (!ids.length) return { ok: false, note: `No connected ${cmd.target} group matches "${cmd.name}".` };
  if (ids.length > 1) return { ok: false, note: `"${cmd.name}" matches ${hits.length} groups (${hits.map((g) => g.subject).slice(0, 3).join(", ")}) — be more specific.` };
  const field = cmd.target === "store" ? "pausedStoreIds" : "pausedLabIds";
  const current = new Set(settings[field]);
  if (cmd.verb === "pause") current.add(ids[0]); else current.delete(ids[0]);
  await prisma.agentSettings.update({ where: { id: "default" }, data: { [field]: [...current], updatedAt: now } });
  return { ok: true, note: `${hits[0].subject}: ${cmd.verb === "pause" ? "paused — the agent sends nothing there until 'bot: resume'" : "resumed"}.` };
}

/**
 * The lessons to read into a prompt for this scope: the latest ACTIVE ones for GLOBAL and the
 * store or lab at hand. One line each, the newest last so it carries the most weight.
 */
export async function coachingLines(scope: { storeId?: number | null; labId?: number | null }, applies?: CoachLesson["applies"][number], limit = 12): Promise<string[]> {
  const scopes = ["GLOBAL", ...(scope.storeId != null ? [`STORE:${scope.storeId}`] : []), ...(scope.labId != null ? [`LAB:${scope.labId}`] : [])];
  const rows = await prisma.agentCoaching.findMany({ where: { status: "ACTIVE", scope: { in: scopes } }, orderBy: { createdAt: "desc" }, take: limit * 2, select: { lesson: true, text: true } }).catch(() => []);
  const lines: string[] = [];
  for (const r of rows) {
    const l = r.lesson as Partial<CoachLesson> | null;
    if (applies && l?.applies?.length && !l.applies.includes(applies)) continue;
    lines.push((l?.rule ?? r.text).trim());
    if (lines.length >= limit) break;
  }
  return lines.reverse();
}

/** The block a prompt carries when there is coaching: these come first, over everything else the prompt says. */
export async function coachingBlock(scope: { storeId?: number | null; labId?: number | null }, applies?: CoachLesson["applies"][number]): Promise<string> {
  const lines = await coachingLines(scope, applies);
  return lines.length ? ["COACHING FROM THE HEAD OF OPERATIONS — these override anything else here:", ...lines.map((l) => `- ${l}`)].join("\n") : "";
}

/** "undo" in reply to a Noted post drops that lesson. */
export async function undoByNoted(notedText: string): Promise<boolean> {
  const id = /#([a-z0-9]{6})\s*$/i.exec(notedText)?.[1];
  if (!id) return false;
  const row = await prisma.agentCoaching.findFirst({ where: { status: "ACTIVE", id: { endsWith: id } }, select: { id: true } });
  if (!row) return false;
  await prisma.agentCoaching.update({ where: { id: row.id }, data: { status: "RETIRED", retiredAt: new Date() } });
  return true;
}

// ── Questions: "why did you reply on 95226?" ────────────────────────────────

const QUESTION_RE = /\?\s*$|^\s*(why|what|how|when|did|do|does|is|are|was|were|has|have|which|who|explain|tell me|show me|status of)\b/i;
export function isQuestion(text: string): boolean {
  return QUESTION_RE.test(text.trim()) && !COMMAND_RE.test(text) && !RENAME_RE.test(text);
}

/** The agent's own account of an order, or of what it can answer. Facts from its record; nothing invented. */
export async function answerQuestion(words: string, agentName: string | null): Promise<string> {
  const ids = [...new Set((words.match(/(?<![\d@+])\d{5,6}(?!\d)/g) ?? []).map(Number))].slice(0, 3);
  if (!ids.length) return `Ask me about an order by its id — "why did you reply on 95226?", "what happened with 94284?" — and I'll show my record for it. Anything else you write here I take as an instruction.`;
  const parts: string[] = [];
  for (const id of ids) parts.push(await explainOrder(id));
  return parts.join("\n\n") + (agentName ? "" : "");
}

export async function explainOrder(orderId: number, now = new Date()): Promise<string> {
  const { fetchOrderSnapshot } = await import("../journey/window");
  const { LABELS } = await import("../journey/step");
  const tz = process.env.TIMEZONE || "Asia/Kolkata";
  const t = (d: Date | null | undefined) => (d ? d.toLocaleString("en-IN", { timeZone: tz, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—");
  const o = await fetchOrderSnapshot(orderId).catch(() => null);
  if (!o) return `#${orderId}: not in LabStack as far as I can see.`;
  const journey = await prisma.agentJourney.findUnique({ where: { orderId }, select: { id: true, stage: true, closedAt: true, closeReason: true, checkpoints: { select: { name: true, status: true, dueAt: true, metAt: true }, orderBy: { dueAt: "asc" } } } }).catch(() => null);
  const since = new Date(now.getTime() - 48 * 3_600_000);
  const actions = await prisma.agentAction.findMany({ where: { orderId, createdAt: { gte: since }, action: { notIn: ["wait", "portal_read"] } }, orderBy: { createdAt: "asc" }, take: 25, select: { createdAt: true, desk: true, action: true, params: true, reason: true, outcome: true, blockedBy: true } }).catch(() => []);
  const sent = await prisma.agentOutboxItem.findMany({ where: { orderId, createdAt: { gte: since } }, orderBy: { createdAt: "asc" }, take: 25, select: { createdAt: true, counterparty: true, ask: true, status: true, sentAt: true, payload: true } }).catch(() => []);
  const threads = await prisma.agentThread.findMany({ where: { orderId, status: "OPEN" }, select: { kind: true, waitingOn: true, openedAt: true, reminders: true } }).catch(() => []);
  const lines = [`*#${orderId}* · ${o.labName ?? "lab ?"} · visit ${t(o.appointmentTime)} · LabStack: ${o.orderStatus.toLowerCase().replace(/_/g, " ")} (${t(o.statusUpdatedAt)})`];
  if (journey) {
    const cp = journey.checkpoints.map((c) => `${LABELS[c.name as keyof typeof LABELS] ?? c.name} ${c.status === "MET" ? `✓ ${t(c.metAt)}` : c.status === "BREACHED" ? `⚠ due ${t(c.dueAt)}` : c.status === "WAIVED" ? "–" : `due ${t(c.dueAt)}`}`);
    lines.push(`Milestones: ${cp.join(" · ")}${journey.closedAt ? ` · closed (${journey.closeReason})` : ""}`);
  } else lines.push("No journey: I am not tracking this order (its lab desk may be off).");
  if (actions.length) {
    lines.push("What I did (last 48 h):");
    for (const a of actions) {
      const p = a.params as { text?: string; template?: string; checkpoint?: string; intent?: string; taskType?: string; note?: string };
      const what = a.action === "store_reply" || a.action === "ack" || a.action === "store_alert" ? `${a.action}${p.template ? ` ${p.template}` : ""}${p.text ? `: "${String(p.text).replace(/\s+/g, " ").slice(0, 90)}"` : ""}` : a.action === "ask" ? `ask ${a.desk} about ${p.checkpoint ?? "?"}` : a.action === "store_handoff" ? `handoff to a person${p.note ? ` ("${p.note.slice(0, 70)}")` : ""}` : a.action === "create_task" ? `task ${p.taskType ?? ""}` : a.action;
      const result = a.outcome === "EXECUTED" ? "sent" : a.outcome === "BLOCKED" ? `NOT done — ${a.blockedBy ?? "blocked"}` : a.outcome === "RECORDED" ? `recorded only${a.blockedBy ? ` — ${a.blockedBy}` : ""}` : a.outcome === "REVIEW" ? "waiting for a person's OK" : a.outcome.toLowerCase();
      lines.push(`• ${t(a.createdAt)} ${what} → ${result}\n   why: ${a.reason.slice(0, 120)}`);
    }
  } else lines.push("I took no action on it in the last 48 h.");
  const undelivered = sent.filter((s) => s.status !== "SENT");
  if (undelivered.length) lines.push(`Queued but not delivered: ${undelivered.map((s) => `${s.ask} to ${s.counterparty} (${s.status.toLowerCase()})`).join(", ")}`);
  if (threads.length) lines.push(`Open with the store: ${threads.map((x) => `${x.kind} since ${t(x.openedAt)}, waiting on ${x.waitingOn.toLowerCase()}${x.reminders ? `, reminded ${x.reminders}×` : ""}`).join("; ")}`);
  return lines.join("\n");
}

