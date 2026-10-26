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
import { opsGroup } from "../ops/group";
import { currentSlot, isSlotOpen, itemLine, localParts } from "@/lib/provider-rules/batching";
import { formatTime, TIME_ZONE } from "@/lib/provider-rules/format";
import { confirmationUrl } from "@/lib/non-api-labs/confirmation-link";
import { fetchOrderContactDetails } from "@/lib/non-api-labs/order-details";
import { labstackWorkerQuery } from "@/lib/db/labstack";
import { actionPageUrl } from "./actionPage";
import { loadDirectory, tierOf } from "../directory";

export const PER_SLOT_CAP = Number(process.env.AGENT_BATCH_PER_SLOT_CAP ?? 3);
export const PER_DAY_CAP = Number(process.env.AGENT_BATCH_PER_DAY_CAP ?? 8);

export type OutboxLine = { n?: number; orderId: number; patientName: string | null; appointment: Date | null; confirmUrl?: string | null; phlebo?: string | null; area?: string | null; labRef?: string | null; mobile?: string | null; milestone?: string | null; dueAt?: Date | string | null; note?: string | null };

export type EnqueueInput = {
  counterparty: string;          // LAB:<id> | MANAGER:<labId> | STORE:<id>
  ask: string;                   // PHLEBO | STATUS | REPORT | UNCONFIRMED | ESCALATION | ETA | OVERDUE | <custom>
  orderId: number; journeyId: string | null; actionId: string | null;
  windowFrom: Date; windowTo: Date; urgent: boolean;
  idemKey: string;
  line: OutboxLine;
  /** Free text for a counterparty that gets a plain message (store alerts, manager notes). */
  text?: string;
  /** Go on the next every-minute flush, no gathering: a store's question, or a chase it triggered. */
  immediate?: boolean;
  /** Anything else the flush needs (an ops post's taskId, a message to quote). */
  extra?: Record<string, unknown>;
};

