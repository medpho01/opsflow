/**
 * GET /api/appointments/:id/calls — call history for the "Call Activity"
 * panel in the head's AppointmentQuickView drawer.
 *
 * Access: recordings/transcripts are patient data, so this enforces the task
 * access rule (see canAccessEntityCalls), not merely "logged in".
 */
import { NextRequest } from "next/server";
import { entityCallsResponse } from "@/lib/calls/callHistory";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return entityCallsResponse(request, "APPOINTMENT", id);
}
