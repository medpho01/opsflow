/**
 * GET /api/tasks/metadata
 * Returns metadata about the task system (last updated timestamp, etc.)
 * Used by Foundation Feature: Manual Refresh + Timestamp
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const lastUpdated = new Date();

  return NextResponse.json({
    lastUpdated: lastUpdated.toISOString(),
    timestamp: lastUpdated.getTime(),
  });
}