export async function enqueueOutbox(input: EnqueueInput): Promise<{ id: string; queued: boolean }> {
  try {
    const row = await prisma.agentOutboxItem.create({
      data: {
        counterparty: input.counterparty, ask: input.ask, orderId: input.orderId, journeyId: input.journeyId, actionId: input.actionId,
        windowFrom: input.windowFrom, windowTo: input.windowTo, urgent: input.urgent, idemKey: input.idemKey,
        payload: { line: { ...input.line, appointment: input.line.appointment?.toISOString() ?? null }, text: input.text ?? null, immediate: input.immediate === true, ...(input.extra ?? {}) } as Prisma.InputJsonValue,
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
  // A claim left by a worker that stopped mid-send (a deploy restarts it) goes back to the queue.
  await prisma.agentOutboxItem.updateMany({ where: { status: "SENDING", OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - 5 * 60_000) } }] }, data: { status: "QUEUED", claimedAt: null } }).catch(() => undefined);
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
  const tz = TIME_ZONE();
  const { hour } = localParts(now, tz);
  // Nothing to anyone between 21:00 and 07:00, urgent or not.
  if (hour < 7 || hour >= 21) { result.held += open.length; return result; }
  const ready = open.filter((i) => {
    if (i.windowFrom.getTime() > now.getTime()) return false;
    if (i.counterparty.startsWith("LAB:") && !i.urgent && !isSlotOpen(i.ask, now, tz)) return false; // routine asks keep the slot rhythm
    // A store's reply, or a chase a store triggered, goes now. Other urgent asks gather for ten
    // minutes, so a morning's asks go as one message, not one each.
    const immediate = i.counterparty.startsWith("STORE:") || (i.payload as { immediate?: boolean }).immediate === true;
    if (!immediate && i.urgent && opts.urgentOnly && now.getTime() - i.windowFrom.getTime() < 10 * 60_000) return false;
    if (immediate && !i.urgent && opts.urgentOnly) return true; // store items ride the every-minute flush even when not marked urgent
    return true;
  });
  result.held += open.length - ready.length;

  const groups = new Map<string, Item[]>();
  for (const i of ready) {
    const key = `${i.counterparty}|${i.ask}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  for (const [key, queued] of groups) {
    // Claim before sending: the every-minute urgent flush and the :00/:30 flush must not both send a group.
    const claimed = await prisma.agentOutboxItem.updateMany({ where: { id: { in: queued.map((i) => i.id) }, status: "QUEUED" }, data: { status: "SENDING", claimedAt: new Date() } });
    if (claimed.count === 0) continue;
    const group: Item[] = claimed.count === queued.length ? queued : await prisma.agentOutboxItem.findMany({
      where: { id: { in: queued.map((i) => i.id) }, status: "SENDING" },
      select: { id: true, counterparty: true, ask: true, orderId: true, journeyId: true, actionId: true, windowFrom: true, windowTo: true, urgent: true, payload: true, idemKey: true },
    });
    try {
      const sent = await flushGroup(key, group, now);
      await prisma.agentOutboxItem.updateMany({ where: { id: { in: group.map((i) => i.id) }, status: "SENDING" }, data: { status: "QUEUED" } }); // whatever was held stays queued
      result.messages += sent.messages; result.items += sent.items; result.held += sent.held;
    } catch (error) {
      result.errors += 1;
      console.error(`[Agents] flush ${key} failed:`, error instanceof Error ? error.message : error);
      await prisma.agentOutboxItem.updateMany({ where: { id: { in: group.map((i) => i.id) }, status: "SENDING" }, data: { status: "FAILED" } });
    }
  }
  return result;
}

/**
 * What in a queued group is still worth sending. Dropped: a pre-visit ask after
 * the visit, a report chase older than a week, "running late" to an API lab
 * (sample-at-lab is the API's to report), and a second item for the same order.
 * Shared with scripts/agents-preview-outbox.ts so the preview shows what will go.
 */
/**
 * Orders not worth asking about again: anyone in the lab's group wrote about them in the last
 * 2 hours (our team or the lab), or the lab gave a fact on them in the last 3 hours. On 26 Oct
 * 2026 our team asked about BLR6366990 at 07:00, the lab answered RNR at 07:07, and the bot
 * asked "phlebo on time?" about the same order at 07:11.
 */
async function alreadyInHand(groupJid: string, items: Array<{ orderId: number; payload: unknown }>, now: Date): Promise<Set<number>> {
  const out = new Set<number>();
  const g = await prisma.waGroup.findUnique({ where: { jid: groupJid }, select: { id: true } });
  const ids = items.map((i) => i.orderId);
  const [msgs, facts] = await Promise.all([
    g ? prisma.waMessage.findMany({ where: { groupId: g.id, ts: { gte: new Date(now.getTime() - 2 * 3_600_000) }, NOT: { intent: "AUTOMATED" } }, select: { text: true, orderIds: true } }) : Promise.resolve([]),
    prisma.providerOrderFact.findMany({ where: { orderId: { in: ids }, createdAt: { gte: new Date(now.getTime() - 3 * 3_600_000) }, kind: { in: ["patient_unavailable", "sample_collected", "eta", "phlebo_name", "new_appointment_time", "cannot_fulfil", "sample_missed"] } }, select: { orderId: true } }),
  ]);
  for (const f of facts) out.add(f.orderId);
  for (const i of items) {
    const ref = (i.payload as { line?: { labRef?: string | null } }).line?.labRef?.toUpperCase();
    if (msgs.some((m) => m.orderIds.includes(i.orderId) || m.text.includes(String(i.orderId)) || (ref && m.text.toUpperCase().includes(ref)))) out.add(i.orderId);
  }
  return out;
}

export function partitionQueued<T extends { orderId: number; payload: unknown }>(group: T[], ask: string, now: Date, tier: string | null): { fresh: T[]; stale: T[] } {
  const PRE_VISIT = new Set(["UNCONFIRMED", "PHLEBO", "ETA", "ESCALATION"]);
  const stale: T[] = []; const seen = new Set<number>(); const fresh: T[] = [];
  for (const i of group) {
    const line = (i.payload as { line?: { appointment?: string | null } }).line ?? {};
    const appt = line.appointment ? new Date(line.appointment).getTime() : null;
    // "phlebo on time?" for a 6:00 visit at 7:11 is noise (26 Oct 2026): ETA and phlebo asks end at the visit.
    const pastVisit = appt != null && appt < now.getTime() - (ask === "ETA" || ask === "PHLEBO" ? 0 : 2 * 3_600_000);
    const oldReport = ask === "REPORT" && appt != null && appt < now.getTime() - 30 * 86_400_000;
    const apiOverdue = ask === "OVERDUE" && tier != null && tier !== "C";
    if ((PRE_VISIT.has(ask) && pastVisit) || oldReport || apiOverdue || seen.has(i.orderId)) { stale.push(i); continue; }
    seen.add(i.orderId); fresh.push(i);
  }
  return { fresh, stale };
}

async function flushGroup(key: string, queued: Item[], now: Date): Promise<{ messages: number; items: number; held: number }> {
  let group = queued;
  const [counterparty, ask] = key.split("|");
  const [kind, idText] = counterparty.split(":");
  const id = Number(idText);
  const tz = TIME_ZONE();

  if (kind === "STORE") return flushStore(id, group, now);
  if (kind === "OPS") return flushOps(group, now);
  if (ask === "SCORECARD") return flushScorecard(id, group, now);

  // Never send what no longer makes sense (seen queued on 24 Oct 2026: "phlebo
  // on time?" for a visit a week ago, "please confirm" for a past visit, report
  // chases 14 days old): a pre-visit ask after the visit, a report chase older
  // than a month, and a second rung for an order already in this message.
  const { fresh, stale } = partitionQueued(group, ask, now, kind === "LAB" ? tierOf(await loadDirectory(), id) : null);
  if (stale.length) {
    await prisma.agentOutboxItem.updateMany({ where: { id: { in: stale.map((i) => i.id) } }, data: { status: "DROPPED" } });
    console.log(`[Agents] ${counterparty} ${ask}: dropped ${stale.length} stale or duplicate item(s)`);
  }
  group = fresh;
  if (!group.length) return { messages: 0, items: 0, held: 0 };

  const config = await prisma.nonApiLabConfig.findUnique({ where: { labId: id } });
  if (!config) {
    // Not connected: nothing to send to. Dropped, not failed — Connect the lab on Connections.
    await prisma.agentOutboxItem.updateMany({ where: { id: { in: group.map((i) => i.id) } }, data: { status: "DROPPED" } });
    console.warn(`[Agents] lab ${id} is not connected (no group); ${group.length} item(s) dropped`);
    return { messages: 0, items: 0, held: 0 };
  }
  const toManager = kind === "MANAGER";
  if (!toManager && config.waGroupJid) {
    const answered = await alreadyInHand(config.waGroupJid, group, now);
    if (answered.size) {
      await prisma.agentOutboxItem.updateMany({ where: { id: { in: group.filter((i) => answered.has(i.orderId)).map((i) => i.id) } }, data: { status: "DROPPED" } });
      console.log(`[Agents] ${counterparty} ${ask}: ${answered.size} order(s) already discussed or answered in the group — not asked again`);
      group = group.filter((i) => !answered.has(i.orderId));
      if (!group.length) return { messages: 0, items: 0, held: 0 };
    }
  }
  // No manager number on file: the escalation goes to LabStack's own ops group instead of being
  // dropped (24 escalations a day vanished that way, 26 Oct 2026). A person there calls the lab.
  let toOps = false;
  let opsTarget: { targetJid: string; groupId: string | null } | null = null;
  if (toManager && !config.managerWhatsapp) {
    const ops = await opsGroup();
    if (!ops) {
      await prisma.agentOutboxItem.updateMany({ where: { id: { in: group.map((i) => i.id) } }, data: { status: "DROPPED" } });
      return { messages: 0, items: 0, held: 0 };
    }
    toOps = true; opsTarget = { targetJid: ops.jid, groupId: ops.id };
  }
  const target = toOps ? opsTarget! : toManager ? { targetJid: toDirectJid(config.managerWhatsapp!), groupId: null } : await resolveLabTarget(config, null);

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
    // Which checkpoint is late and since when, for items queued before the line carried it.
    const late = new Map<number, { milestone: string; dueAt: Date }>();
    if (ask === "OVERDUE" || ask === "STATUS") {
      const cps = await prisma.agentCheckpoint.findMany({ where: { journey: { orderId: { in: list.map((i) => i.orderId) } }, status: "BREACHED" }, select: { name: true, dueAt: true, journey: { select: { orderId: true } } }, orderBy: { dueAt: "asc" } });
      const { LABELS } = await import("../journey/step");
      for (const c of cps) if (!late.has(c.journey.orderId)) late.set(c.journey.orderId, { milestone: LABELS[c.name as keyof typeof LABELS] ?? c.name, dueAt: c.dueAt });
    }
    const createdAts = ask === "ESCALATION" ? new Map((await labstackWorkerQuery<{ id: number; createdAt: Date }>(`SELECT id, "createdAt" FROM public."Order" WHERE id = ANY($1::int[])`, [list.map((i) => i.orderId)]).catch(() => [])).map((r) => [r.id, r.createdAt])) : new Map<number, Date>();
    const lines = await Promise.all(list.map(async (i, index) => {
      const p = (i.payload as { line: OutboxLine & { appointment: string | null } }).line;
      const d = details?.get(i.orderId);
      const needsLink = ask === "UNCONFIRMED" || ask === "ESCALATION";
      const link = manual && !toManager ? await actionPageUrl(i.orderId).catch(() => null) : null;
      return itemLine(ask, {
        n: index + 1, orderId: i.orderId, patientName: p.patientName, appointment: p.appointment ? new Date(p.appointment) : null,
        area: p.area ?? d?.area ?? null, phlebo: p.phlebo ?? null, labRef: p.labRef ?? d?.labRef ?? null, mobile: p.mobile ?? d?.patientMobile ?? null,
        note: p.note ?? null, milestone: p.milestone ?? late.get(i.orderId)?.milestone ?? null, dueAt: p.dueAt ? new Date(p.dueAt) : late.get(i.orderId)?.dueAt, createdAt: createdAts.get(i.orderId), confirmUrl: link ?? (needsLink ? await confirmationUrl(i.orderId).catch(() => null) : null),
      }, now, tz);
    }));
    const followUp = toManager ? null : await findFollowUp(id, ask, list.map((i) => i.orderId), now);
    // A follow-up ("still open", "reminder") never within an hour of the last message on
    // that root: Thyrocare got four in 30 minutes on 24 Oct 2026. The items stay queued.
    if (followUp && now.getTime() - followUp.lastAt.getTime() < 60 * 60_000) { held += list.length; return; }
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
      // Each number carries its order: "still open: 1" alone made Redcliffe ask "could you clarify
      // the exact issue?" (26 Oct 2026) — the quoted message is hours up the chat.
      const named = list
        .map((i) => ({ n: original.get(i.orderId)!.n, ref: details?.get(i.orderId)?.labRef ?? (i.payload as { line?: { labRef?: string | null } }).line?.labRef ?? null, orderId: i.orderId }))
        .sort((x, y) => x.n - y.n)
        .map((x) => `${x.n} (${x.ref ? `${x.ref} · ` : ""}#${x.orderId})`);
      text = renderLabTemplate(t.isActive ? t.body : "{{coordinator}} still open: {{numbers}}", {
        lab_name: config.labName, coordinator: mention.text, count: String(list.length), numbers: named.join(", "), since: formatTime(followUp.since),
      });
    } else if (toOps) {
      text = `🔴 *${config.labName}: no answer on ${list.length} ${list.length === 1 ? "order" : "orders"}* — no manager number on file\n\n${lines.join("\n")}\n\nPlease call the lab, or reply *on it*.`;
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
        recipient: toOps ? "OPS" : toManager ? "MANAGER" : "LAB", itemCount: list.length, text,
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

  // Ten per message for urgent asks too (07:00 can release a night's worth at once); the rest next minute.
  if (urgent.length) { await sendItems(urgent.slice(0, 10), true); held += Math.max(0, urgent.length - 10); }
  if (routine.length) {
    if (!toManager && (sentToday >= PER_DAY_CAP || sentThisSlot >= PER_SLOT_CAP)) { held += routine.length; }
    else {
      // Short lists get answered (CHAT-REVIEW-OCT-2026): ten per message, the rest next slot.
      const take = routine.slice(0, 10);
      await sendItems(take, false);
      held += routine.length - take.length;
    }
  }
  return { messages, items, held };
}

/**
 * The weekly scorecard (brain/scorecard.ts): plain text to the lab group, the
 * coordinator @mentioned, under the same day and slot caps as any ask, and a
 * provider_batches row with intent SCORECARD so the ledger shows it. One per lab
 * per week (the outbox idemKey); never a numbered list, never a follow-up.
 */
async function flushScorecard(labId: number, group: Item[], now: Date): Promise<{ messages: number; items: number; held: number }> {
  const tz = TIME_ZONE();
  const config = await prisma.nonApiLabConfig.findUnique({ where: { labId } });
  if (!config) {
    await prisma.agentOutboxItem.updateMany({ where: { id: { in: group.map((i) => i.id) } }, data: { status: "DROPPED" } });
    console.warn(`[Agents] lab ${labId} is not connected (no group); scorecard dropped`);
    return { messages: 0, items: 0, held: 0 };
  }
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const sentToday = await prisma.providerBatch.count({ where: { labId, shadow: false, createdAt: { gte: new Date(dayStart.getTime() - 5.5 * 3_600_000) } } });
  const sentThisSlot = await prisma.providerBatch.count({ where: { labId, shadow: false, recipient: "LAB", createdAt: { gte: currentSlot(now, tz) } } });
  if (sentToday >= PER_DAY_CAP || sentThisSlot >= PER_SLOT_CAP) return { messages: 0, items: 0, held: group.length };
  const [item, ...extra] = group;
  if (extra.length) await prisma.agentOutboxItem.updateMany({ where: { id: { in: extra.map((i) => i.id) } }, data: { status: "DROPPED" } });
  const raw = (item.payload as { text?: string | null }).text;
  if (!raw) { await prisma.agentOutboxItem.update({ where: { id: item.id }, data: { status: "DROPPED" } }); return { messages: 0, items: 0, held: 0 }; }
  const target = await resolveLabTarget(config, null);
  const people = await coordinatorsFor(config, now);
  const mention = people.map((c) => `@${c.jid.split("@")[0]}`).join(" ") || "Team";
  const text = raw.replace("{{coordinator}}", mention);
  const outbound = await sendWhatsApp({ targetJid: target.targetJid, groupId: target.groupId, text, mentions: people.map((c) => c.jid), now });
  const batch = await prisma.providerBatch.create({
    data: {
      labId, intent: "SCORECARD", slotAt: currentSlot(now, tz), shadow: false, outboundId: outbound.id, recipient: "LAB", itemCount: 1, text,
      items: [{ n: 1, orderId: 0, ruleId: "agent:scorecard", occurrence: 1, communicationId: null, line: text }] as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  await prisma.agentOutboxItem.update({ where: { id: item.id }, data: { status: "SENT", batchId: batch.id, outboundId: outbound.id, sentAt: now } });
  return { messages: 1, items: 1, held: 0 };
}

/** A store counterparty gets plain text per item (answers, alerts, warnings), never a numbered ask. */
/** Posts to LabStack's own ops group: tasks, escalations, questions, cancellations (ops/post.ts). */
async function flushOps(group: Item[], now: Date) {
  const g = await opsGroup();
  if (!g) { await prisma.agentOutboxItem.updateMany({ where: { id: { in: group.map((i) => i.id) } }, data: { status: "DROPPED" } }); return { messages: 0, items: 0, held: 0 }; }
  let messages = 0;
  for (const i of group) {
    const p = i.payload as { text?: string | null; quotedWaId?: string | null; taskId?: number | null };
    if (!p.text) { await prisma.agentOutboxItem.update({ where: { id: i.id }, data: { status: "DROPPED" } }); continue; }
    const outbound = await sendWhatsApp({ targetJid: g.jid, groupId: g.id, text: p.text, quotedWaId: p.quotedWaId ?? null, now });
    await prisma.agentOutboxItem.update({ where: { id: i.id }, data: { status: "SENT", outboundId: outbound.id, sentAt: now } });
    if (i.actionId) await prisma.agentAction.update({ where: { id: i.actionId }, data: { outcome: "EXECUTED" } }).catch(() => undefined);
    if (i.journeyId) await prisma.agentJourneyEvent.create({ data: { journeyId: i.journeyId, at: now, kind: "ops_post", actor: "AGENT", applied: true, payload: { kind: i.ask, taskId: p.taskId ?? null, text: p.text.slice(0, 500) } } });
    messages += 1;
  }
  return { messages, items: messages, held: 0 };
}

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

type FollowUp = { rootId: string; quotedWaId: string; attempt: number; since: Date; lastAt: Date; items: Array<{ n: number; orderId: number; line: string }> };

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
    const last = await prisma.providerBatch.findFirst({ where: { OR: [{ id: rootId }, { followUpOf: rootId }] }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    return { rootId, quotedWaId: outbound.sentWaMsgId, attempt: attempts, since: root.createdAt, lastAt: last?.createdAt ?? root.createdAt, items: root.items as FollowUp["items"] };
  }
  return null;
}
