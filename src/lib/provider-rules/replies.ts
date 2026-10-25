/**
 * Reply understanding — what labs write in their groups, as facts on orders.
 *
 * Each pass reads the lab-group messages that arrived since the last pass
 * (wa_messages, written by the gateway), ties each one to an order, reads it
 * as facts (reply-extract.ts), and:
 *   - records the facts (provider_order_facts) — rules can test them
 *     ("stop once report_shared") and templates use the latest values
 *     (the phlebo's name and number when LabStack has none);
 *   - puts the reply and its facts on the order's timeline;
 *   - marks the rule that asked as answered, so its repeats stop.
 *
 * A reply to a combined message is split by item number (batching.ts). When
 * it quotes one and nothing can be placed, every order in it gets the text as
 * a note and the ask counts as answered — a lab that wrote back is never asked
 * again as if it had not.
 *
 * Tying a message to an order, most certain first:
 *   REPLY_TO   it quotes one of our messages about that order;
 *   ORDER_ID   it names an order of this lab (the gateway validated the id);
 *   ONLY_OPEN  we messaged this lab about exactly one order in the last 3 h.
 * Otherwise the message stays in the WhatsApp console, unattributed.
 */
import prisma from "@/lib/db/client";
import { loadTeam, makeTeamMatcher } from "@/lib/wa/team";
import { asksConfirmation, type Ask } from "./reply-extract";
import type { FactKind } from "./types";
import { splitBatchReply } from "./batching";
import { recordAnswered } from "./engine";
import { labstackWorkerQuery } from "@/lib/db/labstack";

const BATCH = 200;
const ONLY_OPEN_WINDOW_MS = 3 * 3_600_000;
/** First run: read back this far, not the whole history. */
const FIRST_RUN_LOOKBACK_MS = 60 * 60_000;

export type ReplyPassResult = { read: number; attributed: number; facts: number };

type Attribution = { orderId: number; via: "REPLY_TO" | "ORDER_ID" | "ONLY_OPEN"; ruleId: string | null; context: string | null };

async function attribute(
  message: { replyToWaId: string | null; orderIds: number[]; createdAt: Date },
  labId: number,
): Promise<Attribution | null> {
  if (message.replyToWaId) {
    const outbound = await prisma.waOutbound.findFirst({ where: { sentWaMsgId: message.replyToWaId } });
    if (outbound) {
      const communication = await prisma.labCommunication.findUnique({ where: { waOutboundId: outbound.id } });
      if (communication?.orderId) return { orderId: communication.orderId, via: "REPLY_TO", ruleId: communication.ruleId, context: outbound.text };
    }
  }
  if (message.orderIds.length > 0) {
    const conversation = await prisma.labCommunicationWorkflow.findFirst({ where: { labId, orderId: { in: message.orderIds } } });
    if (conversation) return { orderId: conversation.orderId, via: "ORDER_ID", ruleId: await lastRuleFor(conversation.orderId), context: null };
    // An order of this lab we have not messaged yet ("<id> sample collected" before the check): still its fact.
    const [own] = await labstackWorkerQuery<{ id: number }>(
      `SELECT id FROM public."Order" WHERE id = ANY($1::int[]) AND "labId" = $2 ORDER BY id LIMIT 1`, [message.orderIds, labId]);
    if (own) return { orderId: own.id, via: "ORDER_ID", ruleId: null, context: null };
    // It names orders, just not this lab's: do not guess another one.
    return null;
  }
  const recent = await prisma.labCommunication.findMany({
    where: {
      labId, orderId: { not: null },
      createdAt: { gte: new Date(message.createdAt.getTime() - ONLY_OPEN_WINDOW_MS), lte: message.createdAt },
    },
    select: { orderId: true },
    distinct: ["orderId"],
  });
  if (recent.length === 1) return { orderId: recent[0].orderId!, via: "ONLY_OPEN", ruleId: await lastRuleFor(recent[0].orderId!), context: null };
  return null;
}

