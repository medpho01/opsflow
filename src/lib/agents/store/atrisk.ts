/**
 * At-risk visits at manual labs, told to the store before the visit (29 Oct 2026). A lab with no
 * API (Vision, Advaith, Labwell, …) says nothing unless a person asks; when the agent has asked
 * twice or more and the lab has not answered, an hour before the visit the store hears it — one
 * message per store, every such order listed once — so it can reschedule or move the lab while
 * there is still time. (Vision's 9 am visits ran the whole ladder unanswered and no store heard.)
 *
 * Runs every 10 minutes from the store pass, 07:00–20:59. A LIVE store desk (or a store with
 * summaries on) receives it; a SHADOW desk records it.
 */
import prisma from "@/lib/db/client";
import { labstackWorkerQuery } from "@/lib/db/labstack";
import { checkpointDefs, rankOf, reached } from "../journey/policy";
import { fetchOrderSnapshots } from "../journey/window";
import { enqueueOutbox } from "../executors/dispatcher";
import { guard, loadGuardState } from "../guard/guard";
import { humanSpokeAbout, labChaseable } from "./scope";
import { loadTeam, makeTeamMatcher } from "@/lib/wa/team";
import { loadDirectory, tierOf } from "../directory";
import { loadLiveSops, paramsFor } from "../sop/load";

const TZ = () => process.env.TIMEZONE || "Asia/Kolkata";
/** How long before the visit the store hears it (the audit's proposal: visit − 60 min). */
export const AT_RISK_LEAD_MIN = 60;
/** Unanswered asks before an order counts as at risk. */
export const AT_RISK_MIN_ASKS = 2;

export type AtRiskLine = { orderId: number; name: string; time: string; lab: string };

export function atRiskText(lines: AtRiskLine[]): string {
  return [
    `⚠️ *At risk — the lab hasn't confirmed these visits yet (${lines.length})*`,
    ...lines.map((o, i) => `${i + 1}. #${o.orderId} · ${o.name} · ${o.time} · ${o.lab}`),
    "",
    "We're still chasing the lab. If the customer can move, share a new slot here — or tell us to try another lab.",
  ].join("\n");
}

type Attempt = { n?: number; at?: string | null; answeredAt?: string | null };

