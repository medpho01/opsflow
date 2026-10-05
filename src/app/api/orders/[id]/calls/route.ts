/**
 * GET /api/orders/:id/calls[?entityType=X] — call history for the "Call
 * Activity" panel in the head's OrderQuickView drawer.
 *
 * That drawer also serves other sources' entities (it takes the task's real
 * entityType), so the type comes from the query string, defaulting to ORDER —
 * the same type the drawer's CallButton tags new calls with.
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
  const entityType = request.nextUrl.searchParams.get("entityType") ?? "ORDER";
  return entityCallsResponse(request, entityType, id);
}
