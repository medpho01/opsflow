/**
 * Store-facing text (FR-9, FR-11, FR-16.4): answers, alerts and warnings in
 * the store's own group, always from a template (never free text), through
 * the dispatcher so caps and windows apply. Templates are editable on the
 * Templates page under STORE_*.
 */
import prisma from "@/lib/db/client";
import { renderLabTemplate } from "@/lib/non-api-labs/templates";
import type { ProposedAction } from "../journey/step";
import type { ExecuteContext, ExecuteResult } from "./index";
import { enqueueOutbox } from "./dispatcher";

export const STORE_TEMPLATES: Record<string, { name: string; body: string }> = {
  STORE_STATUS_ANSWER: { name: "Store: status answer", body: "#{{order_id}}: {{status_line}}{{next_line}}" },
  STORE_CHECKING: { name: "Store: checking with the lab", body: "#{{order_id}}: checking with {{lab_name}}, will update here." },
  STORE_NOTED: { name: "Store: change request noted", body: "#{{order_id}}: noted, we'll confirm shortly." },
  STORE_CONFIRMED_CHANGE: { name: "Store: change confirmed", body: "#{{order_id}}: done — {{change}}." },
  STORE_PATIENT_UNREACHABLE: { name: "Store: lab could not reach the patient", body: "#{{order_id}}\n{{patient_name}}\n\nUser is not available, pickup not done ({{detail}}, {{time}}). Please help reach them or share a new slot." },
  STORE_COLLECTED: { name: "Store: sample collected", body: "#{{order_id}}\n{{patient_name}}\n\nSample collected ({{time}}). Report will follow." },
  STORE_LAB_RESCHEDULED: { name: "Store: lab rescheduled", body: "#{{order_id}}\n{{patient_name}}\n\nThe lab has rescheduled: {{detail}}. Please let the customer know." },
  STORE_SAMPLE_OWED: { name: "Store: a sample still to collect", body: "#{{order_id}}\n{{patient_name}}\n\nLab update: {{detail}}. We're asking the lab for a re-collection slot and will confirm here." },
  STORE_LAB_DATA_CHECK: { name: "Store: the lab flagged a detail", body: "#{{order_id}}\n{{patient_name}}\n\nThe lab flagged a detail to check: {{detail}}. Please confirm the correct details here." },
  STORE_LAB_CANCELLED: { name: "Store: the lab cancelled", body: "#{{order_id}}\n{{patient_name}}\n\nThe lab has cancelled this order ({{detail}}). We're on it — another lab, a centre visit or a new slot — and will confirm here. Please let the customer know." },
  STORE_LAB_CANNOT: { name: "Store: lab cannot fulfil", body: "#{{order_id}}\n{{patient_name}}\n\nThe lab cannot do this one ({{detail}}). We are arranging an alternative and will confirm here." },
  STORE_REPORT_SHARED: { name: "Store: report shared by the lab", body: "#{{order_id}}\n{{patient_name}}\n\nReport received from the lab; uploading to the console now." },
  STORE_LAB_PROMISE: { name: "Store: the lab's promise", body: "#{{order_id}}\n{{patient_name}}\n\nLab says: {{detail}}. We'll confirm once it's done." },
  STORE_AT_RISK: { name: "Store: order at risk", body: "#{{order_id}}: {{slot}} collection is at risk — {{reason}}. We expect to collect by {{expected}}, or can you offer {{alternative}}?" },
  STORE_CANNOT_TODAY: { name: "Store: cannot be done today", body: "#{{order_id}}: {{slot}} collection cannot happen today — {{reason}}. Can you offer {{alternative}}?" },
  STORE_ASK_ORDER_ID: { name: "Store: which order?", body: "Which order is this about? Please share the order id." },
};

export async function storeTemplate(key: string): Promise<string> {
  const def = STORE_TEMPLATES[key] ?? STORE_TEMPLATES.STORE_NOTED;
  const row = await prisma.labCommunicationTemplate.upsert({ where: { key }, update: {}, create: { key, name: def.name, body: def.body, isActive: true }, select: { body: true, isActive: true } });
  return row.isActive ? row.body : def.body;
}

const tz = () => process.env.TIMEZONE || "Asia/Kolkata";
const fmtTime = (d: Date | null | undefined) => (d ? d.toLocaleString("en-IN", { timeZone: tz(), hour: "numeric", minute: "2-digit" }) : "the slot");
const fmtSlot = (d: Date | null | undefined) => (d ? d.toLocaleString("en-IN", { timeZone: tz(), weekday: "short", hour: "numeric", minute: "2-digit" }) : "the booked");

