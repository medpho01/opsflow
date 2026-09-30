/**
 * GET /api/orders/:id/calls — call history for an order, for the "Call
 * Activity" panel in the head's read-only OrderQuickView drawer. Same
 * access rule as /api/orders/:id (any logged-in user) — this drawer does no
 * per-user ownership scoping today.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { fetchCallsForEntity } from "@/lib/calls/callHistory";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const orderId = parseInt(id, 10);
  if (isNaN(orderId)) {
    return NextResponse.json({ error: "Invalid order id" }, { status: 400 });
  }

  const calls = await fetchCallsForEntity("ORDER", orderId);
  return NextResponse.json({ calls });
}
