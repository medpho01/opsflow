/**
 * The weekly lab scorecard (Ops Head's "can do today" list, 25 Oct 2026, item 8):
 * one short WhatsApp line to each lab's coordinator every Monday 10:30 with last
 * week's numbers, because "94% of asks answered within 30 min, 3 missed visits"
 * changes lab behaviour more than any chase.
 *
 * Numbers (previous Mon–Sun, local time) per lab:
 *   orders handled          journeys whose visit fell in the week
 *   asks answered ≤ 30 min  combined messages the dispatcher sent (provider_batches,
 *                           not shadow) that the lab answered — a quoted reply or a
 *                           fact the reply reader tied to one of the message's orders
 *   median time to reply    over the answered asks
 *   visits missed           PATIENT_MISSED seen, or collected more than 2 h after the slot
 *   report TAT              median hours from collection (else the slot) to REPORT_DELIVERED,
 *                           and the share over 24 h (undelivered and already past 24 h counts)
 *
 * The computation is pure (`computeLabWeek`) so it is unit-tested on fixtures;
 * `loadLabWeek` reads the inputs. Sending goes through the dispatcher as the ask
 * "SCORECARD" so the per-lab caps and the ledger (provider_batches) apply. A lab
 * whose Lab desk is OFF gets nothing; SHADOW records the message as a shadow batch.
 */
import prisma from "@/lib/db/client";
import { TIME_ZONE } from "@/lib/provider-rules/format";
import { atLocal, localParts } from "@/lib/provider-rules/batching";
import { loadDirectory } from "../directory";
import { loadGuardState, type DeskState } from "../guard/guard";
import { enqueueOutbox } from "../executors/dispatcher";

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;

export const SCORECARD_ASK = "SCORECARD";
/** Visits before this local hour count as early-morning (the phlebo should be named the evening before). */
export const EARLY_VISIT_HOUR = 9;

export type ScorecardOrder = {
  orderId: number;
  appointmentTime: Date | null;
  /** PATIENT_MISSED was seen on the order during the week. */
  missed: boolean;
  /** When the sample was collected (or the patient visited), if it was. */
  collectedAt: Date | null;
  /** When the report was delivered, if it was. */
  reportAt: Date | null;
  /** The phlebo was not named by the time the policy wanted one. */
  phleboLate: boolean;
};

export type ScorecardAsk = { batchId: string; intent: string; sentAt: Date; repliedAt: Date | null };

export type LabWeekInput = { labId: number; labName: string; orders: ScorecardOrder[]; asks: ScorecardAsk[] };

export type LabWeekNumbers = {
  orders: number;
  asks: number;
  answered: number;
  /** Share of asks answered within 30 minutes; null without asks. */
  answeredWithin30: number | null;
  medianReplyMin: number | null;
  missedVisits: number;
  lateCollections: number;
  reportsDelivered: number;
  reportTatMedianH: number | null;
  /** Share of reports over 24 h among orders whose report was due; null without any. */
  reportOver24: number | null;
  reportOver24Count: number;
  /** Early-morning visits with no phlebo named in time. */
  earlyNoPhlebo: number;
};

export type Week = { start: Date; end: Date; label: string };

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** The previous Monday 00:00 to this Monday 00:00, local time. */
export function previousWeek(now: Date, tz = TIME_ZONE()): Week {
  const midnight = atLocal(now, tz, 0, 0);
  const weekday = new Date(midnight.getTime() + 12 * H).toLocaleDateString("en-US", { timeZone: tz, weekday: "short" });
  const daysSinceMonday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekday);
  const end = new Date(midnight.getTime() - Math.max(0, daysSinceMonday) * DAY);
  const start = new Date(end.getTime() - 7 * DAY);
  const fmt = (d: Date) => d.toLocaleDateString("en-IN", { timeZone: tz, day: "numeric", month: "short" });
  return { start, end, label: `${fmt(start)}–${fmt(new Date(end.getTime() - DAY))}` };
}