/** The rule behind our most recent message about an order. */
/** Reference-looking tokens in a lab's message: letters+digits (VL149129, BLR6365567) or a long number, incl. "Booking (ID: n)". */
export function labRefTokens(text: string): Array<{ ref: string; said: string }> {
  const out: Array<{ ref: string; said: string }> = [];
  const re = /(?:booking\s*\(?\s*id\s*:?\s*)?\b(?=[A-Za-z0-9]*\d)([A-Za-z]{2,5}[0-9A-Za-z]{4,}|\d{7,9})\b\)?\s*[:.)\-–—]?\s*([^\n;]*)/g;
  const matches = [...text.matchAll(re)];
  for (const [k, m] of matches.entries()) {
    let said = m[2].trim();
    if (!said) { const start = (m.index ?? 0) + m[0].length; said = text.slice(start, matches[k + 1]?.index ?? text.length).trim(); }
    out.push({ ref: m[1].toUpperCase(), said });
  }
  return out;
}

/** Each lab reference in the text that is one of this lab's orders → what the lab said about it. */
async function splitByLabRef(text: string, labId: number): Promise<Map<number, string>> {
  const tokens = labRefTokens(text);
  const result = new Map<number, string>();
  if (!tokens.length) return result;
  const rows = await labstackWorkerQuery<{ id: number; ref: string }>(
    `SELECT id, upper("labOrderId") AS ref FROM public."Order" WHERE upper("labOrderId") = ANY($1::text[]) AND "labId" = $2`,
    [tokens.map((t) => t.ref), labId],
  ).catch(() => []);
  const byRef = new Map(rows.map((r) => [r.ref, r.id]));
  for (const t of tokens) { const id = byRef.get(t.ref); if (id != null && !result.has(id)) result.set(id, t.said || text); }
  return result;
}

async function lastRuleFor(orderId: number): Promise<string | null> {
  const last = await prisma.labCommunication.findFirst({
    where: { orderId, ruleId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { ruleId: true },
  });
  return last?.ruleId ?? null;
}

export async function runReplyPass(now = new Date()): Promise<ReplyPassResult> {
  const result: ReplyPassResult = { read: 0, attributed: 0, facts: 0 };
  const configs = await prisma.nonApiLabConfig.findMany({ where: { waGroupJid: { not: null } }, select: { labId: true, waGroupJid: true } });
  if (configs.length === 0) return result;
  const groups = await prisma.waGroup.findMany({
    where: { jid: { in: configs.map((c) => c.waGroupJid!) }, archivedAt: null },
    select: { id: true, jid: true },
  });
  const labByGroup = new Map(groups.map((g) => [g.id, configs.find((c) => c.waGroupJid === g.jid)!.labId]));
  if (labByGroup.size === 0) return result;

  const settings = await prisma.providerCommsSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
  const since = settings.replyWatermark ?? new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS);
  const messages = await prisma.waMessage.findMany({
    where: { groupId: { in: [...labByGroup.keys()] }, direction: "IN", fromMe: false, createdAt: { gt: since, lte: now } },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });
  if (messages.length === 0) return result;

  const isTeam = makeTeamMatcher(await loadTeam());
  for (const message of messages) {
    result.read += 1;
    const text = (message.text ?? "").trim();
    const labId = labByGroup.get(message.groupId)!;
    if (!text) continue;
    // Our own team writing in the lab's group is not the lab answering (a relay once echoed
    // Vijayraj's "urine sample not collected" back to the store, 25 Oct 2026).
    if (isTeam(message.sender, message.senderJid)) continue;
    try {
      // A reply to a combined message: each numbered part is about its own order.
      const combined = await attributeToBatch(message, labId, text);
      if (combined) {
        // "Share the details / contact number / address" about the orders we just asked
        // about is a question, not an answer: reply with what the lab needs (Orange, 24 Oct 2026).
        if (DETAILS_REQUEST_RE.test(text)) {
          await answerDetailsRequest(message, labId, combined.items, combined.parts, now);
          result.attributed += 1;
          continue;
        }
        if (combined.parts.size === 0) {
          // Quoted a combined message but named no item we know: a note on every order in it.
          // A bare "ok"/"done" (no numbers at all) is a yes to the whole ask; anything with
          // numbers we failed to read is kept as text only — never guessed onto a fact.
          const onlyKinds: FactKind[] = /\d/.test(text) ? [] : ["confirmed"];
          for (const item of combined.items) {
            result.attributed += 1;
            result.facts += await applyReply(message, labId, { orderId: item.orderId, via: combined.via, ruleId: item.ruleId, context: item.line }, text, text, { onlyKinds, unparsed: true });
          }
          continue;
        }
        for (const [n, said] of combined.parts) {
          const item = combined.items.find((i) => i.n === n);
          if (!item) continue;
          result.attributed += 1;
          result.facts += await applyReply(message, labId, { orderId: item.orderId, via: combined.via, ruleId: item.ruleId, context: item.line }, said, text);
        }
        continue;
      }
      // The lab's own reference, for an order not in the message it replied to — or in
      // no message at all ("VL149129 as per update customer not available", 25 Oct 2026).
      const byRef = await splitByLabRef(text, labId);
      if (byRef.size) {
        for (const [orderId, said] of byRef) {
          result.attributed += 1;
          result.facts += await applyReply(message, labId, { orderId, via: "ORDER_ID", ruleId: await lastRuleFor(orderId), context: null }, said, text);
        }
        continue;
      }
      const match = await attribute(message, labId);
      if (!match) continue;
      result.attributed += 1;
      result.facts += await applyReply(message, labId, match, text, text);
    } catch (error) {
      console.error(`[Replies] message ${message.id} failed:`, error instanceof Error ? error.message : error);
    }
  }
  await prisma.providerCommsSettings.update({ where: { id: "default" }, data: { replyWatermark: messages[messages.length - 1].createdAt } });
  return result;
}

