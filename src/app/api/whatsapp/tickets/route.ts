import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole, WaTicketStatus } from "@prisma/client";

// Bucket → statuses. The queue is organised the way the team works, not by raw enum.
const BUCKETS: Record<string, WaTicketStatus[]> = {
  needs_response: ["NEW", "OPEN"],
  waiting_lab: ["WAITING_LAB"],
  waiting_info: ["WAITING_INFO"],
  resolved: ["ANSWERED", "RESOLVED"],
};

// GET /api/whatsapp/tickets?bucket=needs_response
export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const bucket = request.nextUrl.searchParams.get("bucket") || "needs_response";
  const statuses = BUCKETS[bucket] || BUCKETS.needs_response;

  const [rows, counts] = await Promise.all([
    prisma.waTicket.findMany({
      where: { status: { in: statuses } },
      orderBy: [{ slaDueAt: "asc" }, { lastActivityAt: "asc" }],
      take: 100,
      include: {
        group: { select: { subject: true, role: true, storeId: true, labId: true } },
        messages: { orderBy: { ts: "desc" }, take: 1, select: { text: true, sender: true, ts: true, direction: true } },
      },
    }),
    prisma.waTicket.groupBy({ by: ["status"], _count: true }),
  ]);

  const countByStatus = Object.fromEntries(counts.map((c) => [c.status, c._count]));
  const bucketCounts = Object.fromEntries(
    Object.entries(BUCKETS).map(([k, sts]) => [k, sts.reduce((n, s) => n + (countByStatus[s] || 0), 0)])
  );

  const tickets = rows.map((t) => ({
    id: t.id,
    status: t.status,
    intent: t.intent,
    orderId: t.orderId,
    requestId: t.requestId,
    context: t.contextSnapshot,
    group: t.group?.subject,
    groupRole: t.group?.role,
    lastActivityAt: t.lastActivityAt,
    slaDueAt: t.slaDueAt,
    lastMessage: t.messages[0] || null,
  }));

  return NextResponse.json({ bucket, tickets, bucketCounts });
}