/** Last week's numbers for one lab, from fixtures or from `loadLabWeek`. Pure. */
export function computeLabWeek(input: Pick<LabWeekInput, "orders" | "asks">, now: Date, tz = TIME_ZONE()): LabWeekNumbers {
  const { orders, asks } = input;
  const replyMins = asks.filter((a) => a.repliedAt).map((a) => (a.repliedAt!.getTime() - a.sentAt.getTime()) / MIN);
  const within30 = replyMins.filter((m) => m <= 30).length;

  const missedVisits = orders.filter((o) => o.missed).length;
  const lateCollections = orders.filter((o) => !o.missed && o.collectedAt && o.appointmentTime && o.collectedAt.getTime() - o.appointmentTime.getTime() > 2 * H).length;

  const visitOf = (o: ScorecardOrder) => o.collectedAt ?? o.appointmentTime;
  const delivered = orders.filter((o) => o.reportAt && visitOf(o));
  const tatHours = delivered.map((o) => (o.reportAt!.getTime() - visitOf(o)!.getTime()) / H);
  // A report still not delivered 24 h after the visit is late too, not merely absent.
  const pendingLate = orders.filter((o) => !o.reportAt && !o.missed && visitOf(o) && now.getTime() - visitOf(o)!.getTime() > 24 * H).length;
  const over24 = tatHours.filter((h) => h > 24).length + pendingLate;
  const dueReports = delivered.length + pendingLate;

  const earlyNoPhlebo = orders.filter((o) => o.phleboLate && o.appointmentTime && localParts(o.appointmentTime, tz).hour < EARLY_VISIT_HOUR).length;

  return {
    orders: orders.length, asks: asks.length, answered: replyMins.length,
    answeredWithin30: asks.length ? within30 / asks.length : null,
    medianReplyMin: median(replyMins),
    missedVisits, lateCollections, reportsDelivered: delivered.length,
    reportTatMedianH: median(tatHours), reportOver24: dueReports ? over24 / dueReports : null, reportOver24Count: over24,
    earlyNoPhlebo,
  };
}

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The closing line: one specific ask when the week showed one, else thanks.
 * Order of asks: phlebos not named for early visits (the lab can fix it tonight),
 * missed visits, slow reports, unanswered asks.
 */
export function closingLine(n: LabWeekNumbers): string {
  if (n.earlyNoPhlebo > 0) return `Ask: ${plural(n.earlyNoPhlebo, "early-morning visit")} had no phlebo named the evening before — please name them by 8 pm.`;
  if (n.missedVisits > 0) return `Ask: ${plural(n.missedVisits, "visit")} missed — a word in the group before the slot lets us re-book the patient.`;
  if (n.reportOver24 != null && n.reportOver24 > 0.2) return `Ask: ${plural(n.reportOver24Count, "report")} took over 24 h — please flag any that will run late.`;
  if (n.asks >= 5 && n.answeredWithin30 != null && n.answeredWithin30 < 0.7) return `Ask: ${n.asks - n.answered === 0 ? "most replies came late" : `${plural(n.asks - n.answered, "ask")} got no reply`} — a quick "on it" within 30 min is all we need.`;
  if (n.asks > 0 || n.orders > 0) return "Thank you — this is what keeps patients from waiting.";
  return "Thank you.";
}

/** The message, four lines at most, plain numbers. `{{coordinator}}` is filled by the dispatcher. */
export function renderScorecard(labName: string, week: Week, n: LabWeekNumbers, coordinator = "{{coordinator}}"): string {
  const asks = n.asks
    ? `${pct(n.answeredWithin30)} of ${plural(n.asks, "ask")} answered within 30 min${n.medianReplyMin != null ? ` · median reply ${Math.round(n.medianReplyMin)} min` : ""}`
    : "no asks from us";
  const visits = `${plural(n.missedVisits, "visit")} missed · ${plural(n.lateCollections, "collection")} over 2 h late`;
  const reports = n.reportTatMedianH != null
    ? `reports median ${n.reportTatMedianH < 10 ? n.reportTatMedianH.toFixed(1) : Math.round(n.reportTatMedianH)} h · ${pct(n.reportOver24)} over 24 h`
    : n.reportOver24Count ? `${plural(n.reportOver24Count, "report")} past 24 h, none delivered yet` : "no reports due yet";
  return [
    `${coordinator} ${labName} last week (${week.label}): ${plural(n.orders, "order")}.`,
    `${asks}.`,
    `${visits} · ${reports}.`,
    closingLine(n),
  ].join("\n");
}

type JourneyRow = {
  orderId: number; consoleSnapshot: unknown;
  checkpoints: Array<{ name: string; status: string; dueAt: Date; metAt: Date | null }>;
  events: Array<{ kind: string; payload: unknown }>;
};

