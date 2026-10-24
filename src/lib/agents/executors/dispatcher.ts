/**
 * The dispatcher (DESIGN.md §4.8, FR-8.1 to 8.3): the only thing that sends.
 *
 * Journeys never send. The guard turns an approved `ask` into an outbox item
 * keyed by counterparty × ask, carrying its own send window (§4.15). A flush
 * groups the open items of one counterparty and ask into ONE numbered message
 * (reusing the combined-message lines and templates), @mentions the
 * coordinator, quotes the earlier ask for a follow-up, and writes the
 * WaOutbound the gateway sends. Items withdrawn before the flush are dropped.
 * Urgent items flush at once, alone.
 *
 * Per-lab caps and the per-slot cap are enforced here, never upstream.
 */
import { Prisma } from "@prisma/client";
import prisma from "@/lib/db/client";
import { resolveLabTarget, toDirectJid } from "@/lib/non-api-labs/target";
import { BATCH_FOLLOW_UP_FIRM_TEMPLATE, BATCH_FOLLOW_UP_TEMPLATE, BATCH_GENERIC_TEMPLATE, BATCH_TEMPLATE_BY_INTENT, ensureTemplate, renderLabTemplate } from "@/lib/non-api-labs/templates";
import { coordinatorsFor } from "@/lib/wa/coordinators";
import { currentSlot, itemLine } from "@/lib/provider-rules/batching";
import { formatTime, TIME_ZONE } from "@/lib/provider-rules/format";
import { confirmationUrl } from "@/lib/non-api-labs/confirmation-link";
import { fetchOrderContactDetails } from "@/lib/non-api-labs/order-details";
import { actionPageUrl } from "./actionPage";
import { loadDirectory, tierOf } from "../directory";

export const PER_SLOT_CAP = Number(process.env.AGENT_BATCH_PER_SLOT_CAP ?? 3);
export const PER_DAY_CAP = Number(process.env.AGENT_BATCH_PER_DAY_CAP ?? 8);

export type OutboxLine = { n?: number; orderId: number; patientName: string | null; appointment: Date | null; confirmUrl?: string | null; phlebo?: string | null; area?: string | null; labRef?: string | null; mobile?: string | null; milestone?: string | null; dueAt?: Date | string | null };

export type EnqueueInput = {
  counterparty: string;          // LAB:<id> | MANAGER:<labId> | STORE:<id>
  ask: string;                   // PHLEBO | STATUS | REPORT | UNCONFIRMED | ESCALATION | ETA | OVERDUE | <custom>
  orderId: number; journeyId: string | null; actionId: string | null;
  windowFrom: Date; windowTo: Date; urgent: boolean;
  idemKey: string;
  line: OutboxLine;
  /** Free text for a counterparty that gets a plain message (store alerts, manager notes). */
  text?: string;
};

export async function enqueueOutbox(input: EnqueueInput): Promise<{ id: string; queued: boolean }> {
  try {
    const row = await prisma.agentOutboxItem.create({
      data: {
        counterparty: input.counterparty, ask: input.ask, orderId: input.orderId, journeyId: input.journeyId, actionId: input.actionId,
        windowFrom: input.windowFrom, windowTo: input.windowTo, urgent: input.urgent, idemKey: input.idemKey,
        payload: { line: { ...input.line, appointment: input.line.appointment?.toISOString() ?? null }, text: input.text ?? null } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return { id: row.id, queued: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.agentOutboxItem.findUnique({ where: { idemKey: input.idemKey }, select: { id: true } });
      return { id: existing?.id ?? "", queued: false };
    }
    throw error;
  }
}

/** Drop queued items about an order (reschedule, cancel, answered). */
export async function withdrawOutbox(orderId: number, reason: string, asks?: string[]) {
  const where = { orderId, status: "QUEUED", ...(asks ? { ask: { in: asks } } : {}) };
  const rows = await prisma.agentOutboxItem.findMany({ where, select: { id: true } });
  if (!rows.length) return 0;
  await prisma.agentOutboxItem.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: "WITHDRAWN" } });
  await prisma.agentAction.updateMany({ where: { id: { in: (await prisma.agentOutboxItem.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { actionId: true } })).map((r) => r.actionId).filter((x): x is string => !!x) } }, data: { outcome: "BLOCKED", blockedBy: `withdrawn: ${reason}` } });
  return rows.length;
}

