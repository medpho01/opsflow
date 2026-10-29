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
import { checkpointDefs, reached } from "../journey/policy";
import { fetchOrderSnapshots } from "../journey/window";
import { enqueueOutbox } from "../executors/dispatcher";
import { guard, loadGuardState } from "../guard/guard";
import { humanSpokeAbout, labChaseable } from "./scope";
import { loadTeam, makeTeamMatcher } from "@/lib/wa/team";

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
