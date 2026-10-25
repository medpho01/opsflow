/**
 * The Store desk reader (FR-9.1, 9.2): every store-group message since the
 * last pass is classified (intent) and linked to an order (console ids the
 * gateway already validated, lab refs via Order.labOrderId, a quoted message,
 * or the one order this store was told about in the last 3 h). A linked
 * message becomes a `store_message` event on the order's journey, which
 * decides the outcome. An unlinked question gets one ask for the order id.
 *
 * Patterns do the classifying (ported from the store bot's classifier, which
 * ran on 12k real messages); a model, when a key is set, decides only the
 * ambiguous ones.
 */
import prisma from "@/lib/db/client";
import { labstackWorkerQuery } from "@/lib/db/labstack";
import { isAutomated, loadTeam, makeTeamMatcher } from "@/lib/wa/team";
import { recordJourneyEvent, wakeJourney } from "../journey/run";
import { askModel } from "../llm";
import { enqueueOutbox } from "../executors/dispatcher";
import { storeTemplate } from "../executors/storeReply";
import { guard, loadGuardState } from "../guard/guard";
import { fetchOrderSnapshot } from "../journey/window";

export type StoreIntent = "status" | "report" | "slot" | "reschedule" | "cancel" | "change_tests" | "new_booking" | "serviceability" | "complaint" | "noise" | "other";

const FIRST_RUN_LOOKBACK_MS = 60 * 60_000;
const ONLY_OPEN_WINDOW_MS = 3 * 3_600_000;
const ACK_RE = /^\s*(ok|okay|okk|thanks?|thank you|thx|noted|sure|done|👍|🙏|✅|great|fine|received|alright|checking|will check|let me check|on it|looking into it|checking with (the )?(user|customer|cx)|sure sir|yes please|yes)[\s.!]*$/i;
const REF_RE = /\b([A-Z]{2,4}\d{5,9}|[A-Z]{2,5}[A-Z0-9]{4,8})\b/g;

export function classifyStoreMessage(text: string): { intent: StoreIntent; sure: boolean } {
  const t = text.toLowerCase();
  if (ACK_RE.test(text)) return { intent: "noise", sure: true };
  if (/escalat|frustrat|angry|upset|very bad|worst|unacceptable|disappoint|complain|rude|misbehav|rca|root cause|why (is|so) (much )?delay|again and again/.test(t)) return { intent: "complaint", sure: true };
  if (/(check|confirm|follow ?up) with the lab|make sure|ensure|please follow ?up|kindly follow ?up/.test(t) && !/reschedul|cancel/.test(t)) return { intent: "status", sure: true };
  if (/reschedul|re-schedul|new slot|change (the )?(slot|time|date)|postpone|prepone|shift (it|the slot)/.test(t)) return { intent: "reschedule", sure: true };
  if (/(please|pls|kindly|can you|want to|need to).{0,20}cancel|cancel (this|the) (order|request|booking)|cancellation/.test(t)) return { intent: "cancel", sure: true };
  if (/\badd\b.{0,30}\b(test|dengue|h1n1|cbc|hba1c|vitamin|package)|change (the )?package|package should be|remove (the )?test|include .{0,20}test/.test(t)) return { intent: "change_tests", sure: true };
  if (/upload.*report|report.*(upload|pending|ready|share|awaited|missing|not received)|share.*report|tat.*(breach|over|exceed)|reports? not|complete reports?|partial report|missing (in|from) (the )?report/.test(t)) return { intent: "report", sure: true };
  if (/serviceab|non.?servic|not servic|no labs? found|alternate lab|pincode.{0,20}(possible|serviceable|check)/.test(t)) return { intent: "serviceability", sure: true };
  if (/\bslot/.test(t) && !/status/.test(t)) return { intent: "slot", sure: false };
  if (/status|any update|update\??\s*$|what.*happen|collected\??|confirmed\??|phlebo (at|reached|location|where)|is (it|this) done|when will/.test(t)) return { intent: "status", sure: true };
  if (/please (proceed|process|create|book|arrange)|(kindly|pls) (proceed|process|create|book|arrange)|create (a )?(request|order|booking)|new (booking|order)|book (a|an) (test|order)/.test(t)) return { intent: "new_booking", sure: true };
  return { intent: "other", sure: false };
}

