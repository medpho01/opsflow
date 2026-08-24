import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { patientNames } from "@/lib/wa/patientNames";

// A "case" = one order/request query inside a group (an open ticket). Opening a
// group shows its cases so the team clears them one order at a time (CRM).
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT))
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const { id: groupId } = await params;
  const includeResolved = request.nextUrl.searchParams.get("all") === "1";

  const group = await prisma.waGroup.findUnique({ where: { id: groupId }, select: { id: true, subject: true, role: true, labId: true } });
  if (!group) return NextResponse.json({ error: "group not found" }, { status: 404 });

  const tickets = await prisma.waTicket.findMany({
    where: { groupId, ...(includeResolved ? {} : { status: { notIn: ["RESOLVED"] } }) },
    orderBy: { lastActivityAt: "desc" },
    take: 200,
    include: { messages: { orderBy: { ts: "desc" }, take: 1, select: { text: true, sender: true, ts: true } } },
  });

  const names = await patientNames(
    tickets.map((t) => t.orderId).filter((x): x is number => !!x),
    tickets.map((t) => t.requestId).filter((x): x is number => !!x),
  );

  const cases = tickets.map((t) => ({
    ticketId: t.id, status: t.status, intent: t.intent, origin: t.origin,
    orderId: t.orderId, requestId: t.requestId,
    patient: (t.orderId && names[`o${t.orderId}`]) || (t.requestId && names[`r${t.requestId}`]) || null,
    lastActivityAt: t.lastActivityAt,
    snippet: t.messages[0]?.text || null,
  }));

  // Category breakdown for the group header.
  const breakdown = cases.reduce<Record<string, number>>((a, c) => {
    const k = c.intent || "OTHER";
    a[k] = (a[k] || 0) + 1;
    return a;
  }, {});

  return NextResponse.json({ group, cases, breakdown, openCount: cases.filter((c) => c.status !== "RESOLVED").length });
}