type ReplyMessage = { id: string; sender: string; createdAt: Date };
type ApplyOptions = {
  /** Keep only these fact kinds (empty: record no facts, just the note). */
  onlyKinds?: FactKind[];
  /** The reply could not be split by item: the note says so. */
  unparsed?: boolean;
};

/**
 * What one reply (or one numbered part of it) says about one order: facts,
 * a note on the order's timeline, and "answered" for the rule that asked so
 * its repeats stop. Returns the number of facts recorded.
 */
async function applyReply(message: ReplyMessage, labId: number, match: Attribution, said: string, fullText: string, options: ApplyOptions = {}): Promise<number> {
  const rule = match.ruleId ? await prisma.providerMessageRule.findUnique({ where: { id: match.ruleId }, select: { templateKey: true } }) : null;
  const conversation = await prisma.labCommunicationWorkflow.findUnique({ where: { orderId: match.orderId } });
  // "ok" is a confirmation when we asked for one: the quoted message did, or — with no
  // message to go by — the order is still waiting for the lab to confirm.
  const ask: Ask = {
    confirmation: rule ? asksConfirmation(rule.templateKey)
      : !!conversation && (conversation.status === "WAITING_FOR_LAB_CONFIRMATION" || conversation.status === "ESCALATED"),
  };
  // The reader (model first, patterns as fallback): events are the facts; a missed sample is one too.
  const { readMessage } = await import("@/lib/agents/reader/read");
  const reading = await readMessage({ side: "lab", text: said, quotedText: match.context, confirmation: ask.confirmation, scope: { labId } });
  const missed = Object.entries(reading.samples).filter(([, s]) => s === "missed").map(([k]) => ({ kind: "sample_missed" as FactKind, value: k, confidence: 0.85 }));
  const outstanding = Object.values(reading.samples).some((s) => s === "missed" || s === "pending");
  const all = [...reading.events.map((e) => ({ kind: e.kind, value: e.value, confidence: e.confidence ?? 0.8 })), ...missed]
    .filter((f) => f.kind !== "confirmed" || ask.confirmation)
    // "the blood has been collected" next to a missed or pending urine is not a fresh collection
    .filter((f) => !(f.kind === "sample_collected" && outstanding));
  const facts = options.onlyKinds ? all.filter((f) => options.onlyKinds!.includes(f.kind)) : all;
  const extractor = reading.via === "model" ? "claude" : "patterns";
  if (facts.length > 0) {
    await prisma.providerOrderFact.createMany({
      data: facts.map((fact) => ({
        orderId: match.orderId, labId, kind: fact.kind, value: fact.value, confidence: fact.confidence,
        sourceMessageId: message.id, sourceText: fullText.slice(0, 1000), attributedBy: match.via, extractor,
        createdAt: message.createdAt,
      })),
    });
  }
  if (conversation) {
    await prisma.labCommunicationOrderEvent.create({
      data: {
        workflowId: conversation.id, type: "PROVIDER_NOTE", actorType: "LAB",
        payload: {
          source: "REPLY", via: match.via, sender: message.sender, text: said.slice(0, 500),
          ...(said !== fullText ? { fullText: fullText.slice(0, 500) } : {}),
          ...(options.unparsed ? { unparsed: true } : {}),
          facts: facts.map((f) => ({ kind: f.kind, value: f.value })),
        },
        occurredAt: message.createdAt,
      },
    });
    // Confirmed in the group — distinct from LAB_ACCEPTED, which LabStack (or the link) sets.
    // The conversation stays where it is: humans move the order in LabStack.
    if (facts.some((f) => f.kind === "confirmed")) {
      await prisma.labCommunicationOrderEvent.create({
        data: {
          workflowId: conversation.id, type: "LAB_CONFIRMED_IN_CHAT", actorType: "LAB",
          payload: { source: "REPLY", via: match.via, sender: message.sender, text: said.slice(0, 200) },
          occurredAt: message.createdAt,
        },
      });
    }
  }
  // The lab answered: the rule that asked stops repeating.
  if (match.ruleId) await recordAnswered(match.ruleId, match.orderId, labId, `Reply: ${said.slice(0, 120)}`, message.createdAt);
  // The order's agent hears about it too (OpsFlow Agents): each fact is a journey event, and the journey wakes.
  try {
    const { recordJourneyEvent } = await import("@/lib/agents/journey/run");
    const list = facts.length ? facts : [{ kind: "note", value: said.slice(0, 200), confidence: 0.5 }];
    for (const [index, fact] of list.entries()) {
      await recordJourneyEvent(match.orderId, {
        kind: "fact", at: message.createdAt, actor: "LAB",
        payload: { kind: fact.kind, value: fact.value, confidence: fact.confidence, source: "lab_reply", attributedBy: match.via, sender: message.sender, messageId: message.id, factId: `${message.id}:${index}`, context: match.context?.slice(0, 200) ?? null },
      }, index === list.length - 1);
    }
  } catch (error) {
    console.warn("[Replies] journey event failed:", error instanceof Error ? error.message : error);
  }
  return facts.length;
}

