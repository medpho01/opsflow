/**
 * PATCH  /api/message-rules/:id — edit (or pause/resume) a rule. A change to
 *        what or when it sends bumps its version; the next engine pass applies
 *        it to every open order.
 * DELETE /api/message-rules/:id — delete an authored rule. Built-in rules can
 *        be paused or edited, not deleted.
 */
import { NextRequest, NextResponse } from "next/server";
import { Prisma, UserRole } from "@prisma/client";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";
import { messageRuleSchema, flattenZodError, VERSIONED_FIELDS } from "@/lib/provider-rules/validation";

async function requireOpsHead(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  return user && user.role === UserRole.OPS_HEAD ? user : null;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    if (!(await requireOpsHead(request))) return NextResponse.json({ error: "Unauthorized", requestId }, { status: 403 });
    const { id } = await params;
    const existing = await prisma.providerMessageRule.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Rule not found", requestId }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    // Validate the rule as it would be after the change, so a partial edit
    // can never leave it in a shape the full schema would refuse.
    const merged = { ...existing, ...body };
    const parsed = messageRuleSchema.safeParse(merged);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid rule", code: "VALIDATION_ERROR", details: flattenZodError(parsed.error), requestId }, { status: 400 });
    }
    const changed = VERSIONED_FIELDS.some((field) =>
      field in body && JSON.stringify(parsed.data[field]) !== JSON.stringify((existing as Record<string, unknown>)[field]));
    const rule = await prisma.providerMessageRule.update({
      where: { id },
      data: {
        ...parsed.data,
        triggerCondition: parsed.data.triggerCondition as Prisma.InputJsonValue,
        ...(changed ? { version: { increment: 1 } } : {}),
      },
    });
    return NextResponse.json({ rule });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "MessageRulesAPI.PATCH", code: "UPDATE_ERROR", userMessage: "Failed to update the rule", error }), { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    if (!(await requireOpsHead(request))) return NextResponse.json({ error: "Unauthorized", requestId }, { status: 403 });
    const { id } = await params;
    const existing = await prisma.providerMessageRule.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Rule not found", requestId }, { status: 404 });
    if (existing.builtInKey) {
      return NextResponse.json({ error: "Built-in rules can be paused or edited, not deleted", code: "BUILT_IN", requestId }, { status: 409 });
    }
    // Sent messages keep their history (lab_communications); the ledger rows go with the rule.
    await prisma.providerMessageRule.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "MessageRulesAPI.DELETE", code: "DELETE_ERROR", userMessage: "Failed to delete the rule", error }), { status: 500 });
  }
}
