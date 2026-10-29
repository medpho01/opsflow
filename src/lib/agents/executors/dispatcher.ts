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
import { recordSend, styledBody } from "@/lib/agents/style";
import { humanSpokeAbout, STORE_ACK_RE } from "../store/scope";
import { coordinatorsFor } from "@/lib/wa/coordinators";
import { opsGroup } from "../ops/group";
import { fetchOrderSnapshots } from "../journey/window";
import { reached, type OrderSnapshot } from "../journey/policy";
import { atLocal, currentSlot, itemLine, localParts } from "@/lib/provider-rules/batching";
import { loadLiveSops, paramsFor } from "../sop/load";
import { formatTime, TIME_ZONE } from "@/lib/provider-rules/format";
import { confirmationUrl } from "@/lib/non-api-labs/confirmation-link";
import { fetchOrderContactDetails } from "@/lib/non-api-labs/order-details";
import { labstackWorkerQuery } from "@/lib/db/labstack";
import { actionPageUrl } from "./actionPage";
import { loadDirectory, tierOf } from "../directory";

/** Scorecard caps only; asks use the SOP's batching params (gatherMin, perHourCap, perDayCap). */
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

/** "urine sample collection" when every order owes the same sample, else "sample collection". */
export function recollectTitle(notes: string[]): string {
  const samples = new Set(notes.map((n) => /\b(urine|stool|sputum|swab)\b/i.exec(n)?.[1]?.toLowerCase() ?? "sample"));
  const one = samples.size === 1 ? [...samples][0] : "sample";
  return one === "sample" ? "sample collection" : `${one} sample collection`;
}