/** Render the text for a store action from its template and params. */
export async function renderStoreText(action: ProposedAction, ctx: Pick<ExecuteContext, "orderId" | "labName" | "appointmentTime" | "patientName">): Promise<string> {
  const p = action.params;
  if (action.action !== "store_alert" && typeof p.text === "string" && p.text.trim()) return p.text;
  const slot = (p.slot instanceof Date ? p.slot : typeof p.slot === "string" ? new Date(p.slot) : ctx.appointmentTime) ?? null;
  switch (action.action) {
    case "store_alert": {
      const body = await storeTemplate(String(p.template ?? "STORE_PATIENT_UNREACHABLE"));
      return renderLabTemplate(body, { order_id: String(ctx.orderId), patient_name: (ctx.patientName ?? "").trim() || "Patient", time: fmtTime(p.at ? new Date(String(p.at)) : new Date()), detail: String(p.detail ?? p.text ?? "no response").slice(0, 120), lab_name: ctx.labName ?? "the lab" });
    }
    case "store_warning": {
      const body = await storeTemplate(p.cannotDoToday ? "STORE_CANNOT_TODAY" : "STORE_AT_RISK");
      const delay = typeof p.predictedDelayMin === "number" ? p.predictedDelayMin : 60;
      const expected = slot ? fmtTime(new Date(slot.getTime() + delay * 60_000)) : "later today";
      const alternative = slot ? `tomorrow ${fmtTime(slot)}` : "another slot";
      return renderLabTemplate(body, { order_id: String(ctx.orderId), slot: fmtSlot(slot), reason: ((p.reasons as string[]) ?? []).slice(0, 2).join(", ") || "the lab has not confirmed", expected, alternative });
    }
    case "ack": {
      const body = await storeTemplate(String(p.template ?? "STORE_NOTED"));
      return renderLabTemplate(body, { order_id: String(ctx.orderId), lab_name: ctx.labName ?? "the lab", change: String(p.change ?? "updated") });
    }
    default: {
      // {{next_line}} is optional — most answers have no next step ("report delivered."). The renderer
      // rejects any blank variable, so a blank one is removed here rather than passed: every status
      // answer without a next step used to FAIL instead of sending (Plum readiness check, 26 Oct 2026).
      const body = (await storeTemplate(String(p.template ?? "STORE_STATUS_ANSWER"))).replace(/\s*{{\s*next_line\s*}}/g, p.nextLine ? ` ${String(p.nextLine)}` : "");
      if (!String(p.statusLine ?? "").trim() && /{{\s*status_line\s*}}/.test(body)) throw new Error("store reply has no text and no status line");
      return renderLabTemplate(body, { order_id: String(ctx.orderId), status_line: String(p.statusLine ?? ""), lab_name: ctx.labName ?? "the lab" });
    }
  }
}

/**
 * How long a store message may wait. Nothing goes out 21:00–07:00, and a six-hour window made an
 * alert raised at 23:00 expire before morning: it now lasts until 09:00 the next morning.
 */
export function storeWindowTo(now: Date): Date {
  const sixHours = new Date(now.getTime() + 6 * 3_600_000);
  const hour = Number(now.toLocaleString("en-GB", { timeZone: tz(), hour: "2-digit", hour12: false })) % 24;
  if (hour < 21 && hour >= 3) return sixHours;
  const hoursTo9 = ((9 - hour + 24) % 24) || 24;
  const minute = Number(now.toLocaleString("en-GB", { timeZone: tz(), minute: "2-digit" }));
  return new Date(Math.max(sixHours.getTime(), now.getTime() + hoursTo9 * 3_600_000 - minute * 60_000));
}

export async function storeText(action: ProposedAction, ctx: ExecuteContext): Promise<ExecuteResult> {
  const storeId = (action.params.storeId as number | null | undefined) ?? ctx.storeId;
  if (storeId == null) return { outcome: "FAILED", note: "no store for this order" };
  const text = await renderStoreText(action, ctx);
  const now = new Date();
  const r = await enqueueOutbox({
    counterparty: `STORE:${storeId}`, ask: action.action.toUpperCase(), orderId: ctx.orderId, journeyId: ctx.journeyId, actionId: ctx.actionId,
    windowFrom: now, windowTo: storeWindowTo(now), urgent: action.action !== "store_warning", immediate: true,
    idemKey: `outbox:${action.idemKey}`, line: { orderId: ctx.orderId, patientName: ctx.patientName ?? null, appointment: ctx.appointmentTime ?? null }, text,
  });
  if (action.params.quotedWaId && r.queued) await prisma.agentOutboxItem.update({ where: { id: r.id }, data: { payload: { line: { orderId: ctx.orderId }, text, quotedWaId: action.params.quotedWaId } } });
  return r.queued ? { outcome: "EXECUTED", note: text.slice(0, 120) } : { outcome: "RECORDED", note: "already queued" };
}