export async function runAtRiskBatch(now = new Date()): Promise<{ stores: number; orders: number; sent: number; recorded: number }> {
  const result = { stores: 0, orders: 0, sent: 0, recorded: 0 };
  const hour = Number(now.toLocaleString("en-GB", { timeZone: TZ(), hour: "2-digit", hour12: false })) % 24;
  if (hour < 7 || hour >= 21) return result;
  const state = await loadGuardState();
  const settings = await prisma.agentSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
  const summariesOn = new Set(settings.digestStoreIds);
  const groups = await prisma.waGroup.findMany({ where: { role: "SUPPORT", storeId: { not: null }, archivedAt: null, active: true }, select: { id: true, storeId: true } });
  const storeIds = [...new Set(groups.map((g) => g.storeId!))].filter((id) => summariesOn.has(id) || (state.desks.get(`STORE:STORE:${id}`) ?? "OFF") !== "OFF");
  if (!storeIds.length) return result;

  const journeys = await prisma.agentJourney.findMany({ where: { closedAt: null, storeId: { in: storeIds }, ownerUserId: null }, select: { orderId: true, labId: true, storeId: true, orderType: true, waitingFor: true, attempts: true } });
  const candidates = journeys.filter((j) => {
    const what = (j.waitingFor as { what?: string; from?: string } | null)?.what;
    if (!what || j.orderType === "CENTER_VISIT") return false;
    if (!checkpointDefs(j.orderType).find((d) => d.name === what)?.preCollection) return false;
    const a = ((j.attempts ?? {}) as Record<string, Attempt>)[what];
    return (a?.n ?? 0) >= AT_RISK_MIN_ASKS && (a?.n ?? 0) < 99 && !a?.answeredAt;
  });
  if (!candidates.length) return result;

  // Manual labs only: an API lab's console moves by itself and is chased when it goes quiet.
  const labIds = [...new Set(candidates.map((j) => j.labId).filter((x): x is number => x != null))];
  const apiRows = labIds.length ? await labstackWorkerQuery<{ id: number; api: boolean }>(`SELECT id, (COALESCE("isApiHomeSample", false) OR COALESCE("isApiCenterVisit", false) OR COALESCE("isApiPpmc", false)) AS api FROM public."Lab" WHERE id = ANY($1::int[])`, [labIds]).catch(() => []) : [];
  const api = new Map(apiRows.map((r) => [r.id, r.api]));
  const chaseable = new Map<number, boolean>();
  for (const id of labIds) chaseable.set(id, api.get(id) === false && (await labChaseable(id, state.desks).catch(() => false)));
  const manual = candidates.filter((j) => j.labId != null && chaseable.get(j.labId) === true);
  if (!manual.length) return result;

  const snaps = await fetchOrderSnapshots(manual.map((j) => j.orderId)).catch(() => new Map());
  // Each order is listed once a day: the store heard it; repeating it is noise. (A SHADOW desk only
  // records, through the guard, and may record an order again — nothing is sent.)
  const dayStart = new Date(now.getTime() - 20 * 3_600_000);
  const told = await prisma.agentOutboxItem.findMany({ where: { ask: "STORE_AT_RISK", createdAt: { gte: dayStart } }, select: { payload: true } });
  const toldIds = new Set(told.flatMap((t) => ((t.payload as { orderIds?: number[] } | null)?.orderIds ?? [])));
  const team = await loadTeam();
  const isTeam = makeTeamMatcher(team);

  const byStore = new Map<number, AtRiskLine[]>();
  for (const j of manual) {
    const o = snaps.get(j.orderId);
    if (!o?.appointmentTime || toldIds.has(j.orderId)) continue;
    if (reached(o.orderStatus, "SAMPLE_COLLECTED") || ["RESCHEDULED", "PATIENT_MISSED", "CANCELED", "CANCELLED", "REPORT_DELIVERED"].includes(o.orderStatus)) continue;
    const minutesToSlot = (o.appointmentTime.getTime() - now.getTime()) / 60_000;
    if (minutesToSlot > AT_RISK_LEAD_MIN || minutesToSlot < -30) continue;
    // A person on our side is already on it in the store group: theirs.
    const group = groups.find((g) => g.storeId === j.storeId);
    if (group && (await humanSpokeAbout({ groupId: group.id, orderId: j.orderId, from: new Date(now.getTime() - 2 * 3_600_000), to: now, isTeam }).catch(() => false))) continue;
    const line = { orderId: j.orderId, name: (o.patientName ?? "Patient").trim().split(/\s+/)[0] || "Patient", time: o.appointmentTime.toLocaleTimeString("en-IN", { timeZone: TZ(), hour: "numeric", minute: "2-digit" }), lab: (o.labName ?? "the lab").trim() };
    byStore.set(j.storeId!, [...(byStore.get(j.storeId!) ?? []), line]);
  }

  for (const [storeId, lines] of byStore) {
    result.stores += 1; result.orders += lines.length;
    const text = atRiskText(lines);
    const orderIds = lines.map((l) => l.orderId);
    const idemKey = `atrisk:${storeId}:${orderIds.join(",")}:${now.toISOString().slice(0, 10)}`;
    if (summariesOn.has(storeId) || state.desks.get(`STORE:STORE:${storeId}`) === "LIVE") {
      const q = await enqueueOutbox({ counterparty: `STORE:${storeId}`, ask: "STORE_AT_RISK", orderId: 0, journeyId: null, actionId: null, windowFrom: now, windowTo: new Date(now.getTime() + 45 * 60_000), urgent: true, immediate: true, idemKey, line: { orderId: 0, patientName: null, appointment: null }, text, extra: { orderIds } });
      if (q.queued) result.sent += 1;
    } else {
      const r = await guard({ desk: "STORE", action: "store_reply", params: { text, orderId: 0, storeId, digest: true }, reason: `at risk: ${lines.length} visit(s) within ${AT_RISK_LEAD_MIN} min at manual labs that have not answered ${AT_RISK_MIN_ASKS}+ asks`, idemKey }, { journeyId: null, orderId: 0, labId: null, storeId }, state);
      if (r.outcome !== "EXECUTED") result.recorded += 1;
    }
  }
  return result;
}

