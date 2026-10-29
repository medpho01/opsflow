/**
 * The store's day, before it has to ask (26 Oct 2026). Three times a day each
 * store with a connected group gets one message: today's visits, what is done,
 * and — first — the orders that need the store: the customer did not answer
 * the phlebo (RNR, with the slots the lab offered), a sample still owed (urine
 * missed), a visit passed with nothing collected.
 *
 * Built from LabStack (read-only) and the facts the reader took from the lab
 * groups. A LIVE store desk receives it; a SHADOW desk records it.
 */
import prisma from "@/lib/db/client";
import { labstackWorkerQuery } from "@/lib/db/labstack";
import { reached } from "../journey/policy";
import { relayDetail } from "../journey/step";
import { guard, loadGuardState } from "../guard/guard";
import { enqueueOutbox } from "../executors/dispatcher";
import { atLocal } from "@/lib/provider-rules/batching";
import { fetchOrderSnapshots } from "../journey/window";
import { makeLabScope, type LabScope } from "./scope";

type Row = { id: number; storeId: number; orderType: string; orderStatus: string; appointmentTime: Date | null; patientName: string | null; labId: number | null; labName: string | null; labRef: string | null };
export type StoreDay = {
  storeId: number; total: number; collected: number; upcoming: number;
  rnr: Array<{ orderId: number; name: string; time: string; lab: string; detail: string }>;
  owed: Array<{ orderId: number; name: string; sample: string; lab: string }>;
  missed: Array<{ orderId: number; name: string; time: string; lab: string }>;
  /** Centre / clinic visits past their time: the customer has not gone yet — nothing for the lab to do. */
  centreMissed: Array<{ orderId: number; name: string; time: string; lab: string }>;
  /** Visits past their time with labs the bot cannot chase (no API, no live WhatsApp desk): the team's, counted only. */
  otherLabs?: number;
  /** What LabStack moved or cancelled since the last summary, the store's own requests left out (29 Oct 2026). */
  moved?: Array<{ orderId: number; name: string; when: string; reason: string }>;
  cancelled?: Array<{ orderId: number; name: string; reason: string }>;
};

const TZ = () => process.env.TIMEZONE || "Asia/Kolkata";
const hhmm = (d: Date | null) => (d ? d.toLocaleTimeString("en-IN", { timeZone: TZ(), hour: "numeric", minute: "2-digit" }) : "—");
const first = (n: string | null) => (n ?? "Patient").trim().split(/\s+/)[0] || "Patient";

/** A visit this long past its slot with no collection on record is listed; less is the lab's usual status lag (28 Oct 2026: 45 min listed 16 API-lab visits at 4 pm). */
export const MISSED_AFTER_MS = 90 * 60_000;

