/**
 * GET /api/appointments/:id/calls — call history for an appointment, for
 * the "Call Activity" panel in the head's read-only AppointmentQuickView
 * drawer. Same access rule as /api/appointments/:id (any logged-in user).
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
  const appointmentId = parseInt(id, 10);
  if (isNaN(appointmentId)) {
    return NextResponse.json({ error: "Invalid appointment id" }, { status: 400 });
  }

  const calls = await fetchCallsForEntity("APPOINTMENT", appointmentId);
  return NextResponse.json({ calls });
}