type BatchItem = { n: number; orderId: number; ruleId: string; line: string };

/**
 * Is this a reply to a combined message? Yes when it quotes one, or when the
 * lab's latest message from us was a combined one (sent in the last 3 h) and
 * the reply reads as numbered parts ("1 done, 2 not home") or "all …".
 * Returns the parts it could place; a reply that quotes a combined message
 * but cannot be placed returns no parts — the caller notes it on every order
 * in the batch rather than guessing one.
 */
/** A lab asking for what it needs to find or serve the order, rather than answering. */
const DETAILS_REQUEST_RE = /\b(share|send|give|provide|need|kindly|please|pls|which|what)\b[^\n]{0,40}\b(details?|contact|number|mobile|phone|address|location|cx|customer|patient|order ?id|ref(?:erence)?)\b|\b(cx|customer|patient) (details?|contact|number|address)\b|\bregistered (contact|number|mobile)\b/i;

/**
 * Reply, quoting the lab's message, with the details for the items they asked about
 * (the numbered ones, or every item in the message): the lab's own reference, the
 * patient's name, phone, address and visit time. Once per inbound message.
 */
async function answerDetailsRequest(message: { id: string; waMsgId: string; groupId: string }, labId: number, items: BatchItem[], parts: Map<number, string>, now: Date) {
  const wanted = parts.size ? items.filter((i) => parts.has(i.n)) : items;
  if (wanted.length === 0) return;
  // Each inbound message is read once (the reply watermark), so this answers once.
  const { fetchOrderContactDetails } = await import("@/lib/non-api-labs/order-details");
  const { fetchOpenOrders } = await import("./engine");
  const [details, orders] = await Promise.all([fetchOrderContactDetails(wanted.map((i) => i.orderId)), fetchOpenOrders([labId], now)]);
  if (!details) { console.warn(`[Replies] details request from lab ${labId}: LabStack not readable, left to the team`); return; }
  const { formatDateTime } = await import("./format");
  const lines = wanted.map((i) => {
    const d = details.get(i.orderId); const o = orders.find((x) => x.id === i.orderId);
    return [
      `${i.n}. ${d?.labRef ? `${d.labRef} · ` : ""}#${i.orderId} · ${(o?.patientName || "Patient").trim()}`,
      d?.patientMobile ? `    📞 ${d.patientMobile}` : "    📞 not on file — please check LabStack",
      d?.address ? `    📍 ${d.address}` : "",
      d?.mapUrl ? `    🗺️ ${d.mapUrl}` : "",
      o?.appointmentTime ? `    🗓️ ${formatDateTime(o.appointmentTime)}` : "",
      d?.tests ? `    🧪 ${d.tests}` : "",
    ].filter(Boolean).join("\n");
  });
  const group = await prisma.waGroup.findUnique({ where: { id: message.groupId }, select: { id: true, jid: true } });
  if (!group) return;
  const { sendWhatsApp } = await import("@/lib/agents/executors/dispatcher");
  const text = `Details for ${wanted.length === 1 ? "this order" : "these orders"}:\n\n${lines.join("\n\n")}`;
  await sendWhatsApp({ targetJid: group.jid, groupId: group.id, text, quotedWaId: message.waMsgId, now });
  console.log(`[Replies] answered a details request from lab ${labId} for ${wanted.length} order(s)`);
}

