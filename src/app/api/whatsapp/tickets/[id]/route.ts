import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import labstack, { labstackOr } from "@/lib/db/labstack";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole, WaTicketStatus } from "@prisma/client";

// GET /api/whatsapp/tickets/:id — ticket + full thread + live order context
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const { id } = await params;
  const ticket = await prisma.waTicket.findUnique({
    where: { id },
    include: { group: true },
  });
  if (!ticket) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Show the recent conversation of the whole GROUP (not just this ticket's
  // linked messages) so the agent sees context. Last 120 by time, ascending.
  const recent = await prisma.waMessage.findMany({
    where: { groupId: ticket.groupId },
    orderBy: { ts: "desc" },
    take: 120,
  });
  const groupMessages = recent.reverse();

  // Best-effort live context from the LabStack replica (falls back to snapshot).
  let live: unknown = null;
  if (ticket.orderId) {
    const rows = await labstackOr(
      labstack.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, "orderStatus", "appointmentTime", "phleboName", "phleboNumber",
               "statusUpdatedAt", "cancelReason", "labId", "orderType"
        FROM public."Order" WHERE id = ${ticket.orderId} LIMIT 1`,
      [] as Array<Record<string, unknown>>, 4000, { breakerKey: "wa-order-ctx" }
    );
    live = rows[0] || null;
  } else if (ticket.requestId) {
    const rows = await labstackOr(
      labstack.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, status, "createdAt", "isServiceable", "quotedPrice"
        FROM public."Request" WHERE id = ${ticket.requestId} LIMIT 1`,
      [] as Array<Record<string, unknown>>, 4000, { breakerKey: "wa-req-ctx" }
    );
    live = rows[0] || null;
  }

  // Resolve reply targets: store group = this group; lab group = a PROVIDER group with the same labId.
  let labGroup: { id: string; jid: string; subject: string } | null = null;
  if (ticket.group?.labId) {
    labGroup = await prisma.waGroup.findFirst({
      where: { role: "PROVIDER", labId: ticket.group.labId },
      select: { id: true, jid: true, subject: true },
    });
  }

  return NextResponse.json({
    ticket: {
      id: ticket.id, status: ticket.status, intent: ticket.intent,
      orderId: ticket.orderId, requestId: ticket.requestId,
      contextSnapshot: ticket.contextSnapshot, liveContext: live,
      assignedToId: ticket.assignedToId, slaDueAt: ticket.slaDueAt,
      lastActivityAt: ticket.lastActivityAt, createdAt: ticket.createdAt,
    },
    group: ticket.group
      ? { id: ticket.group.id, jid: ticket.group.jid, subject: ticket.group.subject, role: ticket.group.role, storeId: ticket.group.storeId, labId: ticket.group.labId, sendEnabled: ticket.group.sendEnabled }
      : null,
    labGroup,
    messages: groupMessages.map((m) => ({
      id: m.id, direction: m.direction, fromMe: m.fromMe, sender: m.sender,
      text: m.text, ts: m.ts, intent: m.intent, waMsgId: m.waMsgId,
    })),
  });
}

// PATCH /api/whatsapp/tickets/:id — change status / assignment
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const data: Record<string, unknown> = {};
  if (body.status !== undefined) {
    if (!Object.values(WaTicketStatus).includes(body.status))
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    data.status = body.status;
    if (body.status === "RESOLVED") data.resolvedAt = new Date();
  }
  if (body.assignedToId !== undefined) data.assignedToId = body.assignedToId === null ? null : Number(body.assignedToId);
  if (Object.keys(data).length === 0) return NextResponse.json({ error: "no fields" }, { status: 400 });

  try {
    const ticket = await prisma.waTicket.update({ where: { id }, data });
    return NextResponse.json({ ticket });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
