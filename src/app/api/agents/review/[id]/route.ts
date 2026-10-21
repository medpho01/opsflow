/**
 * POST /api/agents/review/[id] — { decision: "APPROVED" | "EDITED" | "REJECTED", edited?: {...} }
 * One click by a person on a review item (FR-3.4, FR-10.4). Approve executes
 * the proposed action; edit executes it with the person's changes; reject
 * records the disagreement. Every decision feeds the autonomy counters and
 * the eval set.
 */
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/db/client";
import { agentsRoute, bad } from "@/lib/agents/api";
import { execute } from "@/lib/agents/executors";
import { recordDecision } from "@/lib/agents/autonomy";
import { loadDirectory, tierOf } from "@/lib/agents/directory";
import type { ProposedAction } from "@/lib/agents/journey/step";
import type { ActionName } from "@/lib/agents/sop/schema";

export const POST = agentsRoute("review", async (request, { user, requestId, params }) => {
  const raw = await request.json().catch(() => ({})) as { decision?: string; edited?: Record<string, unknown>; note?: string };
  if (!["APPROVED", "EDITED", "REJECTED"].includes(raw.decision ?? "")) return bad(requestId, "decision must be APPROVED, EDITED or REJECTED");
  const body = { ...raw, decision: raw.decision as "APPROVED" | "EDITED" | "REJECTED" };
  const item = await prisma.agentReviewItem.findUnique({ where: { id: params.id } });
  if (!item) return bad(requestId, "Review item not found", 404);
  if (item.decision) return bad(requestId, `Already ${item.decision.toLowerCase()}`, 409);
  const action = await prisma.agentAction.findUnique({ where: { id: item.actionId } });
  if (!action) return bad(requestId, "The action behind this item is gone", 404);
  const journey = item.orderId != null ? await prisma.agentJourney.findUnique({ where: { orderId: item.orderId }, select: { id: true, labId: true, storeId: true, orderType: true, consoleSnapshot: true } }) : null;
  const snap = (journey?.consoleSnapshot ?? {}) as Record<string, unknown>;
  const now = new Date();

  await prisma.agentReviewItem.update({ where: { id: item.id }, data: { decision: body.decision, decidedBy: user.id, decidedAt: now, edited: (body.edited ?? Prisma.JsonNull) as Prisma.InputJsonValue } });
  const dir = await loadDirectory();
  await recordDecision({ action: action.action, desk: action.desk, labTier: tierOf(dir, item.labId), labId: item.labId, storeId: item.storeId, agreed: body.decision === "APPROVED" });

  let result: { outcome: string; note?: string } = { outcome: "REJECTED" };
  if (body.decision === "REJECTED") {
    await prisma.agentAction.update({ where: { id: action.id }, data: { outcome: "BLOCKED", blockedBy: `rejected by ${user.name}${body.note ? `: ${body.note}` : ""}` } });
    await prisma.agentEvalCase.create({ data: { suite: `${action.desk.toLowerCase()}_${action.action}`, input: action.params as Prisma.InputJsonValue, expected: { decision: "REJECTED", note: body.note ?? null }, labels: ["inbox", "rejected"], addedFrom: "INBOX_CORRECTION" } });
  } else {
    const params = body.decision === "EDITED" ? { ...(action.params as Record<string, unknown>), ...(body.edited ?? {}) } : (action.params as Record<string, unknown>);
    const proposed: ProposedAction = { desk: action.desk as ProposedAction["desk"], action: action.action as ActionName, params, reason: action.reason, idemKey: action.idemKey ?? `${action.id}` };
    try {
      result = await execute(proposed, { actionId: action.id, journeyId: journey?.id ?? null, orderId: item.orderId ?? 0, labId: item.labId, storeId: item.storeId, level: "ACT", orderType: journey?.orderType, appointmentTime: snap.appointmentTime ? new Date(String(snap.appointmentTime)) : null, patientName: (snap.patientName as string | null) ?? null, labName: (snap.labName as string | null) ?? null, storeName: (snap.storeName as string | null) ?? null, sopVersionId: action.sopVersionId });
      await prisma.agentAction.update({ where: { id: action.id }, data: { outcome: result.outcome === "FAILED" ? "FAILED" : "EXECUTED", blockedBy: `${body.decision.toLowerCase()} by ${user.name}${result.note ? `: ${result.note}` : ""}` } });
      if (body.decision === "EDITED") await prisma.agentEvalCase.create({ data: { suite: `${action.desk.toLowerCase()}_${action.action}`, input: action.params as Prisma.InputJsonValue, expected: { decision: "EDITED", edited: body.edited ?? {} } as Prisma.InputJsonValue, labels: ["inbox", "edited"], addedFrom: "INBOX_CORRECTION" } });
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      await prisma.agentAction.update({ where: { id: action.id }, data: { outcome: "FAILED", blockedBy: note.slice(0, 300) } });
      result = { outcome: "FAILED", note };
    }
  }
  if (journey) await prisma.agentJourneyEvent.create({ data: { journeyId: journey.id, at: now, kind: "person_action", actor: `PERSON:${user.id}`, applied: false, payload: { review: item.kind, decision: body.decision, by: user.name, note: body.note ?? null, result: result.note ?? null } } });
  return NextResponse.json({ ok: true, decision: body.decision, result, requestId });
});