/** A late visit older than this is not news any more: the day's summary and the tasks carry it. */
export const LATE_MAX_AGE_MIN = 6 * 60;

export type LateLine = AtRiskLine & { state: string };

/** What the console shows about a visit that has not been collected, in a store's words. */
export function lateState(status: string, phlebo: string | null | undefined): string {
  const name = (phlebo ?? "").trim().split(/\s+/)[0];
  if (status === "PHLEBO_STARTED" || status === "PHLEBO_DISPATCHED") return `phlebo${name ? ` ${name}` : ""} is on the way`;
  if (status === "PHLEBO_ASSIGNED" || name) return `phlebo${name ? ` ${name}` : ""} assigned, not started yet`;
  return "no phlebo assigned yet";
}

export function lateText(lines: LateLine[]): string {
  return [
    `⏰ *Running late — not collected yet (${lines.length})*`,
    ...lines.map((o, i) => `${i + 1}. #${o.orderId} · ${o.name} · ${o.time} · ${o.lab} — ${o.state}`),
    "",
    "We're following up with the lab and will update here. If the customer wants a new slot, share it here.",
  ].join("\n");
}

/**
 * Visits running late, told to the store before it has to ask (10 Nov 2026: about 12 store orders
 * were late one afternoon, some seven hours with no phlebo, and no store heard). A home visit is
 * late when the lab's usual collected-by time (SOP asks.sample_collected.dueOffsetMin: Orange 20,
 * Thyrocare 45, Redcliffe 90 min after the slot) plus the SOP's lateAfterMin has passed and neither
 * the console nor the lab says collected — at any lab, API or manual, with a group or without.
 * One message per store per pass, each order once a day; an order a person on our side is already
 * discussing in the store's group is left to them. Runs with the at-risk batch.
 */
