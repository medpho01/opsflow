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
  STORE_PATIENT_UNREACHABLE: { name: "Store: lab could not reach the patient", body: "#{{order_id}}: the lab could not reach the customer at {{time}} ({{detail}}). Please help reach them or share a new slot." },
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
export async function renderStoreText(action: ProposedAction, ctx: Pick<ExecuteContext, "orderId" | "labName" | "appointmentTime">): Promise<string> {
  const p = action.params;
  if (typeof p.text === "string" && p.text.trim()) return p.text;
  const slot = (p.slot instanceof Date ? p.slot : typeof p.slot === "string" ? new Date(p.slot) : ctx.appointmentTime) ?? null;
  switch (action.action) {
    case "store_alert": {
      const body = await storeTemplate(String(p.template ?? "STORE_PATIENT_UNREACHABLE"));
      return renderLabTemplate(body, { order_id: String(ctx.orderId), time: fmtTime(p.at ? new Date(String(p.at)) : new Date()), detail: String(p.text ?? "no response").slice(0, 120), lab_name: ctx.labName ?? "the lab" });
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
      const body = await storeTemplate(String(p.template ?? "STORE_STATUS_ANSWER"));
      return renderLabTemplate(body, { order_id: String(ctx.orderId), status_line: String(p.statusLine ?? ""), next_line: p.nextLine ? ` ${String(p.nextLine)}` : "", lab_name: ctx.labName ?? "the lab" });
    }
  }
}

export async function storeText(action: ProposedAction, ctx: ExecuteContext): Promise<ExecuteResult> {
  const storeId = (action.params.storeId as number | null | undefined) ?? ctx.storeId;
  if (storeId == null) return { outcome: "FAILED", note: "no store for this order" };
  const text = await renderStoreText(action, ctx);
  const now = new Date();
  const r = await enqueueOutbox({
    counterparty: `STORE:${storeId}`, ask: action.action.toUpperCase(), orderId: ctx.orderId, journeyId: ctx.journeyId, actionId: ctx.actionId,
    windowFrom: now, windowTo: new Date(now.getTime() + 6 * 3_600_000), urgent: action.action !== "store_warning",
    idemKey: `outbox:${action.idemKey}`, line: { orderId: ctx.orderId, patientName: ctx.patientName ?? null, appointment: ctx.appointmentTime ?? null }, text,
  });
  if (action.params.quotedWaId && r.queued) await prisma.agentOutboxItem.update({ where: { id: r.id }, data: { payload: { line: { orderId: ctx.orderId }, text, quotedWaId: action.params.quotedWaId } } });
  return r.queued ? { outcome: "EXECUTED", note: text.slice(0, 120) } : { outcome: "RECORDED", note: "already queued" };
}