/** Reads one lab's week: journeys with a visit in the week and the combined messages sent to it. */
export async function loadLabWeek(labId: number, labName: string, week: Week, now: Date): Promise<LabWeekInput> {
  const journeys: JourneyRow[] = await prisma.agentJourney.findMany({
    where: { labId, consoleSnapshot: { path: ["appointmentTime"], gte: week.start.toISOString() } },
    select: { orderId: true, consoleSnapshot: true, checkpoints: { select: { name: true, status: true, dueAt: true, metAt: true } }, events: { where: { kind: "console_change" }, select: { kind: true, payload: true } } },
  }).catch(() => []);
  const orders: ScorecardOrder[] = [];
  for (const j of journeys) {
    const snap = (j.consoleSnapshot ?? {}) as { appointmentTime?: string | null; orderStatus?: string };
    const appointmentTime = snap.appointmentTime ? new Date(snap.appointmentTime) : null;
    if (!appointmentTime || appointmentTime < week.start || appointmentTime >= week.end) continue;
    const cp = (name: string) => j.checkpoints.find((c) => c.name === name);
    const collected = cp("sample_collected") ?? cp("patient_visited");
    const report = cp("report_delivered");
    const phlebo = cp("phlebo_assigned");
    const missed = snap.orderStatus === "PATIENT_MISSED" || j.events.some((e) => (e.payload as { to?: { status?: string } } | null)?.to?.status === "PATIENT_MISSED");
    orders.push({
      orderId: j.orderId, appointmentTime, missed,
      collectedAt: collected?.status === "MET" ? collected.metAt : null,
      reportAt: report?.status === "MET" ? report.metAt : null,
      phleboLate: !!phlebo && (phlebo.status === "BREACHED" || (phlebo.status === "MET" && !!phlebo.metAt && phlebo.metAt > phlebo.dueAt)),
    });
  }

  const batches = await prisma.providerBatch.findMany({
    where: { labId, shadow: false, recipient: "LAB", intent: { not: SCORECARD_ASK }, createdAt: { gte: week.start, lt: week.end } },
    select: { id: true, intent: true, createdAt: true, outboundId: true, items: true },
  });
  const asks: ScorecardAsk[] = [];
  if (batches.length) {
    const outbounds = await prisma.waOutbound.findMany({ where: { id: { in: batches.map((b) => b.outboundId).filter((x): x is string => !!x) } }, select: { id: true, sentWaMsgId: true, groupId: true } });
    const outboundById = new Map(outbounds.map((o) => [o.id, o]));
    const quotedIds = outbounds.map((o) => o.sentWaMsgId).filter((x): x is string => !!x);
    const quoted = quotedIds.length ? await prisma.waMessage.findMany({ where: { replyToWaId: { in: quotedIds }, fromMe: false }, select: { replyToWaId: true, ts: true }, orderBy: { ts: "asc" } }) : [];
    const firstQuoted = new Map<string, Date>();
    for (const m of quoted) if (m.replyToWaId && !firstQuoted.has(m.replyToWaId)) firstQuoted.set(m.replyToWaId, m.ts);
    const orderIds = [...new Set(batches.flatMap((b) => ((b.items as Array<{ orderId: number }>) ?? []).map((i) => i.orderId)))];
    const facts = orderIds.length ? await prisma.providerOrderFact.findMany({ where: { labId, orderId: { in: orderIds }, createdAt: { gte: week.start, lt: new Date(week.end.getTime() + DAY) } }, select: { orderId: true, createdAt: true }, orderBy: { createdAt: "asc" } }) : [];
    const factsByOrder = new Map<number, Date[]>();
    for (const f of facts) factsByOrder.set(f.orderId, [...(factsByOrder.get(f.orderId) ?? []), f.createdAt]);
    for (const b of batches) {
      const candidates: Date[] = [];
      const ob = b.outboundId ? outboundById.get(b.outboundId) : undefined;
      const q = ob?.sentWaMsgId ? firstQuoted.get(ob.sentWaMsgId) : undefined;
      if (q && q > b.createdAt) candidates.push(q);
      for (const it of (b.items as Array<{ orderId: number }>) ?? []) {
        const first = (factsByOrder.get(it.orderId) ?? []).find((t) => t > b.createdAt && t.getTime() - b.createdAt.getTime() <= DAY);
        if (first) candidates.push(first);
      }
      const repliedAt = candidates.length ? new Date(Math.min(...candidates.map((d) => d.getTime()))) : null;
      asks.push({ batchId: b.id, intent: b.intent, sentAt: b.createdAt, repliedAt });
    }
  }
  return { labId, labName, orders, asks };
}

export type LabScorecard = {
  labId: number; labName: string; desk: DeskState | "NOT_CONNECTED";
  numbers: LabWeekNumbers; text: string;
  /** What happened to it: queued for the dispatcher, recorded as a shadow batch, skipped. */
  outcome: "QUEUED" | "SHADOW" | "SKIPPED_OFF" | "SKIPPED_NOT_CONNECTED" | "SKIPPED_EMPTY" | "ALREADY" | "PREVIEW";
};