export type StoreReaderResult = { read: number; linked: number; answered: number; tasks: number; review: number };

/** Order ids a store writes in a message: 5–6 digits, not part of a longer number (a phone, a lab ref). */
export const EXPLICIT_ID_RE = /(?<![\d+])#?(\d{5,6})(?![\d])/g;
export function explicitOrderIds(text: string): number[] {
  // A phone number written with spaces or dashes ("98765 43210") is not two order ids.
  const withoutPhones = text.replace(/\+?\d[\d\s-]{8,}\d/g, " ");
  return [...new Set([...withoutPhones.matchAll(EXPLICIT_ID_RE)].map((m) => Number(m[1])))];
}

/**
 * Which order a store message is about. Never the group's "active thread": the
 * gateway tags a message with the thread's order when it names none (idType
 * CONTEXT), and in a busy store group that pinned every question to one order
 * (Plum, 24 Oct 2026). Only an id the store wrote, a quoted message's order, or
 * the one order we asked them about counts.
 */
async function linkOrder(message: { orderIds: number[]; idType: string | null; idVia: string | null; refIds: string[]; text: string; replyToWaId: string | null; groupId: string }, storeId: number, now: Date): Promise<{ orderId: number; via: string } | null> {
  // An id the store wrote, checked against LabStack and this store.
  const written = explicitOrderIds(message.text);
  if (written.length) {
    const rows = await labstackWorkerQuery<{ id: number }>(`SELECT id FROM public."Order" WHERE id = ANY($1::int[]) AND "storeId" = $2 ORDER BY "createdAt" DESC LIMIT 1`, [written, storeId]).catch(() => []);
    if (rows[0]) return { orderId: rows[0].id, via: "ORDER_ID" };
  }
  // The gateway's tag, only when it came straight from a number in this message
  // ("order 93312"). Tags inherited through a reply chain have been seen to
  // disagree with their own explanation ("reply · order 93709" tagged 90381).
  const direct = message.idType === "ORDER" && /^order \d+/i.test(message.idVia ?? "");
  if (message.orderIds.length && direct) return { orderId: message.orderIds[0], via: "ORDER_ID" };
  const refs = [...new Set([...message.refIds, ...(message.text.match(REF_RE) ?? [])].map((r) => r.toUpperCase()))].filter((r) => /\d/.test(r));
  if (refs.length) {
    const rows = await labstackWorkerQuery<{ id: number }>(`SELECT id FROM public."Order" WHERE upper("labOrderId") = ANY($1::text[]) AND "storeId" = $2 ORDER BY "createdAt" DESC LIMIT 1`, [refs, storeId]).catch(() => []);
    if (rows[0]) return { orderId: rows[0].id, via: "LAB_REF" };
  }
  if (message.replyToWaId) {
    // A quoted store message: the id the store wrote in it, not its tag.
    const quoted = await prisma.waMessage.findUnique({ where: { waMsgId: message.replyToWaId }, select: { text: true } });
    const quotedIds = quoted ? explicitOrderIds(quoted.text) : [];
    if (quotedIds.length) {
      const rows = await labstackWorkerQuery<{ id: number }>(`SELECT id FROM public."Order" WHERE id = ANY($1::int[]) AND "storeId" = $2 ORDER BY "createdAt" DESC LIMIT 1`, [quotedIds, storeId]).catch(() => []);
      if (rows[0]) return { orderId: rows[0].id, via: "QUOTED" };
    }
    const ours = await prisma.waOutbound.findFirst({ where: { sentWaMsgId: message.replyToWaId }, select: { id: true } });
    if (ours) {
      const item = await prisma.agentOutboxItem.findFirst({ where: { outboundId: ours.id }, select: { orderId: true } });
      if (item) return { orderId: item.orderId, via: "QUOTED" };
    }
  }
  const recent = await prisma.agentOutboxItem.findMany({ where: { counterparty: `STORE:${storeId}`, status: "SENT", sentAt: { gte: new Date(now.getTime() - ONLY_OPEN_WINDOW_MS) } }, select: { orderId: true }, distinct: ["orderId"] });
  if (recent.length === 1) return { orderId: recent[0].orderId, via: "ONLY_OPEN" };
  return null;
}

