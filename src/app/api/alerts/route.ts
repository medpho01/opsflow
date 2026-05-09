/**
 * GET   /api/alerts          — list unread alerts (most recent 50)
 * PATCH /api/alerts          — mark alerts as read
 *   body: { ids?: number[], markAll?: boolean }
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";

export async function GET(request: NextRequest) {
  try {
    const user = await getSessionFromRequest(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const alerts = await prisma.alert.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return NextResponse.json({ alerts, unreadCount: alerts.length });
  } catch (error) {
    console.error("[AlertsAPI] GET error:", error);
    return NextResponse.json(
      { error: "Failed to fetch alerts", details: error instanceof Error ? error.message : undefined },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await getSessionFromRequest(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { ids, markAll } = body;

    if (markAll) {
      await prisma.alert.updateMany({
        where: { status: "PENDING" },
        data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date() },
      });
    } else if (Array.isArray(ids) && ids.length > 0) {
      await prisma.alert.updateMany({
        where: { id: { in: ids } },
        data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date() },
      });
    } else {
      return NextResponse.json({ error: "Provide ids array or markAll: true" }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[AlertsAPI] PATCH error:", error);
    return NextResponse.json(
      { error: "Failed to update alerts", details: error instanceof Error ? error.message : undefined },
      { status: 500 }
    );
  }
}