/** The scorecards for every lab in the directory, computed, not sent. */
export async function buildScorecards(now = new Date()): Promise<{ week: Week; cards: LabScorecard[] }> {
  const week = previousWeek(now);
  const [dir, state] = await Promise.all([loadDirectory(), loadGuardState()]);
  const cards: LabScorecard[] = [];
  for (const lab of dir.labs.values()) {
    const input = await loadLabWeek(lab.labId, lab.labName, week, now);
    const numbers = computeLabWeek(input, now);
    const desk: LabScorecard["desk"] = lab.groupJid ? state.desks.get(`LAB:LAB:${lab.labId}`) ?? "OFF" : "NOT_CONNECTED";
    cards.push({ labId: lab.labId, labName: lab.labName, desk, numbers, text: renderScorecard(lab.labName, week, numbers), outcome: "PREVIEW" });
  }
  return { week, cards: cards.sort((a, b) => b.numbers.orders - a.numbers.orders || a.labName.localeCompare(b.labName)) };
}

/**
 * Monday 10:30: queue each lab's scorecard for the dispatcher (LIVE desks), record
 * it as a shadow batch (SHADOW desks), skip OFF and unconnected labs and labs with
 * nothing to say. Idempotent per lab and week. The run is kept as a brain run of
 * kind "scorecard" so Brief and tracking shows what the labs saw.
 */
export async function runLabScorecards(now = new Date()): Promise<Record<string, number>> {
  const { week, cards } = await buildScorecards(now);
  const tz = TIME_ZONE();
  const result = { labs: cards.length, queued: 0, shadow: 0, off: 0, skipped: 0 };
  const windowFrom = atLocal(now, tz, 10, 30);
  const windowTo = atLocal(now, tz, 20, 0);
  for (const card of cards) {
    if (card.numbers.orders === 0 && card.numbers.asks === 0) { card.outcome = "SKIPPED_EMPTY"; result.skipped += 1; continue; }
    if (card.desk === "NOT_CONNECTED") { card.outcome = "SKIPPED_NOT_CONNECTED"; result.skipped += 1; continue; }
    if (card.desk === "OFF") { card.outcome = "SKIPPED_OFF"; result.off += 1; continue; }
    const idemKey = `scorecard:${card.labId}:${week.start.toISOString().slice(0, 10)}`;
    if (card.desk === "SHADOW") {
      const existing = await prisma.providerBatch.findFirst({ where: { labId: card.labId, intent: SCORECARD_ASK, shadow: true, slotAt: windowFrom }, select: { id: true } });
      if (!existing) {
        await prisma.providerBatch.create({ data: { labId: card.labId, intent: SCORECARD_ASK, slotAt: windowFrom, shadow: true, recipient: "LAB", itemCount: 1, text: card.text.replace("{{coordinator}}", "Team"), items: [{ n: 1, orderId: 0, ruleId: "agent:scorecard", occurrence: 1, communicationId: null, line: card.text }] } });
      }
      card.outcome = "SHADOW"; result.shadow += 1; continue;
    }
    const { queued } = await enqueueOutbox({
      counterparty: `LAB:${card.labId}`, ask: SCORECARD_ASK, orderId: 0, journeyId: null, actionId: null,
      windowFrom: windowFrom < now ? now : windowFrom, windowTo, urgent: false, idemKey,
      line: { orderId: 0, patientName: null, appointment: null }, text: card.text,
    });
    card.outcome = queued ? "QUEUED" : "ALREADY"; result.queued += queued ? 1 : 0;
  }
  await prisma.agentBrainRun.create({
    data: { kind: "scorecard", finishedAt: new Date(), inputs: { week: { start: week.start.toISOString(), end: week.end.toISOString(), label: week.label }, cards } as object, brief: cards.map((c) => `${c.labName} [${c.outcome}]\n${c.text}`).join("\n\n") },
  });
  return result;
}

/** Last week's cards for Brief and tracking: the Monday run when there was one, else computed now. */
export async function weeklyScorecards(now = new Date()): Promise<{ week: Week; ranAt: Date | null; cards: LabScorecard[] }> {
  const week = previousWeek(now);
  const run = await prisma.agentBrainRun.findFirst({ where: { kind: "scorecard", startedAt: { gte: week.end } }, orderBy: { startedAt: "desc" }, select: { finishedAt: true, inputs: true } });
  const stored = run?.inputs as { week?: { start: string; end: string; label: string }; cards?: LabScorecard[] } | null;
  if (stored?.cards && stored.week?.start === week.start.toISOString()) return { week, ranAt: run?.finishedAt ?? null, cards: stored.cards };
  const built = await buildScorecards(now);
  return { week: built.week, ranAt: null, cards: built.cards };
}
