import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { interpretImage, VISION_MODEL } from "@/lib/wa/vision";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

// POST /api/whatsapp/media/:waMsgId/interpret — run cloud vision over an image
// message: summarize it AND pull any order/booking ids visible in the image
// (an id often lives only inside a screenshot, not the text). The ids are
// validated against the replica, merged into the message, and used to thread
// the case — so "still showing as cancelled" + a screenshot of order #73077
// attaches to that order's case. Idempotent; needs ANTHROPIC_API_KEY.

export async function POST(request: NextRequest, { params }: { params: Promise<{ waMsgId: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT))
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const { waMsgId } = await params;
  const msg = await prisma.waMessage.findUnique({
    where: { waMsgId },
    select: { id: true, groupId: true, ticketId: true, intent: true, mediaType: true, ocrText: true, ocrJson: true, orderIds: true, refIds: true, group: { select: { role: true } } },
  });
  if (!msg) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (msg.ocrText) return NextResponse.json({ ocrText: msg.ocrText, ocrJson: msg.ocrJson, cached: true });
  if (msg.mediaType !== "image")
    return NextResponse.json({ error: "not an image" }, { status: 400 });

  const v = await interpretImage(waMsgId);
  if (!v.ok) return NextResponse.json({ error: v.error, ...(v.detail ? { detail: v.detail } : {}) }, { status: v.status });
  const { ocrText, resolvedOrderIds, candRefs } = v;
  const parsed = { status: v.ocrJson.status, patient: v.ocrJson.patient };

  // Always merge the ids so the message threads to the order (investigation +
  // timeline). Only open/attach a CASE when the image is in a CX group — a
  // lab's screenshot is investigation, not a new query.
  let threadedOrderId: number | null = null;
  const merged = [...new Set([...(msg.orderIds || []), ...resolvedOrderIds])];
  const mergedRefs = [...new Set([...(msg.refIds || []), ...candRefs])];
  if (resolvedOrderIds.length) {
    threadedOrderId = resolvedOrderIds[0];
    let ticketId = msg.ticketId;
    if (!ticketId && msg.group?.role === "SUPPORT") {
      const existing = await prisma.waTicket.findFirst({ where: { groupId: msg.groupId, orderId: threadedOrderId } });
      const ticket = existing ?? await prisma.waTicket.create({
        data: { groupId: msg.groupId, orderId: threadedOrderId, intent: msg.intent, status: "OPEN", lastActivityAt: new Date() },
      });
      ticketId = ticket.id;
    }
    await prisma.waMessage.update({ where: { id: msg.id }, data: { orderIds: { set: merged }, refIds: { set: mergedRefs }, ...(ticketId ? { ticketId } : {}) } }).catch(() => {});
  }

  const ocrJson = { model: VISION_MODEL, at: new Date().toISOString(), orderIds: resolvedOrderIds, labRefs: candRefs, status: parsed.status || null, patient: parsed.patient || null };
  await prisma.waMessage.update({ where: { id: msg.id }, data: { ocrText, ocrJson } }).catch(() => {});
  await prisma.waMedia.update({ where: { waMsgId }, data: { ocrText } }).catch(() => {});
  return NextResponse.json({ ocrText, ocrJson, threadedOrderId });
}
