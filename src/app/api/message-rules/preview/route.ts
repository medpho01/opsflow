/**
 * POST /api/message-rules/preview — dry run of a rule (saved or draft) against
 * the open orders now: { checked, sendNow, tooLate, later, done }. Sends nothing.
 */
import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";
import { previewRule } from "@/lib/provider-rules/engine";
import { messageRuleSchema, flattenZodError } from "@/lib/provider-rules/validation";
import type { MessageRule } from "@/lib/provider-rules/types";

export async function POST(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Unauthorized", requestId }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const parsed = messageRuleSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid rule", code: "VALIDATION_ERROR", details: flattenZodError(parsed.error), requestId }, { status: 400 });
    }
    const rule: MessageRule = {
      ...parsed.data,
      id: typeof body.id === "string" ? body.id : "",
      builtInKey: null,
      description: parsed.data.description ?? null,
      version: 1,
      triggerCondition: parsed.data.triggerCondition as MessageRule["triggerCondition"],
    };
    return NextResponse.json({ preview: await previewRule(rule) });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "MessageRulesAPI.preview", code: "PREVIEW_ERROR", userMessage: "Failed to preview the rule", error }), { status: 500 });
  }
}
