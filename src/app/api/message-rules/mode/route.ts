/**
 * PUT /api/message-rules/mode — { mode: "OFF" | "SHADOW" | "LIVE" }.
 * Going LIVE imports the legacy scheduler's sends into the ledger and retires
 * its pending timed steps, so nothing goes twice. See provider-rules/engine.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";
import { setMessageRulesMode } from "@/lib/provider-rules/engine";
import { MESSAGE_RULES_MODES, type MessageRulesMode } from "@/lib/provider-rules/types";

export async function PUT(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Unauthorized", requestId }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    if (!MESSAGE_RULES_MODES.includes(body?.mode)) {
      return NextResponse.json({ error: "mode must be OFF, SHADOW or LIVE", code: "VALIDATION_ERROR", requestId }, { status: 400 });
    }
    const result = await setMessageRulesMode(body.mode as MessageRulesMode);
    return NextResponse.json({ mode: body.mode, ...result });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "MessageRulesAPI.mode", code: "UPDATE_ERROR", userMessage: "Failed to switch the engine mode", error }), { status: 500 });
  }
}
