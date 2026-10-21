/**
 * The call rung (FR-12): an Exotel call to the lab manager on file, only
 * within working hours and a daily budget. When calls are not enabled for
 * the agent (AGENT_CALLS=on and an agent caller number), the rung becomes a
 * one-click "Call the lab manager" task instead, as Phase 3 of the earlier
 * design did.
 */
import prisma from "@/lib/db/client";
import { initiateExotelCall, normalizeMobile } from "@/lib/telephony/exotel";
import type { ProposedAction } from "../journey/step";
import type { ExecuteContext, ExecuteResult } from "./index";
import { createAgentTask } from "./tasks";

const DAILY_CALL_BUDGET = Number(process.env.AGENT_DAILY_CALL_BUDGET ?? 20);

function withinCallHours(now = new Date()): boolean {
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: process.env.TIMEZONE || "Asia/Kolkata" }).format(now));
  return h >= 9 && h < 20;
}

export async function placeManagerCall(action: ProposedAction, ctx: ExecuteContext): Promise<ExecuteResult> {
  const config = ctx.labId != null ? await prisma.nonApiLabConfig.findUnique({ where: { labId: ctx.labId }, select: { managerName: true, managerWhatsapp: true, labName: true } }) : null;
  const to = normalizeMobile(config?.managerWhatsapp ?? null);
  const taskFallback = async (why: string) => {
    const r = await createAgentTask({
      orderId: ctx.orderId, orderType: ctx.orderType ?? "HOME_SAMPLE", storeId: ctx.storeId, type: "AGENT_MANAGER_CALL",
      title: `#${ctx.orderId}: call the ${config?.labName ?? "lab"} manager`,
      payload: { journeyId: ctx.journeyId, cause: "LADDER_CALL", evidence: [{ kind: "ladder", text: action.reason }], action: `Call ${config?.managerName ?? "the lab manager"}${to ? ` (${to})` : ""} about #${ctx.orderId}: ${String(action.params.checkpoint ?? "").replace("_", " ")}`, labId: ctx.labId, verify: { kind: "none" } },
      appointmentTime: ctx.appointmentTime ?? null, idemKey: `task:${action.idemKey}`, dueInMinutes: 30,
    });
    return { outcome: "EXECUTED" as const, note: `${why}: task #${r.taskId}` };
  };
  if (!to) return taskFallback("no manager number on file");
  const from = process.env.AGENT_CALLER_NUMBER;
  if (process.env.AGENT_CALLS !== "on" || !from) return taskFallback("agent calls not enabled");
  if (!withinCallHours()) return taskFallback("outside call hours");
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const today = await prisma.agentAction.count({ where: { action: "call", outcome: "EXECUTED", createdAt: { gte: since }, blockedBy: { startsWith: "called" } } });
  if (today >= DAILY_CALL_BUDGET) return taskFallback("daily call budget used");
  const result = await initiateExotelCall({ from, to, toName: config?.managerName ?? null, entityType: "ORDER", entityId: ctx.orderId, triggeredFrom: "agent_ladder" });
  if (!result.success) return taskFallback(`call failed: ${result.error ?? "unknown"}`);
  if (ctx.journeyId) await prisma.agentJourneyEvent.create({ data: { journeyId: ctx.journeyId, at: new Date(), kind: "escalation", actor: "AGENT", applied: true, payload: { rung: "call", to: config?.managerName ?? to, callLogId: result.callLogId ?? null } } });
  return { outcome: "EXECUTED", note: `called ${config?.managerName ?? "the lab manager"} (call ${result.callLogId ?? result.sid ?? ""})` };
}