const CLOSED_TASK: Partial<Record<StoreIntent, string>> = { report: "AGENT_REPORT_UPLOAD", reschedule: "AGENT_RESCHEDULE", cancel: "AGENT_CANCEL", change_tests: "AGENT_ORDER_CHANGE", complaint: "AGENT_COMPLAINT" };

async function answerClosedOrder(orderId: number, storeId: number, intent: StoreIntent, text: string, waMsgId: string, at: Date, state: Awaited<ReturnType<typeof loadGuardState>>): Promise<{ executed: number; review: number }> {
  const o = await fetchOrderSnapshot(orderId).catch(() => null);
  if (!o) return { executed: 0, review: 0 };
  const tz = process.env.TIMEZONE || "Asia/Kolkata";
  const when = o.statusUpdatedAt ? o.statusUpdatedAt.toLocaleString("en-IN", { timeZone: tz, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "earlier";
  const line = o.orderStatus === "REPORT_DELIVERED" ? `report delivered on ${when}` : o.orderStatus === "CANCELED" || o.orderStatus === "CANCELLED" ? `cancelled on ${when}`
    : o.orderStatus === "PATIENT_MISSED" ? `marked patient missed on ${when}` : `shows ${o.orderStatus.toLowerCase().replace(/_/g, " ")} since ${when}`;
  const taskType = CLOSED_TASK[intent];
  const ctx = { journeyId: null, orderId, labId: o.labId, storeId, orderType: o.orderType, appointmentTime: o.appointmentTime, patientName: o.patientName, labName: o.labName, storeName: o.storeName };
  const reply = await guard({ desk: "STORE", action: "store_reply", params: { text: `#${orderId}: LabStack ${line}.${taskType ? " Raising it with the team now." : ""}`, orderId, storeId, quotedWaId: waMsgId }, reason: `store asked about a closed order (${intent}); LabStack ${line}`, idemKey: `closed:${orderId}:${waMsgId}` }, ctx, state);
  let executed = reply.outcome === "EXECUTED" ? 1 : 0; let review = reply.outcome === "REVIEW" ? 1 : 0;
  if (taskType) {
    const t = await guard({ desk: "STORE", action: "create_task", params: { taskType, orderId, cause: `STORE_${intent.toUpperCase()}_CLOSED_ORDER`, evidence: [{ kind: "store_msg", at: at.toISOString(), text: text.slice(0, 300) }, { kind: "console", at: at.toISOString(), text: `LabStack ${line}` }], action: `#${orderId}: ${intent.replace("_", " ")} asked by the store; LabStack ${line}` }, reason: `store asked to ${intent.replace("_", " ")} on a closed order`, idemKey: `closed-task:${orderId}:${waMsgId}` }, ctx, state);
    executed += t.outcome === "EXECUTED" ? 1 : 0; review += t.outcome === "REVIEW" ? 1 : 0;
  }
  return { executed, review };
}

export async function runStoreReader(now = new Date()): Promise<StoreReaderResult> {
  const result: StoreReaderResult = { read: 0, linked: 0, answered: 0, tasks: 0, review: 0 };
  const groups = await prisma.waGroup.findMany({ where: { role: "SUPPORT", active: true, archivedAt: null, storeId: { not: null } }, select: { id: true, storeId: true, jid: true } });
  if (!groups.length) return result;
  const storeByGroup = new Map(groups.map((g) => [g.id, g]));
  const state = await loadGuardState();
  const liveOrShadow = new Set([...state.desks].filter(([k, v]) => k.startsWith("STORE:STORE:") && v !== "OFF").map(([k]) => Number(k.split(":")[2])));
  if (!liveOrShadow.size) return result;

  const settings = await prisma.agentSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
  const since = settings.storeWatermark ?? new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS);
  const messages = await prisma.waMessage.findMany({
    where: { groupId: { in: groups.map((g) => g.id) }, direction: "IN", fromMe: false, ts: { gt: since, lte: now } },
    orderBy: { ts: "asc" }, take: 200,
  });
  if (!messages.length) return result;
  const isTeam = makeTeamMatcher(await loadTeam());

  for (const m of messages) {
    result.read += 1;
    const g = storeByGroup.get(m.groupId)!;
    if (!liveOrShadow.has(g.storeId!)) continue;
    if (isAutomated(m) || isTeam(m.sender, m.senderJid)) continue;
    const text = (m.text ?? "").trim();
    if (!text) continue;
    let { intent, sure } = classifyStoreMessage(text);
    if (!sure) {
      const answer = await askModel({ purpose: "store_reader", maxTokens: 60, system: "Classify one WhatsApp message from a client store to a diagnostics ops team. Reply with one word from: status, report, slot, reschedule, cancel, change_tests, new_booking, serviceability, complaint, noise, other.", user: text.slice(0, 600) });
      const word = answer?.text.trim().toLowerCase().replace(/[^a-z_]/g, "");
      if (word && ["status", "report", "slot", "reschedule", "cancel", "change_tests", "new_booking", "serviceability", "complaint", "noise", "other"].includes(word)) { intent = word as StoreIntent; sure = true; }
    }
    if (intent === "noise") continue;
    const link = await linkOrder({ orderIds: m.orderIds, idType: m.idType ?? null, idVia: m.idVia ?? null, refIds: m.refIds, text, replyToWaId: m.replyToWaId, groupId: m.groupId }, g.storeId!, now);
    await prisma.waMessage.update({ where: { id: m.id }, data: { intent: `STORE_${intent.toUpperCase()}` } }).catch(() => undefined);
    if (!link) {
      // Ask once for the order id (FR-9.2), only for questions that need one — and never inside a
      // thread with a person: a reply to a message that is not ours is theirs to handle.
      const inHumanThread = !!m.replyToWaId && !(await prisma.waOutbound.findFirst({ where: { sentWaMsgId: m.replyToWaId }, select: { id: true } }));
      if (!inHumanThread && ["status", "report", "slot", "reschedule", "cancel", "change_tests"].includes(intent) && state.desks.get(`STORE:STORE:${g.storeId}`) === "LIVE") {
        await enqueueOutbox({ counterparty: `STORE:${g.storeId}`, ask: "STORE_REPLY", orderId: 0, journeyId: null, actionId: null, windowFrom: now, windowTo: new Date(now.getTime() + 2 * 3_600_000), urgent: true, idemKey: `askid:${m.id}`, line: { orderId: 0, patientName: null, appointment: null }, text: await storeTemplate("STORE_ASK_ORDER_ID") }).catch(() => undefined);
      }
      continue;
    }
    result.linked += 1;
    const recorded = await recordJourneyEvent(link.orderId, {
      kind: "store_message", at: m.ts, actor: "STORE",
      payload: { intent, text: text.slice(0, 500), messageId: m.id, waMsgId: m.waMsgId, via: link.via, storeId: g.storeId, sender: m.sender },
    }, false);
    if (recorded) {
      const r = await wakeJourney(link.orderId, "inbound");
      result.answered += r.executed; result.review += r.review;
    } else {
      // No open journey — delivered, cancelled or missed. Still an answer (Plum asked about a
      // partial report and a cancelled order on 25 Oct 2026 and heard nothing).
      const r = await answerClosedOrder(link.orderId, g.storeId!, intent, text, m.waMsgId, m.ts, state);
      result.answered += r.executed; result.review += r.review;
    }
  }
  await prisma.agentSettings.update({ where: { id: "default" }, data: { storeWatermark: messages[messages.length - 1].ts } });
  return result;
}