/** Drop queued items about an order (reschedule, cancel, answered). */
export async function withdrawOutbox(orderId: number, reason: string, asks?: string[], opts: { keepForStore?: boolean } = {}) {
  const where = { orderId, status: "QUEUED", ...(asks ? { ask: { in: asks } } : {}) };
  const all = await prisma.agentOutboxItem.findMany({ where, select: { id: true, counterparty: true, payload: true } });
  // keepForStore: a lab ask the store's own question started stays (it carries immediate: true).
  const rows = opts.keepForStore ? all.filter((r) => !(r.counterparty.startsWith("LAB:") && (r.payload as { immediate?: boolean } | null)?.immediate === true)) : all;
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

type Item = Prisma.AgentOutboxItemGetPayload<{ select: { id: true; counterparty: true; ask: true; orderId: true; journeyId: true; actionId: true; windowFrom: true; windowTo: true; urgent: true; payload: true; idemKey: true; createdAt: true } }>;

/**
 * Send what is due. `urgentOnly` runs every minute for items that cannot wait;
 * the full flush runs at :00 and :30.
 */
export async function flushOutbox(now = new Date(), opts: { urgentOnly?: boolean } = {}): Promise<FlushResult> {
  const result: FlushResult = { messages: 0, items: 0, held: 0, dropped: 0, errors: 0 };
  // A claim left by a worker that stopped mid-send (a deploy restarts it) goes back to the queue.
  await prisma.agentOutboxItem.updateMany({ where: { status: "SENDING", OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - 5 * 60_000) } }] }, data: { status: "QUEUED", claimedAt: null } }).catch(() => undefined);
  // Every flush looks at everything queued: a routine ask goes as soon as it has gathered, not at
  // the next :00/:30 (29 Oct 2026). The SOP says how long to gather and how much a lab may hear.
  const labParams = paramsFor((await loadLiveSops().catch(() => new Map())).get("LAB") ?? null, { labTier: null, labId: null, storeId: null, orderType: "HOME_SAMPLE" });
  const batching = { ...(labParams?.batching ?? { gatherMin: 15, perHourCap: 3, perDayCap: 10, minGapMin: 20, reportMaxAgeDays: 5 }), apiReportChase: labParams?.reportChase?.apiLabs ?? false };
  const items = await prisma.agentOutboxItem.findMany({
    where: { status: "QUEUED" },
    select: { id: true, counterparty: true, ask: true, orderId: true, journeyId: true, actionId: true, windowFrom: true, windowTo: true, urgent: true, payload: true, idemKey: true, createdAt: true },
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
    // A routine lab ask gathers for a while so a burst of lateness is one combined message, then goes.
    if (i.counterparty.startsWith("LAB:") && !i.urgent && now.getTime() - i.windowFrom.getTime() < batching.gatherMin * 60_000) return false;
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
      select: { id: true, counterparty: true, ask: true, orderId: true, journeyId: true, actionId: true, windowFrom: true, windowTo: true, urgent: true, payload: true, idemKey: true, createdAt: true },
    });
    try {
      const sent = await flushGroup(key, group, now, batching);
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
async function alreadyInHand(groupJid: string, items: Array<{ orderId: number; payload: unknown }>, now: Date, ask = ""): Promise<Set<number>> {
  const out = new Set<number>();
  const g = await prisma.waGroup.findUnique({ where: { jid: groupJid }, select: { id: true } });
  const ids = items.map((i) => i.orderId);
  // For a re-collection, "sample missed" and the morning's "collected" are why it is asked, not an answer.
  const answering = ask === "RECOLLECT" ? ["eta", "new_appointment_time", "cannot_fulfil"] : ["patient_unavailable", "sample_collected", "eta", "phlebo_name", "new_appointment_time", "cannot_fulfil", "sample_missed"];
  const [msgs, facts] = await Promise.all([
    g ? prisma.waMessage.findMany({ where: { groupId: g.id, ts: { gte: new Date(now.getTime() - (ask === "RECOLLECT" ? 30 * 60_000 : 2 * 3_600_000)) }, NOT: { intent: "AUTOMATED" } }, select: { text: true, orderIds: true, replyToWaId: true } }) : Promise.resolve([]),
    prisma.providerOrderFact.findMany({ where: { orderId: { in: ids }, createdAt: { gte: new Date(now.getTime() - (ask === "RECOLLECT" ? 30 * 60_000 : 3 * 3_600_000)) }, kind: { in: answering } }, select: { orderId: true } }),
  ]);
  for (const f of facts) out.add(f.orderId);
  // A lab answering in its own words by quoting a list that named the order ("Client booked slot of
  // 10am" under the team's list, 29 Oct 2026) has answered it, though it names no id.
  const quotedIds = [...new Set(msgs.map((m) => m.replyToWaId).filter((x): x is string => !!x))];
  const quoted = quotedIds.length ? await prisma.waMessage.findMany({ where: { waMsgId: { in: quotedIds } }, select: { waMsgId: true, text: true } }) : [];
  const quotedText = new Map(quoted.map((q) => [q.waMsgId, (q.text ?? "").toUpperCase()]));
  for (const i of items) {
    const ref = (i.payload as { line?: { labRef?: string | null } }).line?.labRef?.toUpperCase();
    const names = (t: string) => t.includes(String(i.orderId)) || (!!ref && t.toUpperCase().includes(ref));
    if (msgs.some((m) => m.orderIds.includes(i.orderId) || names(m.text) || (!!m.replyToWaId && names(quotedText.get(m.replyToWaId) ?? "")))) out.add(i.orderId);
  }
  return out;
}

/**
 * Has the console already settled what this ask is about? Checked at send time, so a message
 * queued overnight never goes out about an order LabStack moved since (27 Oct 2026). Pure.
 */
export function settledByConsole(ask: string, o: Pick<OrderSnapshot, "orderStatus" | "phleboName">): string | null {
  const s = o.orderStatus;
  const cancelled = s === "CANCELLED" || s === "CANCELED";
  const collected = reached(s, "SAMPLE_COLLECTED");
  const phleboKnown = !!o.phleboName.trim() || s === "PHLEBO_ASSIGNED" || s === "PHLEBO_STARTED" || collected;
  const visitOver = collected || s === "PATIENT_MISSED" || cancelled;
  switch (ask) {
    case "PHLEBO": return phleboKnown ? `phlebo known (${s})` : visitOver ? `visit over (${s})` : null;
    case "UNCONFIRMED": return reached(s, "ORDER_SCHEDULED") || phleboKnown ? `confirmed (${s})` : cancelled ? "cancelled" : null;
    case "ETA": return visitOver ? `visit over (${s})` : null;
    case "STATUS": return visitOver ? `settled (${s})` : null;
    // A missed urine/stool sample on an order the console calls collected (the blood went): the
    // console cannot settle it (29 Oct 2026: every re-collection ask was dropped as "settled").
    case "RECOLLECT": return cancelled ? "cancelled" : null;
    case "ESCALATION": return visitOver ? `settled (${s})` : s === "PHLEBO_STARTED" ? "phlebo on the way" : null;
    case "OVERDUE": return reached(s, "SAMPLE_DELIVERED") || cancelled ? `settled (${s})` : null;
    case "REPORT": return s === "REPORT_DELIVERED" || cancelled ? `settled (${s})` : null;
    default: return cancelled ? "cancelled" : null;
  }
}

export function partitionQueued<T extends { orderId: number; payload: unknown }>(group: T[], ask: string, now: Date, tier: string | null, reportMaxAgeDays = 30): { fresh: T[]; stale: T[] } {
  const PRE_VISIT = new Set(["UNCONFIRMED", "PHLEBO", "ETA", "ESCALATION"]);
  const stale: T[] = []; const seen = new Set<number>(); const fresh: T[] = [];
  for (const i of group) {
    const line = (i.payload as { line?: { appointment?: string | null } }).line ?? {};
    const appt = line.appointment ? new Date(line.appointment).getTime() : null;
    // "phlebo on time?" for a 6:00 visit at 7:11 is noise (26 Oct 2026): ETA and phlebo asks end at the visit.
    const pastVisit = appt != null && appt < now.getTime() - (ask === "ETA" || ask === "PHLEBO" ? 0 : 2 * 3_600_000);
    // …and "phlebo on time?" starts near the visit, never a day ahead (29 Oct 2026, #95010: "tomorrow 8:30 am").
    const etaEarly = ask === "ETA" && appt != null && appt > now.getTime() + 3 * 3_600_000;
    // A report overdue for days is a person's job — the lab group is for today's work (SOP batching.reportMaxAgeDays).
    const oldReport = ask === "REPORT" && appt != null && appt < now.getTime() - reportMaxAgeDays * 86_400_000;
    const apiOverdue = ask === "OVERDUE" && tier != null && tier !== "C";
    if ((PRE_VISIT.has(ask) && pastVisit) || etaEarly || oldReport || apiOverdue || seen.has(i.orderId)) { stale.push(i); continue; }
    seen.add(i.orderId); fresh.push(i);
  }
  return { fresh, stale };
}

type Batching = { gatherMin: number; perHourCap: number; perDayCap: number; minGapMin?: number; reportMaxAgeDays?: number; apiReportChase?: boolean };
async function flushGroup(key: string, queued: Item[], now: Date, batching: Batching = { gatherMin: 15, perHourCap: 3, perDayCap: 10, minGapMin: 20, reportMaxAgeDays: 5 }): Promise<{ messages: number; items: number; held: number }> {
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
  const tier = kind === "LAB" ? tierOf(await loadDirectory(), id) : null;
  const partitioned = partitionQueued(group, ask, now, tier, batching.reportMaxAgeDays ?? 5);
  // Report chases to API labs are paused (SOP reportChase.apiLabs): only one a store asked for goes.
  const pausedReports = ask === "REPORT" && tier != null && tier !== "C" && !batching.apiReportChase ? partitioned.fresh.filter((i) => (i.payload as { immediate?: boolean }).immediate !== true) : [];
  const fresh = partitioned.fresh.filter((i) => !pausedReports.includes(i));
  const stale = [...partitioned.stale, ...pausedReports];
  if (stale.length) {
    await prisma.agentOutboxItem.updateMany({ where: { id: { in: stale.map((i) => i.id) } }, data: { status: "DROPPED" } });
    console.log(`[Agents] ${counterparty} ${ask}: dropped ${stale.length} stale or duplicate item(s)`);
  }
  group = fresh;
  if (!group.length) return { messages: 0, items: 0, held: 0 };
  // The console, read now: what it has settled since the item was queued is not sent.
  const snapshots = await fetchOrderSnapshots(group.map((i) => i.orderId)).catch(() => new Map<number, OrderSnapshot>());
  const settled = group.filter((i) => { const o = snapshots.get(i.orderId); return !!o && !!settledByConsole(ask, o); });
  if (settled.length) {
    await prisma.agentOutboxItem.updateMany({ where: { id: { in: settled.map((i) => i.id) } }, data: { status: "DROPPED" } });
    console.log(`[Agents] ${counterparty} ${ask}: ${settled.length} item(s) settled by the console since queued — not sent`);
    group = group.filter((i) => !settled.includes(i));
    if (!group.length) return { messages: 0, items: 0, held: 0 };
  }

  const config = await prisma.nonApiLabConfig.findUnique({ where: { labId: id } });
  if (!config) {
    // Not connected: nothing to send to. Dropped, not failed — Connect the lab on Connections.
    await prisma.agentOutboxItem.updateMany({ where: { id: { in: group.map((i) => i.id) } }, data: { status: "DROPPED" } });
    console.warn(`[Agents] lab ${id} is not connected (no group); ${group.length} item(s) dropped`);
    return { messages: 0, items: 0, held: 0 };
  }
  // No manager number on file: the escalation is a firmer ask in the lab's own group (28 Oct 2026:
  // "no answer on 6 orders" went to the ops group while the lab was never told it was escalated).
  const groupEscalation = kind === "MANAGER" && !config.managerWhatsapp;
  const toManager = kind === "MANAGER" && !groupEscalation;
  if (!toManager && config.waGroupJid) {
    const answered = await alreadyInHand(config.waGroupJid, group, now, ask);
    if (answered.size) {
      await prisma.agentOutboxItem.updateMany({ where: { id: { in: group.filter((i) => answered.has(i.orderId)).map((i) => i.id) } }, data: { status: "DROPPED" } });
      console.log(`[Agents] ${counterparty} ${ask}: ${answered.size} order(s) already discussed or answered in the group — not asked again`);
      group = group.filter((i) => !answered.has(i.orderId));
      if (!group.length) return { messages: 0, items: 0, held: 0 };
    }
  }
  const toOps = false;
  const target = toManager ? { targetJid: toDirectJid(config.managerWhatsapp!), groupId: null } : await resolveLabTarget(config, null);

  // Caps (SOP batching): per day per lab and per rolling hour, urgent exempt.
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const sentToday = await prisma.providerBatch.count({ where: { labId: id, shadow: false, createdAt: { gte: new Date(dayStart.getTime() - 5.5 * 3_600_000) } } });
  const sentLastHour = await prisma.providerBatch.count({ where: { labId: id, shadow: false, recipient: "LAB", createdAt: { gte: new Date(now.getTime() - 3_600_000) } } });
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
    const itemStyle = await styledBody("BATCH_ITEM", counterparty);
    const lines = await Promise.all(list.map(async (i, index) => {
      const p = (i.payload as { line: OutboxLine & { appointment: string | null } }).line;
      const d = details?.get(i.orderId);
      const needsLink = ask === "UNCONFIRMED" || ask === "ESCALATION";
      const link = manual && !toManager ? await actionPageUrl(i.orderId).catch(() => null) : null;
      return itemLine(ask, {
        n: index + 1, orderId: i.orderId, patientName: p.patientName, appointment: p.appointment ? new Date(p.appointment) : null,
        area: p.area ?? d?.area ?? null, phlebo: p.phlebo ?? null, labRef: p.labRef ?? d?.labRef ?? null, mobile: p.mobile ?? d?.patientMobile ?? null,
        note: p.note ?? null, milestone: p.milestone ?? late.get(i.orderId)?.milestone ?? null, dueAt: p.dueAt ? new Date(p.dueAt) : late.get(i.orderId)?.dueAt, createdAt: createdAts.get(i.orderId), confirmUrl: link ?? (needsLink ? await confirmationUrl(i.orderId).catch(() => null) : null),
      }, now, tz, itemStyle.body);
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
    const used: Array<{ key: string; variantId: string | null }> = [{ key: "BATCH_ITEM", variantId: itemStyle.variantId }];
    if (followUp) {
      const original = new Map(followUp.items.map((it) => [it.orderId, it]));
      numbers = list.map((i) => original.get(i.orderId)!.n);
      storedLines = list.map((i) => original.get(i.orderId)!.line);
      const followKey = followUp.attempt === 1 ? BATCH_FOLLOW_UP_TEMPLATE : BATCH_FOLLOW_UP_FIRM_TEMPLATE;
      const t = await styledBody(followKey, counterparty, await ensureTemplate(followKey));
      used[0] = { key: followKey, variantId: t.variantId };
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
      const key = groupEscalation ? "BATCH_ESCALATION_GROUP" : BATCH_TEMPLATE_BY_INTENT[ask] ?? BATCH_GENERIC_TEMPLATE;
      const t = await styledBody(key, counterparty, await ensureTemplate(key));
      used.push({ key, variantId: t.variantId });
      text = renderLabTemplate(t.body, {
        lab_name: config.labName, manager_name: config.managerName ?? "there", coordinator: mention.text,
        count: String(list.length), orders_word: list.length === 1 ? "order" : "orders", items: lines.join("\n"), batch_title: ask === "RECOLLECT" ? recollectTitle(list.map((i) => (i.payload as { line?: { note?: string | null } }).line?.note ?? "")) : ask.toLowerCase().replace("_", " "),
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
    if (!toOps) for (const s of used) await recordSend({ key: s.key, variantId: s.variantId, counterparty, groupId: target.groupId, outboundId: outbound.id, orderIds: list.map((i) => i.orderId), sentAt: now });
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
    const lastToLab = await prisma.providerBatch.findFirst({ where: { labId: id, shadow: false, recipient: "LAB" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    const tooSoon = !!lastToLab && now.getTime() - lastToLab.createdAt.getTime() < (batching.minGapMin ?? 20) * 60_000;
    if (!toManager && (sentToday >= batching.perDayCap || sentLastHour >= batching.perHourCap || tooSoon)) { held += routine.length; }
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
  const sentLastHour = await prisma.providerBatch.count({ where: { labId, shadow: false, recipient: "LAB", createdAt: { gte: new Date(now.getTime() - 3_600_000) } } });
  if (sentToday >= PER_DAY_CAP || sentLastHour >= PER_SLOT_CAP) return { messages: 0, items: 0, held: group.length };
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
const OPS_HEADERS: Record<string, string> = { OPS_TASK: "📌 *Tasks for the team*", OPS_ESCALATION: "🔴 *Escalations*", OPS_THREAD: "⏳ *Stores waiting*", OPS_QUESTION: "❓ *Questions asked of us in lab groups*", OPS_CANCEL: "⛔ *Cancellations*" };

/**
 * Posts to LabStack's own ops group: tasks, escalations, questions, cancellations (ops/post.ts).
 * Several of one kind due together go as ONE numbered message, ten at a time (80 stuck orders in a
 * day are one post an hour, not 80 — 27 Oct 2026); a reply "on it #<task>" or "done #<order>"
 * names the one it means.
 */
async function flushOps(group: Item[], now: Date) {
  const g = await opsGroup();
  if (!g) { await prisma.agentOutboxItem.updateMany({ where: { id: { in: group.map((i) => i.id) } }, data: { status: "DROPPED" } }); return { messages: 0, items: 0, held: 0 }; }
  const ready = group.filter((i) => !!(i.payload as { text?: string | null }).text);
  const empty = group.filter((i) => !(i.payload as { text?: string | null }).text);
  if (empty.length) await prisma.agentOutboxItem.updateMany({ where: { id: { in: empty.map((i) => i.id) } }, data: { status: "DROPPED" } });
  const list = ready.slice(0, 10);
  if (!list.length) return { messages: 0, items: 0, held: 0 };
  const texts = list.map((i) => String((i.payload as { text: string }).text));
  const single = list.length === 1;
  const strip = (t: string) => t.replace(/\n+Reply \*on it\*[^\n]*$/i, "").trim();
  const text = single ? texts[0]
    : `${OPS_HEADERS[list[0].ask] ?? "*For the team*"} (${list.length})\n\n${texts.map((t, n) => `${n + 1}. ${strip(t).replace(/\n+/g, "\n   ")}`).join("\n\n")}\n\nReply *on it #<task or order>* to take one, *done #<task or order>* when finished.`;
  const quoted = single ? (list[0].payload as { quotedWaId?: string | null }).quotedWaId ?? null : null;
  const outbound = await sendWhatsApp({ targetJid: g.jid, groupId: g.id, text, quotedWaId: quoted, now });
  await prisma.agentOutboxItem.updateMany({ where: { id: { in: list.map((i) => i.id) } }, data: { status: "SENT", outboundId: outbound.id, sentAt: now } });
  await prisma.agentAction.updateMany({ where: { id: { in: list.map((i) => i.actionId).filter((x): x is string => !!x) } }, data: { outcome: "EXECUTED" } }).catch(() => undefined);
  for (const i of list) {
    if (!i.journeyId) continue;
    const p = i.payload as { taskId?: number | null; text: string };
    await prisma.agentJourneyEvent.create({ data: { journeyId: i.journeyId, at: now, kind: "ops_post", actor: "AGENT", applied: true, payload: { kind: i.ask, taskId: p.taskId ?? null, combined: !single, text: p.text.slice(0, 500) } } });
  }
  return { messages: 1, items: list.length, held: ready.length - list.length };
}

const ACK_HOLD_MS = 3 * 60_000;
/** A substantive answer waits this long for a person who may already be typing. */
export const ANSWER_HOLD_MS = 90_000;
/** Replies the desk may send on one order in a day before a person is tagged instead. */
export const STORE_REPLIES_PER_ORDER_PER_DAY = 2;

/**
 * Why a store reply should not go after all (28 Oct 2026, Plum): the same words went to the
 * same order within a day ("checking with Suburban…" twice, 29 minutes apart); or it only says
 * we are on it while a team member answered in the group within minutes before or after it
 * ("Working on it" at 15:07, the bot's "checking with…" at 15:07). An "on it" waits three
 * minutes for that person before it goes.
 */
export function storeReplyRedundant(input: { text: string; orderId: number; createdAt: Date; now: Date; sameTextSent: boolean; teamAnswered: boolean; holdMs?: number }): "duplicate" | "team answered" | "hold" | null {
  if (input.orderId > 0 && input.sameTextSent) return "duplicate";
  const hold = input.holdMs ?? (STORE_ACK_RE.test(input.text) ? ACK_HOLD_MS : 0);
  if (!hold) return null;
  if (input.now.getTime() - input.createdAt.getTime() < hold) return "hold";
  return input.teamAnswered ? "team answered" : null;
}

async function flushStore(storeId: number, group: Item[], now: Date) {
  const g = await prisma.waGroup.findFirst({ where: { storeId, role: "SUPPORT", archivedAt: null, active: true }, select: { id: true, jid: true } });
  if (!g) { await prisma.agentOutboxItem.updateMany({ where: { id: { in: group.map((i) => i.id) } }, data: { status: "DROPPED" } }); return { messages: 0, items: 0, held: 0 }; }
  let messages = 0; let held = 0;
  let isTeam: ((sender: string, jid: string | null) => unknown) | null = null;
  for (const i of group) {
    const text = (i.payload as { text?: string | null }).text;
    if (!text) { await prisma.agentOutboxItem.update({ where: { id: i.id }, data: { status: "DROPPED" } }); continue; }
    const quoted = (i.payload as { quotedWaId?: string | null }).quotedWaId ?? null;
    const mentions = (i.payload as { mentions?: string[] }).mentions ?? [];
    const sameTextSent = i.orderId > 0 && !!(await prisma.agentOutboxItem.findFirst({ where: { counterparty: i.counterparty, orderId: i.orderId, status: "SENT", sentAt: { gte: new Date(now.getTime() - 24 * 3_600_000) }, payload: { path: ["text"], equals: text } }, select: { id: true } }).catch(() => null));
    // Every reply about an order waits a short moment (an ack three minutes, an answer ninety seconds)
    // and yields to a person who spoke about the order in the group meanwhile — a team member, or
    // anyone typing by hand from the ops number (29 Oct 2026: "Earliest 10:15 AM" at 9:09, the desk
    // answered the same question at 9:11).
    // Lab news relayed to the store waits the same 90 s: the team often relays it first (29 Oct 2026,
    // #95010 — the head of ops had already told Plum when the desk's relay went).
    const isAnswer = ["STORE_REPLY", "ACK", "STORE_ALERT"].includes(i.ask) && i.orderId > 0;
    const holdMs = STORE_ACK_RE.test(text) ? ACK_HOLD_MS : isAnswer ? ANSWER_HOLD_MS : 0;
    let teamAnswered = false;
    if (holdMs && now.getTime() - i.createdAt.getTime() >= holdMs) {
      if (!isTeam) { const { loadTeam, makeTeamMatcher } = await import("@/lib/wa/team"); isTeam = makeTeamMatcher(await loadTeam()); }
      teamAnswered = await humanSpokeAbout({ groupId: g.id, orderId: i.orderId, quotedWaId: quoted, from: new Date(i.createdAt.getTime() - (i.ask === "STORE_ALERT" ? 30 : 5) * 60_000), to: now, isTeam });
    }
    let redundant: string | null = storeReplyRedundant({ text, orderId: i.orderId, createdAt: i.createdAt, now, sameTextSent, teamAnswered, holdMs });
    if (redundant === "hold") { held += 1; continue; }
    // A console alert right after a team member told the store the same thing is noise (28 Oct 2026:
    // Deepali confirmed two bookings at 17:11; "the lab has rescheduled" followed at 17:16).
    if (!redundant && i.ask === "STORE_ALERT" && i.orderId > 0) {
      if (!isTeam) { const { loadTeam, makeTeamMatcher } = await import("@/lib/wa/team"); isTeam = makeTeamMatcher(await loadTeam()); }
      if (await humanSpokeAbout({ groupId: g.id, orderId: i.orderId, from: new Date(i.createdAt.getTime() - 30 * 60_000), to: i.createdAt, isTeam })) redundant = "team answered";
    }
    // Two replies on one order in a day is the desk's limit; the third means the order needs a
    // person, who is tagged instead (28 Oct 2026: #94284 heard "checking", "expected by", "overdue").
    if (!redundant && ["STORE_REPLY", "ACK"].includes(i.ask) && i.orderId > 0) {
      const dayStart = atLocal(now, TIME_ZONE(), 0, 0);
      const today = await prisma.agentOutboxItem.count({ where: { counterparty: i.counterparty, orderId: i.orderId, ask: { in: ["STORE_REPLY", "ACK"] }, status: "SENT", sentAt: { gte: dayStart } } }).catch(() => 0);
      if (today >= STORE_REPLIES_PER_ORDER_PER_DAY) {
        redundant = "third reply today — handed to the team";
        const { handoffTargets } = await import("./storeReply");
        const { addressedTeamMember, mentionJid } = await import("../store/scope");
        const team = await (await import("@/lib/wa/team")).loadTeam();
        const jids = await handoffTargets({ groupId: g.id, orderId: i.orderId, quotedWaId: quoted, isTeam: isTeam ?? (await import("@/lib/wa/team")).makeTeamMatcher(team), mentioned: async (t) => (await addressedTeamMember(t, team).catch(() => null))?.ids.map(mentionJid) ?? [] }).catch(() => [] as string[]);
        const who = jids.map((j) => `@${j.split("@")[0]}`).join(" ") || "Team";
        if (process.env.AGENT_HANDOFF_TAG === "1") await enqueueOutbox({ counterparty: i.counterparty, ask: "STORE_HANDOFF", orderId: i.orderId, journeyId: i.journeyId, actionId: null, windowFrom: now, windowTo: new Date(now.getTime() + 6 * 3_600_000), urgent: true, immediate: true, idemKey: `handoff-cap:${i.counterparty}:${i.orderId}:${dayStart.toISOString().slice(0, 10)}`, line: { orderId: i.orderId, patientName: null, appointment: null }, text: `${who} — #${i.orderId}: the store is still asking and the desk has answered twice today, please take this one.`, extra: { quotedWaId: quoted, mentions: jids } }).catch(() => undefined);
      }
    }
    if (redundant) {
      await prisma.agentOutboxItem.update({ where: { id: i.id }, data: { status: "DROPPED" } });
      if (i.actionId) await prisma.agentAction.update({ where: { id: i.actionId }, data: { outcome: "BLOCKED", blockedBy: `not sent: ${redundant}` } }).catch(() => undefined);
      continue;
    }
    const outbound = await sendWhatsApp({ targetJid: g.jid, groupId: g.id, text, quotedWaId: quoted, mentions, now });
    await prisma.agentOutboxItem.update({ where: { id: i.id }, data: { status: "SENT", outboundId: outbound.id, sentAt: now } });
    const style = (i.payload as { style?: { key: string; variantId: string | null } }).style;
    if (style?.key) await recordSend({ key: style.key, variantId: style.variantId, counterparty: `STORE:${storeId}`, groupId: g.id, outboundId: outbound.id, orderIds: i.orderId ? [i.orderId] : [], sentAt: now });
    if (i.actionId) await prisma.agentAction.update({ where: { id: i.actionId }, data: { outcome: "EXECUTED" } });
    if (i.journeyId) await prisma.agentJourneyEvent.create({ data: { journeyId: i.journeyId, at: now, kind: "store_message", actor: "AGENT", applied: true, payload: { ask: i.ask, text: text.slice(0, 500) } } });
    messages += 1;
  }
  return { messages, items: messages, held };
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