/** Today's visits per store, sorted into what needs the store and what is fine. */
export async function storeDays(storeIds: number[], now = new Date(), labOnBot: LabScope = async () => true): Promise<StoreDay[]> {
  if (!storeIds.length) return [];
  const from = atLocal(now, TZ(), 0, 0); const to = new Date(from.getTime() + 86_400_000);
  const rows = await labstackWorkerQuery<Row>(
    `SELECT o.id, o."storeId", o."orderType"::text AS "orderType", o."orderStatus"::text AS "orderStatus", o."appointmentTime", u.name AS "patientName", l.id AS "labId", l."labName", NULLIF(o."labOrderId", '') AS "labRef"
       FROM public."Order" o LEFT JOIN public."User" u ON u.id = o."userId" LEFT JOIN public."Lab" l ON l.id = o."labId"
      WHERE o."storeId" = ANY($1::int[]) AND o."appointmentTime" >= $2 AND o."appointmentTime" < $3 AND o."orderStatus"::text NOT IN ('CANCELED','CANCELLED')`,
    [storeIds, from, to],
  );
  const ids = rows.map((r) => r.id);
  const facts = ids.length ? await prisma.providerOrderFact.findMany({ where: { orderId: { in: ids }, createdAt: { gte: new Date(now.getTime() - 20 * 3_600_000) }, kind: { in: ["patient_unavailable", "sample_missed", "sample_collected", "new_appointment_time"] } }, orderBy: { createdAt: "desc" } }) : [];
  const latest = (orderId: number, kind: string) => facts.find((f) => f.orderId === orderId && f.kind === kind);
  const onBot = new Map<number, boolean>();
  for (const id of new Set(rows.map((r) => r.labId).filter((x): x is number => x != null))) onBot.set(id, await labOnBot(id).catch(() => true));
  const days: StoreDay[] = [];
  for (const storeId of storeIds) {
    const mine = rows.filter((r) => r.storeId === storeId);
    const day: StoreDay = { storeId, total: mine.length, collected: 0, upcoming: 0, rnr: [], owed: [], missed: [], centreMissed: [], otherLabs: 0 };
    for (const r of mine) {
      const collected = reached(r.orderStatus, "SAMPLE_COLLECTED");
      const unreachable = latest(r.id, "patient_unavailable");
      const owed = latest(r.id, "sample_missed");
      const rescheduled = latest(r.id, "new_appointment_time");
      const lab = (r.labName ?? "the lab").trim();
      if (owed && owed.value !== "blood") day.owed.push({ orderId: r.id, name: first(r.patientName), sample: owed.value, lab });
      if (collected) { day.collected += 1; continue; }
      if (unreachable && (!rescheduled || rescheduled.createdAt < unreachable.createdAt)) {
        day.rnr.push({ orderId: r.id, name: first(r.patientName), time: hhmm(r.appointmentTime), lab, detail: relayDetail({ kind: "patient_unavailable", value: unreachable.value, fullText: unreachable.sourceText ?? unreachable.value }) });
        continue;
      }
      // A centre visit past its time means the customer has not walked in — not a lab delay (26 Oct 2026:
      // Apollo Clinic and hospital visits were listed as "we're on it with the lab").
      if (r.appointmentTime && r.appointmentTime.getTime() < now.getTime() - MISSED_AFTER_MS) {
        if (r.orderType === "CENTER_VISIT") day.centreMissed.push({ orderId: r.id, name: first(r.patientName), time: hhmm(r.appointmentTime), lab });
        // "We're on it with the lab" is only true for a lab the bot can reach; the rest are the team's.
        else if (r.labId == null || onBot.get(r.labId) !== false) day.missed.push({ orderId: r.id, name: first(r.patientName), time: hhmm(r.appointmentTime), lab });
        else day.otherLabs = (day.otherLabs ?? 0) + 1;
      }
      else day.upcoming += 1;
    }
    days.push(day);
  }
  return days;
}