async function attributeToBatch(
  message: { replyToWaId: string | null; createdAt: Date },
  labId: number,
  text: string,
): Promise<{ items: BatchItem[]; parts: Map<number, string>; via: Attribution["via"] } | null> {
  let batch: { items: unknown; createdAt: Date } | null = null;
  let via: Attribution["via"] = "REPLY_TO";
  if (message.replyToWaId) {
    const outbound = await prisma.waOutbound.findFirst({ where: { sentWaMsgId: message.replyToWaId }, select: { id: true } });
    batch = outbound ? await prisma.providerBatch.findUnique({ where: { outboundId: outbound.id } }) : null;
    if (!batch) return null; // quotes a single-order message: the usual path
  } else {
    batch = await prisma.providerBatch.findFirst({
      where: { labId, shadow: false, createdAt: { gte: new Date(message.createdAt.getTime() - ONLY_OPEN_WINDOW_MS), lte: message.createdAt } },
      orderBy: { createdAt: "desc" },
    });
    if (!batch) return null;
    const laterSingle = await prisma.labCommunication.findFirst({
      where: { labId, orderId: { not: null }, batchOutboundId: null, waOutboundId: { not: null }, createdAt: { gt: batch.createdAt, lte: message.createdAt } },
      select: { id: true },
    });
    if (laterSingle) return null; // a single-order message came after it
    via = "ONLY_OPEN";
  }
  const items = batch.items as BatchItem[];
  const parts = splitBatchReply(text, items);
  if (via === "ONLY_OPEN" && parts.size === 0) return null;
  return { items, parts, via };
}
