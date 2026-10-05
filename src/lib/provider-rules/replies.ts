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
 * Tying a message to an order, most certain first:
 *   REPLY_TO   it quotes one of our messages about that order;
 *   ORDER_ID   it names an order of this lab (the gateway validated the id);
 *   ONLY_OPEN  we messaged this lab about exactly one order in the last 3 h.
 * Otherwise the message stays in the WhatsApp console, unattributed.
 */
import prisma from "@/lib/db/client";
import { extractFacts } from "./reply-extract";
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

  for (const message of messages) {
    result.read += 1;
    const text = (message.text ?? "").trim();
    const labId = labByGroup.get(message.groupId)!;
    if (!text) continue;
    try {
      const match = await attribute(message, labId);
      if (!match) continue;
      result.attributed += 1;
      const { facts, extractor } = await extractFacts(text, match.context);
      if (facts.length > 0) {
        await prisma.providerOrderFact.createMany({
          data: facts.map((fact) => ({
            orderId: match.orderId, labId, kind: fact.kind, value: fact.value, confidence: fact.confidence,
            sourceMessageId: message.id, sourceText: text.slice(0, 1000), attributedBy: match.via, extractor,
            createdAt: message.createdAt,
          })),
        });
        result.facts += facts.length;
      }
      const conversation = await prisma.labCommunicationWorkflow.findUnique({ where: { orderId: match.orderId } });
      if (conversation) {
        await prisma.labCommunicationOrderEvent.create({
          data: {
            workflowId: conversation.id, type: "PROVIDER_NOTE", actorType: "LAB",
            payload: { source: "REPLY", via: match.via, sender: message.sender, text: text.slice(0, 500), facts: facts.map((f) => ({ kind: f.kind, value: f.value })) },
            occurredAt: message.createdAt,
          },
        });
      }
      // The lab answered: the rule that asked stops repeating.
      if (match.ruleId) await recordAnswered(match.ruleId, match.orderId, labId, `Reply: ${text.slice(0, 120)}`, message.createdAt);
    } catch (error) {
      console.error(`[Replies] message ${message.id} failed:`, error instanceof Error ? error.message : error);
    }
  }
  await prisma.providerCommsSettings.update({ where: { id: "default" }, data: { replyWatermark: messages[messages.length - 1].createdAt } });
  return result;
}