/** The message a store reads. Needs-you first, then the counts. */
export function digestText(day: StoreDay, storeName: string | null, now = new Date()): string | null {
  if (!day.total && !day.owed.length && !day.moved?.length && !day.cancelled?.length) return null;
  const lines = [`*Today's visits — ${storeName?.trim() || "update"}* (as of ${hhmm(now)})`, ""];
  if (day.rnr.length) {
    lines.push(`📞 *Customer not reachable (${day.rnr.length})* — please get them to pick up, or share a slot:`);
    day.rnr.forEach((o, i) => lines.push(`${i + 1}. #${o.orderId} · ${o.name} · ${o.time} · ${o.detail.replace(/^RNR — the customer did not answer the phlebo's call;?\s*/i, "")}`.replace(/ · $/, "")));
    lines.push("");
  }
  if (day.owed.length) {
    lines.push(`🧪 *Sample still to collect (${day.owed.length})* — blood done; we're getting a slot from the lab:`);
    day.owed.forEach((o, i) => lines.push(`${i + 1}. #${o.orderId} · ${o.name} · ${o.sample} · ${o.lab}`));
    lines.push("");
  }
  if (day.missed.length) {
    lines.push(`⏳ *Visit time passed, not collected yet (${day.missed.length})* — we're on it with the lab:`);
    day.missed.forEach((o, i) => lines.push(`${i + 1}. #${o.orderId} · ${o.name} · ${o.time} · ${o.lab}`));
    lines.push("");
  }
  if (day.centreMissed.length) {
    lines.push(`🏥 *Centre visit time passed (${day.centreMissed.length})* — the customer hasn't visited yet; please remind them or share a new time:`);
    day.centreMissed.forEach((o, i) => lines.push(`${i + 1}. #${o.orderId} · ${o.name} · ${o.time} · ${o.lab}`));
    lines.push("");
  }
  if (day.moved?.length) {
    lines.push(`🔁 *Moved by the lab (${day.moved.length})* — please let the customers know:`);
    day.moved.forEach((o, i) => lines.push(`${i + 1}. #${o.orderId} · ${o.name} · now ${o.when}${o.reason ? ` · ${o.reason}` : ""}`));
    lines.push("");
  }
  if (day.cancelled?.length) {
    lines.push(`⛔ *Cancelled by the lab (${day.cancelled.length})* — our team is arranging the alternative:`);
    day.cancelled.forEach((o, i) => lines.push(`${i + 1}. #${o.orderId} · ${o.name}${o.reason ? ` · ${o.reason}` : ""}`));
    lines.push("");
  }
  if (day.otherLabs) lines.push(`☎️ ${day.otherLabs} visit${day.otherLabs === 1 ? "" : "s"} past time with labs we chase by phone — our team will update here.`, "");
  lines.push(`✅ Collected: ${day.collected}   🕐 Still to come: ${day.upcoming}   Total: ${day.total}`);
  return lines.join("\n");
}

/**
 * Each connected store's summary: sent to stores switched to "summaries" on Connections ›
 * Stores (whatever the agent's state), and to LIVE store desks; recorded for SHADOW desks.
 */
export async function runStoreDigests(now = new Date()): Promise<{ stores: number; sent: number; recorded: number; rnr: number }> {
  const state = await loadGuardState();
  const settings = await prisma.agentSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
  const summariesOn = new Set(settings.digestStoreIds);
  const groups = await prisma.waGroup.findMany({ where: { role: "SUPPORT", storeId: { not: null }, archivedAt: null, active: true }, select: { storeId: true, subject: true } });
  const storeIds = [...new Set(groups.map((g) => g.storeId!))].filter((id) => summariesOn.has(id) || (state.desks.get(`STORE:STORE:${id}`) ?? "OFF") !== "OFF");
  const days = await storeDays(storeIds, now, makeLabScope(state.desks));
  for (const day of days) Object.assign(day, await consoleChangesSince(day.storeId, now).catch(() => ({})));
  const result = { stores: storeIds.length, sent: 0, recorded: 0, rnr: 0 };
  const slot = `${atLocal(now, TZ(), 0, 0).toISOString().slice(0, 10)}:${now.toLocaleTimeString("en-GB", { timeZone: TZ(), hour: "2-digit" })}`;
  for (const day of days) {
    result.rnr += day.rnr.length;
    const text = digestText(day, groups.find((g) => g.storeId === day.storeId)?.subject ?? null, now);
    if (!text) continue;
    if (summariesOn.has(day.storeId)) {
      // Summaries on: sent, whatever the agent's state for this store. Once per store per run.
      const q = await enqueueOutbox({ counterparty: `STORE:${day.storeId}`, ask: "STORE_DIGEST", orderId: 0, journeyId: null, actionId: null, windowFrom: now, windowTo: new Date(now.getTime() + 2 * 3_600_000), urgent: true, immediate: true, idemKey: `digest:${day.storeId}:${slot}`, line: { orderId: 0, patientName: null, appointment: null }, text });
      if (q.queued) result.sent += 1;
      continue;
    }
    const r = await guard({ desk: "STORE", action: "store_reply", params: { text, orderId: 0, storeId: day.storeId, digest: true }, reason: `store summary: ${day.rnr.length} RNR, ${day.owed.length} sample owed, ${day.missed.length} visit passed`, idemKey: `digest:${day.storeId}:${slot}` }, { journeyId: null, orderId: 0, labId: null, storeId: day.storeId }, state);
    if (r.outcome === "EXECUTED") result.sent += 1; else result.recorded += 1;
  }
  return result;
}

