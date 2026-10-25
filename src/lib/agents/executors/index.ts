/**
 * Executors: what a guarded, approved action actually does (DESIGN.md §4.7
 * step "Act"). One function per action; the guard calls `execute` only for
 * a LIVE desk at an acting level, or when a person approves a review item.
 */
import { Prisma } from "@prisma/client";
import prisma from "@/lib/db/client";
import type { ProposedAction } from "../journey/step";
import { enqueueOutbox } from "./dispatcher";
import { createAgentTask, type AgentTaskPayload } from "./tasks";
import { writeStatus } from "./consoleWriter";
import { storeText } from "./storeReply";
import { placeManagerCall } from "./calls";
import { enqueuePortalRead } from "../queue";
import { draftComplaintReply } from "../escalation/drafter";

export type ExecuteContext = {
  actionId: string; journeyId: string | null; orderId: number; labId: number | null; storeId: number | null;
  level: "SHADOW" | "SUGGEST" | "ACT_NOTIFY" | "ACT"; orderType?: string; appointmentTime?: Date | null;
  patientName?: string | null; labName?: string | null; storeName?: string | null; sopVersionId?: string | null;
};
export type ExecuteResult = { outcome: "EXECUTED" | "FAILED" | "RECORDED"; note?: string };

const asDate = (v: unknown): Date | null => (v instanceof Date ? v : typeof v === "string" ? new Date(v) : null);

export async function execute(action: ProposedAction, ctx: ExecuteContext): Promise<ExecuteResult> {
  const p = action.params;
  switch (action.action) {
    case "ask": case "reminder": case "manager_whatsapp": {
      const line = (p.line as { orderId: number; patientName: string | null; appointment: Date | string | null; phlebo?: string | null }) ?? { orderId: ctx.orderId, patientName: ctx.patientName ?? null, appointment: ctx.appointmentTime ?? null };
      const r = await enqueueOutbox({
        counterparty: String(p.counterparty), ask: String(p.intent), orderId: ctx.orderId, journeyId: ctx.journeyId, actionId: ctx.actionId,
        windowFrom: asDate(p.windowFrom) ?? new Date(), windowTo: asDate(p.windowTo) ?? new Date(Date.now() + 4 * 3_600_000), urgent: p.urgent === true || p.forStore === true, immediate: p.forStore === true,
        idemKey: `outbox:${action.idemKey}`, line: { ...line, appointment: asDate(line.appointment) },
      });
      return r.queued ? { outcome: "EXECUTED", note: `queued for ${String(p.counterparty)} ${String(p.intent)}` } : { outcome: "RECORDED", note: "already queued" };
    }
    case "create_task": {
      const payload: AgentTaskPayload = {
        journeyId: ctx.journeyId, cause: String(p.cause ?? action.action), evidence: (p.evidence as AgentTaskPayload["evidence"]) ?? [],
        action: String(p.action ?? action.reason), labId: ctx.labId, verify: (p.verify as AgentTaskPayload["verify"]) ?? { kind: "none" },
      };
      const r = await createAgentTask({
        orderId: ctx.orderId, orderType: ctx.orderType ?? "HOME_SAMPLE", storeId: ctx.storeId, type: String(p.taskType ?? "AGENT_CONSOLE_UPDATE"),
        title: `#${ctx.orderId}: ${payload.action}`.slice(0, 180), payload, appointmentTime: ctx.appointmentTime ?? null, idemKey: `task:${action.idemKey}`,
        dueInMinutes: typeof p.dueInMinutes === "number" ? p.dueInMinutes : undefined,
      });
      if (ctx.journeyId) await prisma.agentJourneyEvent.create({ data: { journeyId: ctx.journeyId, at: new Date(), kind: "task", actor: "AGENT", applied: true, payload: { taskId: r.taskId, type: p.taskType, cause: payload.cause, created: r.created } as Prisma.InputJsonValue } });
      // Escalation desk (FR-9.5): a complaint's task carries the timeline and a drafted reply; a person sends it.
      if (p.draft === true && r.created) await draftComplaintReply(r.taskId, ctx.orderId, ctx.journeyId, String(payload.evidence[0]?.text ?? "")).catch((e) => console.warn("[Agents] draft failed:", e instanceof Error ? e.message : e));
      return { outcome: "EXECUTED", note: `task #${r.taskId}${r.created ? "" : " (existing)"}` };
    }
    case "status_write": return writeStatus(action, ctx);
    case "store_alert": case "store_warning": case "store_reply": case "ack": return storeText(action, ctx);
    case "call": return placeManagerCall(action, ctx);
    case "portal_read": {
      const queued = await enqueuePortalRead(ctx.labId ?? 0, ctx.orderId, (p.labRef as string | null) ?? null, ctx.journeyId);
      if (ctx.journeyId) await prisma.agentJourneyEvent.create({ data: { journeyId: ctx.journeyId, at: new Date(), kind: "portal_read_requested", actor: "AGENT", applied: true, payload: { checkpoint: p.checkpoint, queued } as Prisma.InputJsonValue } }).catch(() => undefined);
      return queued ? { outcome: "EXECUTED", note: "portal read queued" } : { outcome: "RECORDED", note: "portal worker not reachable; next rung continues" };
    }
    case "stuck": {
      if (ctx.journeyId) await prisma.agentJourneyEvent.create({ data: { journeyId: ctx.journeyId, at: new Date(), kind: "escalation", actor: "AGENT", applied: true, payload: { rung: "stuck", checkpoint: p.checkpoint } as Prisma.InputJsonValue } });
      return { outcome: "EXECUTED", note: "on the stuck list" };
    }
    case "wait": return { outcome: "RECORDED" };
    default: return { outcome: "FAILED", note: `no executor for ${action.action}` };
  }
}