/** The gateway's one write: a WaOutbound row. */
export async function sendWhatsApp(input: { targetJid: string; groupId: string | null; text: string; quotedWaId?: string | null; mentions?: string[]; now?: Date }) {
  return prisma.waOutbound.create({
    data: {
      targetJid: input.targetJid, groupId: input.groupId, text: input.text, createdAt: input.now ?? new Date(),
      ...(input.quotedWaId ? { quotedWaId: input.quotedWaId } : {}),
      ...(input.mentions?.length ? { mentions: input.mentions } : {}),
    },
    select: { id: true },
  });
}

export type FlushResult = { messages: number; items: number; held: number; dropped: number; errors: number };

type Item = Prisma.AgentOutboxItemGetPayload<{ select: { id: true; counterparty: true; ask: true; orderId: true; journeyId: true; actionId: true; windowFrom: true; windowTo: true; urgent: true; payload: true; idemKey: true } }>;

/**
 * Send what is due. `urgentOnly` runs every minute for items that cannot wait;
 * the full flush runs at :00 and :30.
 */
export async function flushOutbox(now = new Date(), opts: { urgentOnly?: boolean } = {}): Promise<FlushResult> {
  const result: FlushResult = { messages: 0, items: 0, held: 0, dropped: 0, errors: 0 };
  const items = await prisma.agentOutboxItem.findMany({
    where: { status: "QUEUED", ...(opts.urgentOnly ? { urgent: true } : {}) },
    select: { id: true, counterparty: true, ask: true, orderId: true, journeyId: true, actionId: true, windowFrom: true, windowTo: true, urgent: true, payload: true, idemKey: true },
    orderBy: { createdAt: "asc" },
  });
  if (!items.length) return result;

  // Expired windows are withdrawn, never sent late (B17).
  const expired = items.filter((i) => i.windowTo.getTime() < now.getTime());
  if (expired.length) {
    await prisma.agentOutboxItem.updateMany({ where: { id: { in: expired.map((i) => i.id) } }, data: { status: "DROPPED" } });
    result.dropped += expired.length;
  }
  const open = items.filter((i) => i.windowTo.getTime() >= now.getTime());
  const ready = open.filter((i) => i.windowFrom.getTime() <= now.getTime());
  result.held += open.length - ready.length;

  const groups = new Map<string, Item[]>();
  for (const i of ready) {
    const key = `${i.counterparty}|${i.ask}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  for (const [key, group] of groups) {
    try {
      const sent = await flushGroup(key, group, now);
      result.messages += sent.messages; result.items += sent.items; result.held += sent.held;
    } catch (error) {
      result.errors += 1;
      console.error(`[Agents] flush ${key} failed:`, error instanceof Error ? error.message : error);
      await prisma.agentOutboxItem.updateMany({ where: { id: { in: group.map((i) => i.id) } }, data: { status: "FAILED" } });
    }
  }
  return result;
}

async function flushGroup(key: string, group: Item[], now: Date): Promise<{ messages: number; items: number; held: number }> {
  const [counterparty, ask] = key.split("|");
  const [kind, idText] = counterparty.split(":");
  const id = Number(idText);
  const tz = TIME_ZONE();

  if (kind === "STORE") return flushStore(id, group, now);

  const config = await prisma.nonApiLabConfig.findUnique({ where: { labId: id } });
  if (!config) throw new Error(`lab ${id} has no config`);
  const toManager = kind === "MANAGER";
  if (toManager && !config.managerWhatsapp) {
    await prisma.agentOutboxItem.updateMany({ where: { id: { in: group.map((i) => i.id) } }, data: { status: "DROPPED" } });
    return { messages: 0, items: 0, held: 0 };
  }
  const target = toManager ? { targetJid: toDirectJid(config.managerWhatsapp!), groupId: null } : await resolveLabTarget(config, null);

  // Caps: per day per lab (urgent exempt) and per slot (urgent alone).
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const sentToday = await prisma.providerBatch.count({ where: { labId: id, shadow: false, createdAt: { gte: new Date(dayStart.getTime() - 5.5 * 3_600_000) } } });
  // Per-slot cap, the same rhythm as the message rules: at most PER_SLOT_CAP combined messages per lab per :00/:30 (urgent exempt).
  const sentThisSlot = await prisma.providerBatch.count({ where: { labId: id, shadow: false, recipient: "LAB", createdAt: { gte: currentSlot(now, tz) } } });
  const urgent = group.filter((i) => i.urgent);
  const routine = group.filter((i) => !i.urgent);
  let messages = 0; let items = 0; let held = 0;

  const sendItems = async (list: Item[], urgentSend: boolean) => {
    // Manual labs get the action page on every nudge (FR-8.4): one tap is evidence. API labs get the
    // confirmation link only where the ask needs one.
    const manual = tierOf(await loadDirectory(), id) === "C";
    // What a lab needs to find the order — its reference, the phone, the place — read
    // now rather than trusted from the queued payload, so every line carries them.
    const details = await fetchOrderContactDetails(list.map((i) => i.orderId)).catch(() => null);
    const lines = await Promise.all(list.map(async (i, index) => {
      const p = (i.payload as { line: OutboxLine & { appointment: string | null } }).line;
      const d = details?.get(i.orderId);
      const needsLink = ask === "UNCONFIRMED" || ask === "ESCALATION";
      const link = manual && !toManager ? await actionPageUrl(i.orderId).catch(() => null) : null;
      return itemLine(ask, {
        n: index + 1, orderId: i.orderId, patientName: p.patientName, appointment: p.appointment ? new Date(p.appointment) : null,
        area: p.area ?? d?.area ?? null, phlebo: p.phlebo ?? null, labRef: p.labRef ?? d?.labRef ?? null, mobile: p.mobile ?? d?.patientMobile ?? null,
        milestone: p.milestone ?? null, dueAt: p.dueAt ? new Date(p.dueAt) : undefined, confirmUrl: link ?? (needsLink ? await confirmationUrl(i.orderId).catch(() => null) : null),
      }, now, tz);
    }));
    const followUp = toManager ? null : await findFollowUp(id, ask, list.map((i) => i.orderId), now);
    const people = toManager ? [] : await coordinatorsFor(config, now);
    const mention = { text: people.map((c) => `@${c.jid.split("@")[0]}`).join(" ") || "Team", jids: people.map((c) => c.jid) };
    let text: string;
    let numbers = list.map((_, i) => i + 1);
    let storedLines = lines;
    if (followUp) {
      const original = new Map(followUp.items.map((it) => [it.orderId, it]));
      numbers = list.map((i) => original.get(i.orderId)!.n);
      storedLines = list.map((i) => original.get(i.orderId)!.line);
      const t = await ensureTemplate(followUp.attempt === 1 ? BATCH_FOLLOW_UP_TEMPLATE : BATCH_FOLLOW_UP_FIRM_TEMPLATE);
      text = renderLabTemplate(t.isActive ? t.body : "{{coordinator}} still open: {{numbers}}", {
        lab_name: config.labName, coordinator: mention.text, count: String(list.length), numbers: [...numbers].sort((a, b) => a - b).join(", "), since: formatTime(followUp.since),
      });
    } else {
      const t = await ensureTemplate(BATCH_TEMPLATE_BY_INTENT[ask] ?? BATCH_GENERIC_TEMPLATE);
      text = renderLabTemplate(t.body, {
        lab_name: config.labName, manager_name: config.managerName ?? "there", coordinator: mention.text,
        count: String(list.length), orders_word: list.length === 1 ? "order" : "orders", items: lines.join("\n"), batch_title: ask.toLowerCase().replace("_", " "),
      });
    }
    const outbound = await sendWhatsApp({ targetJid: target.targetJid, groupId: target.groupId, text, quotedWaId: followUp?.quotedWaId ?? null, mentions: mention.jids, now });
    const batch = await prisma.providerBatch.create({
      data: {
        labId: id, intent: ask, slotAt: currentSlot(now, tz), shadow: false, outboundId: outbound.id, followUpOf: followUp?.rootId ?? null,
        recipient: toManager ? "MANAGER" : "LAB", itemCount: list.length, text,
        items: list.map((i, index) => ({ n: numbers[index], orderId: i.orderId, ruleId: `agent:${i.actionId ?? ask}`, occurrence: 1, communicationId: null, line: storedLines[index] })) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    await prisma.agentOutboxItem.updateMany({ where: { id: { in: list.map((i) => i.id) } }, data: { status: "SENT", batchId: batch.id, outboundId: outbound.id, sentAt: now } });
    await prisma.agentAction.updateMany({ where: { id: { in: list.map((i) => i.actionId).filter((x): x is string => !!x) } }, data: { outcome: "EXECUTED" } });
    for (const i of list) {
      if (!i.journeyId) continue;
      await prisma.agentJourneyEvent.create({ data: { journeyId: i.journeyId, at: now, kind: "ask", actor: "AGENT", applied: true, payload: { ask, counterparty, batchId: batch.id, urgent: urgentSend, followUp: !!followUp, text: text.slice(0, 500) } } });
    }
    messages += 1; items += list.length;
  };

  if (urgent.length) await sendItems(urgent, true);
  if (routine.length) {
    if (!toManager && (sentToday >= PER_DAY_CAP || sentThisSlot >= PER_SLOT_CAP)) { held += routine.length; }
    else {
      const take = routine.slice(0, 50);
      await sendItems(take, false);
      held += routine.length - take.length;
    }
  }
  return { messages, items, held };
}

/** A store counterparty gets plain text per item (answers, alerts, warnings), never a numbered ask. */
async function flushStore(storeId: number, group: Item[], now: Date) {
  const g = await prisma.waGroup.findFirst({ where: { storeId, role: "SUPPORT", archivedAt: null, active: true }, select: { id: true, jid: true } });
  if (!g) { await prisma.agentOutboxItem.updateMany({ where: { id: { in: group.map((i) => i.id) } }, data: { status: "DROPPED" } }); return { messages: 0, items: 0, held: 0 }; }
  let messages = 0;
  for (const i of group) {
    const text = (i.payload as { text?: string | null }).text;
    if (!text) { await prisma.agentOutboxItem.update({ where: { id: i.id }, data: { status: "DROPPED" } }); continue; }
    const quoted = (i.payload as { quotedWaId?: string | null }).quotedWaId ?? null;
    const outbound = await sendWhatsApp({ targetJid: g.jid, groupId: g.id, text, quotedWaId: quoted, now });
    await prisma.agentOutboxItem.update({ where: { id: i.id }, data: { status: "SENT", outboundId: outbound.id, sentAt: now } });
    if (i.actionId) await prisma.agentAction.update({ where: { id: i.actionId }, data: { outcome: "EXECUTED" } });
    if (i.journeyId) await prisma.agentJourneyEvent.create({ data: { journeyId: i.journeyId, at: now, kind: "store_message", actor: "AGENT", applied: true, payload: { ask: i.ask, text: text.slice(0, 500) } } });
    messages += 1;
  }
  return { messages, items: messages, held: 0 };
}

type FollowUp = { rootId: string; quotedWaId: string; attempt: number; since: Date; items: Array<{ n: number; orderId: number; line: string }> };

/** The combined message these orders were all in within 24 h, so the next ask quotes it and keeps its numbers (B4). */
async function findFollowUp(labId: number, intent: string, orderIds: number[], now: Date): Promise<FollowUp | null> {
  const recent = await prisma.providerBatch.findMany({
    where: { labId, intent, shadow: false, outboundId: { not: null }, createdAt: { gte: new Date(now.getTime() - 24 * 3_600_000) } },
    orderBy: { createdAt: "desc" }, take: 10,
    select: { id: true, items: true, followUpOf: true, outboundId: true, createdAt: true },
  });
  for (const b of recent) {
    const items = b.items as Array<{ n: number; orderId: number; line: string }>;
    if (!orderIds.every((id) => items.some((i) => i.orderId === id))) continue;
    const rootId = b.followUpOf ?? b.id;
    const root = b.followUpOf ? await prisma.providerBatch.findUnique({ where: { id: rootId }, select: { outboundId: true, createdAt: true, items: true } }) : b;
    if (!root?.outboundId) continue;
    const outbound = await prisma.waOutbound.findUnique({ where: { id: root.outboundId }, select: { sentWaMsgId: true } });
    if (!outbound?.sentWaMsgId) continue;
    const attempts = await prisma.providerBatch.count({ where: { OR: [{ id: rootId }, { followUpOf: rootId }] } });
    return { rootId, quotedWaId: outbound.sentWaMsgId, attempt: attempts, since: root.createdAt, items: root.items as FollowUp["items"] };
  }
  return null;
}