const CUSTOMER_MADE_RE = /customer requested|requested (?:through|via|by) (?:the )?(?:api|customer|user)/i;

/**
 * What LabStack moved or cancelled for this store since its last summary (or the last 12 h). Left
 * out: what the store itself asked for (a reschedule or cancel request about the order in its group
 * in the 6 h before) and changes the customer made through the store's own API. One line per order,
 * its latest change.
 */
export async function consoleChangesSince(storeId: number, now = new Date()): Promise<Pick<StoreDay, "moved" | "cancelled">> {
  const last = await prisma.agentOutboxItem.findFirst({ where: { counterparty: `STORE:${storeId}`, ask: "STORE_DIGEST", status: "SENT" }, orderBy: { sentAt: "desc" }, select: { sentAt: true } });
  const since = last?.sentAt ?? new Date(now.getTime() - 12 * 3_600_000);
  const events = await prisma.agentJourneyEvent.findMany({ where: { kind: "console_change", at: { gt: since, lte: now }, journey: { storeId } }, orderBy: { at: "asc" }, select: { at: true, payload: true, journey: { select: { orderId: true } } } });
  const latest = new Map<number, { at: Date; changes: string[]; to: { status?: string; appointmentTime?: string | null } }>();
  for (const e of events) {
    const p = e.payload as { changes?: string[]; to?: { status?: string; appointmentTime?: string | null } };
    const changes = p.changes ?? [];
    if (!changes.includes("RESCHEDULED") && !changes.includes("CANCELLED")) continue;
    latest.set(e.journey.orderId, { at: e.at, changes, to: p.to ?? {} });
  }
  if (!latest.size) return { moved: [], cancelled: [] };
  const ids = [...latest.keys()];
  const snaps = await fetchOrderSnapshots(ids).catch(() => new Map());
  const groups = await prisma.waGroup.findMany({ where: { storeId, role: "SUPPORT" }, select: { id: true } });
  const asked = await prisma.waMessage.findMany({ where: { groupId: { in: groups.map((g) => g.id) }, ts: { gte: new Date(since.getTime() - 6 * 3_600_000) }, intent: { in: ["STORE_RESCHEDULE", "STORE_CANCEL"] } }, select: { text: true, orderIds: true, ts: true } });
  const askedFor = (orderId: number, at: Date) => asked.some((m) => m.ts <= at && m.ts.getTime() >= at.getTime() - 6 * 3_600_000 && (m.orderIds.includes(orderId) || new RegExp(`(?<![\\d])${orderId}(?![\\d])`).test(m.text ?? "")));
  const out: Required<Pick<StoreDay, "moved" | "cancelled">> = { moved: [], cancelled: [] };
  for (const [orderId, c] of latest) {
    if (askedFor(orderId, c.at)) continue;
    const o = snaps.get(orderId);
    const reason = (o?.statusNote ?? "").trim().slice(0, 80);
    if (CUSTOMER_MADE_RE.test(reason)) continue;
    const name = first(o?.patientName ?? null);
    if (c.changes.includes("CANCELLED") || o?.orderStatus === "CANCELLED" || o?.orderStatus === "CANCELED") { out.cancelled.push({ orderId, name, reason }); continue; }
    const when = o?.appointmentTime ?? (c.to.appointmentTime ? new Date(c.to.appointmentTime) : null);
    if (!when) continue;
    out.moved.push({ orderId, name, when: when.toLocaleString("en-IN", { timeZone: TZ(), weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }), reason });
  }
  return out;
}