export async function runLateBatch(now = new Date()): Promise<{ stores: number; orders: number; sent: number; recorded: number }> {
  const result = { stores: 0, orders: 0, sent: 0, recorded: 0 };
  const hour = Number(now.toLocaleString("en-GB", { timeZone: TZ(), hour: "2-digit", hour12: false })) % 24;
  if (hour < 7 || hour >= 21) return result;
  const state = await loadGuardState();
  const settings = await prisma.agentSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
  const summariesOn = new Set(settings.digestStoreIds);
  const groups = await prisma.waGroup.findMany({ where: { role: "SUPPORT", storeId: { not: null }, archivedAt: null, active: true }, select: { id: true, storeId: true } });
  const storeIds = [...new Set(groups.map((g) => g.storeId!))].filter((id) => summariesOn.has(id) || (state.desks.get(`STORE:STORE:${id}`) ?? "OFF") !== "OFF");
  if (!storeIds.length) return result;

  const journeys = await prisma.agentJourney.findMany({ where: { closedAt: null, storeId: { in: storeIds }, ownerUserId: null, labId: { not: null }, NOT: { orderType: "CENTER_VISIT" } }, select: { orderId: true, labId: true, storeId: true, orderType: true, waitingFor: true } });
  const open = journeys.filter((j) => {
    const what = (j.waitingFor as { what?: string } | null)?.what;
    // Home visits only: a kit or a centre visit has no phlebo to be late.
    return !!what && ["confirmed", "phlebo_assigned", "phlebo_reached", "sample_collected"].includes(what) && checkpointDefs(j.orderType).some((d) => d.name === "phlebo_assigned");
  });
  if (!open.length) return result;
  const snaps = await fetchOrderSnapshots(open.map((j) => j.orderId)).catch(() => new Map());
  const [dir, sops] = await Promise.all([loadDirectory(), loadLiveSops()]);
  const lateAt = (labId: number, storeId: number | null, orderType: string) => {
    const sop = paramsFor(sops.get("LAB"), { labTier: tierOf(dir, labId), labId, storeId, orderType });
    return (sop?.asks.sample_collected?.dueOffsetMin ?? 30) + (sop?.lateAfterMin ?? 30);
  };
  const late = open.filter((j) => {
    const o = snaps.get(j.orderId);
    if (!o?.appointmentTime) return false;
    // Reached the patient, moved, missed or cancelled: not "running late". An unknown status is not guessed at.
    if (rankOf(o.orderStatus) < 0 || reached(o.orderStatus, "PATIENT_VISITED") || ["RESCHEDULED", "KIT_DISPATCHED"].includes(o.orderStatus)) return false;
    const past = (now.getTime() - o.appointmentTime.getTime()) / 60_000;
    return past >= lateAt(j.labId!, j.storeId, j.orderType) && past <= LATE_MAX_AGE_MIN;
  });
  if (!late.length) return result;

  // The lab saying "collected" in its group counts, console or not; and each order is told once a day.
  const said = await prisma.providerOrderFact.findMany({ where: { orderId: { in: late.map((j) => j.orderId) }, kind: { in: ["sample_collected", "patient_unavailable", "new_appointment_time", "cannot_fulfil"] }, createdAt: { gte: new Date(now.getTime() - 8 * 3_600_000) } }, select: { orderId: true } });
  const answered = new Set(said.map((f) => f.orderId));
  const told = await prisma.agentOutboxItem.findMany({ where: { ask: "STORE_LATE", createdAt: { gte: new Date(now.getTime() - 20 * 3_600_000) } }, select: { payload: true } });
  const toldIds = new Set(told.flatMap((t) => ((t.payload as { orderIds?: number[] } | null)?.orderIds ?? [])));
  const isTeam = makeTeamMatcher(await loadTeam());

  const byStore = new Map<number, LateLine[]>();
  for (const j of late) {
    if (answered.has(j.orderId) || toldIds.has(j.orderId)) continue;
    const o = snaps.get(j.orderId)!;
    const group = groups.find((g) => g.storeId === j.storeId);
    if (group && (await humanSpokeAbout({ groupId: group.id, orderId: j.orderId, from: new Date(o.appointmentTime!.getTime() - 30 * 60_000), to: now, isTeam }).catch(() => false))) continue;
    const line: LateLine = { orderId: j.orderId, name: (o.patientName ?? "Patient").trim().split(/\s+/)[0] || "Patient", time: o.appointmentTime!.toLocaleTimeString("en-IN", { timeZone: TZ(), hour: "numeric", minute: "2-digit" }), lab: (o.labName ?? "the lab").trim(), state: lateState(o.orderStatus, o.phleboName) };
    byStore.set(j.storeId!, [...(byStore.get(j.storeId!) ?? []), line]);
  }

  for (const [storeId, lines] of byStore) {
    result.stores += 1; result.orders += lines.length;
    const text = lateText(lines);
    const orderIds = lines.map((l) => l.orderId);
    const idemKey = `late:${storeId}:${orderIds.join(",")}:${now.toISOString().slice(0, 10)}`;
    if (summariesOn.has(storeId) || state.desks.get(`STORE:STORE:${storeId}`) === "LIVE") {
      const q = await enqueueOutbox({ counterparty: `STORE:${storeId}`, ask: "STORE_LATE", orderId: 0, journeyId: null, actionId: null, windowFrom: now, windowTo: new Date(now.getTime() + 45 * 60_000), urgent: true, immediate: true, idemKey, line: { orderId: 0, patientName: null, appointment: null }, text, extra: { orderIds } });
      if (q.queued) result.sent += 1;
    } else {
      const r = await guard({ desk: "STORE", action: "store_reply", params: { text, orderId: 0, storeId, digest: true }, reason: `running late: ${lines.length} visit(s) past the lab's collected-by time with no collection`, idemKey }, { journeyId: null, orderId: 0, labId: null, storeId }, state);
      if (r.outcome !== "EXECUTED") result.recorded += 1;
    }
  }
  return result;
}
