/**
 * POST /api/message-rules/:id/summary — { labId, send? }
 * The summary this rule would send that lab right now: rendered for preview,
 * or sent immediately with send: true (a manual send never uses up the day's
 * scheduled slot).
 */
import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";
import { summaryForLab } from "@/lib/provider-rules/engine";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT)) {
      return NextResponse.json({ error: "Unauthorized", requestId }, { status: 403 });
    }
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const labId = Number(body?.labId);
    if (!Number.isInteger(labId) || labId < 1) return NextResponse.json({ error: "labId is required", requestId }, { status: 400 });
    // Sending to a provider group is an Ops Head action; looking is not.
    if (body?.send && user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Only an Ops Head can send", requestId }, { status: 403 });
    return NextResponse.json(await summaryForLab(id, labId, { send: !!body?.send }));
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "MessageRulesAPI.summary", code: "SUMMARY_ERROR", userMessage: error instanceof Error ? error.message : "Failed to build the summary", error }), { status: 500 });
  }
}
