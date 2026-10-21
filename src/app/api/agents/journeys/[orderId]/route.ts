/**
 * GET  /api/agents/journeys/[orderId] — one order's whole story: the journey,
 *      its checkpoints, every event and every action the guard saw (FR-14.2).
 * POST /api/agents/journeys/[orderId] — { action: "takeover" | "handback" }:
 *      a person claims the order (the agent pauses) or hands it back (FR-1.8).
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";
import { wakeJourney } from "@/lib/agents/journey/run";

type Params = { params: Promise<{ orderId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT)) {
      return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    }
    const orderId = Number((await params).orderId);
    if (!Number.isInteger(orderId)) return NextResponse.json({ error: "Bad order id", code: "BAD_REQUEST", requestId }, { status: 400 });
    const journey = await prisma.agentJourney.findUnique({
      where: { orderId },
      include: {
        checkpoints: { orderBy: { dueAt: "asc" } },
        events: { orderBy: { at: "asc" }, take: 500 },
        actions: { orderBy: { createdAt: "asc" }, take: 200 },
      },
    });
    if (!journey) return NextResponse.json({ error: "No journey for this order", code: "NOT_FOUND", requestId }, { status: 404 });
    return NextResponse.json({ journey, timeZone: process.env.TIMEZONE || "Asia/Kolkata", requestId });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "AgentsAPI.journey", code: "AGENTS_JOURNEY_FAILED", userMessage: "Could not load this order", error }), { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT)) {
      return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    }
    const orderId = Number((await params).orderId);
    const body = await request.json().catch(() => ({})) as { action?: string };
    if (!Number.isInteger(orderId) || (body.action !== "takeover" && body.action !== "handback")) {
      return NextResponse.json({ error: "Expected { action: 'takeover' | 'handback' }", code: "BAD_REQUEST", requestId }, { status: 400 });
    }
    const journey = await prisma.agentJourney.findUnique({ where: { orderId }, select: { id: true, closedAt: true } });
    if (!journey) return NextResponse.json({ error: "No journey for this order", code: "NOT_FOUND", requestId }, { status: 404 });
    if (journey.closedAt) return NextResponse.json({ error: "This journey is closed", code: "CLOSED", requestId }, { status: 409 });
    await prisma.agentJourneyEvent.create({
      data: { journeyId: journey.id, at: new Date(), kind: body.action, actor: `PERSON:${user.id}`, payload: { userId: user.id, name: user.name ?? null } },
    });
    const result = await wakeJourney(orderId, "person");
    return NextResponse.json({ ok: true, result, requestId });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "AgentsAPI.journey", code: "AGENTS_TAKEOVER_FAILED", userMessage: "Could not update this order", error }), { status: 500 });
  }
}
