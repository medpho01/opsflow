import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import labstack, { labstackOr } from "@/lib/db/labstack";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole, Prisma } from "@prisma/client";

// POST /api/whatsapp/media/:waMsgId/interpret — run cloud vision over an image
// message: summarize it AND pull any order/booking ids visible in the image
// (an id often lives only inside a screenshot, not the text). The ids are
// validated against the replica, merged into the message, and used to thread
// the case — so "still showing as cancelled" + a screenshot of order #73077
// attaches to that order's case. Idempotent; needs ANTHROPIC_API_KEY.
const VISION_MODEL = process.env.WA_VISION_MODEL || "claude-haiku-4-5-20251001";

export async function POST(request: NextRequest, { params }: { params: Promise<{ waMsgId: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    return NextResponse.json({ error: "vision-not-configured", note: "Set ANTHROPIC_API_KEY in the app environment to enable image interpretation." }, { status: 501 });

  const media = await prisma.waMedia.findUnique({ where: { waMsgId }, select: { mime: true, bytes: true } });
  if (!media) return NextResponse.json({ error: "media bytes not found" }, { status: 404 });
  const buf = Buffer.isBuffer(media.bytes) ? media.bytes : Buffer.from(media.bytes);
  const mime = /^image\/(png|jpeg|gif|webp)$/.test(media.mime || "") ? media.mime : "image/jpeg";

  const prompt =
    "You are assisting a diagnostic-lab operations agent. Read this image (often a screenshot of an order page, " +
    "a lab report, a prescription, a payment/UPI screenshot, or an order list). " +
    "Return ONLY a JSON object, no prose: " +
    '{"summary":"<=100 words describing the image for the agent, incl. any status shown",' +
    '"orderIds":[integer order/booking/lab-order ids visible, e.g. 73077],' +
    '"labRefs":["city-prefixed refs like BLR5560683 if any"],' +
    '"status":"any order status shown or empty","patient":"patient name if shown or empty"}';

  let parsed: { summary?: string; orderIds?: number[]; labRefs?: string[]; status?: string; patient?: string } = {};
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: VISION_MODEL, max_tokens: 800,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mime, data: buf.toString("base64") } },
          { type: "text", text: prompt },
        ] }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json({ error: "vision-call-failed", status: res.status, detail: detail.slice(0, 300) }, { status: 502 });
    }
    const data = await res.json();
    let txt = (data?.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("").trim();
    txt = txt.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const a = txt.indexOf("{"), z = txt.lastIndexOf("}");
    if (a >= 0 && z > a) txt = txt.slice(a, z + 1);
    parsed = JSON.parse(txt);
  } catch (e) {
    return NextResponse.json({ error: "vision-call-error", detail: (e as Error).message }, { status: 502 });
  }
  const ocrText = (parsed.summary || "").trim();
  if (!ocrText) return NextResponse.json({ error: "empty interpretation" }, { status: 502 });

  // Validate the ids the model read from the image against the replica, so we
  // only thread on ids that actually exist as orders.
  const candOrderIds = [...new Set((parsed.orderIds || []).map((x) => parseInt(String(x), 10)).filter(Number.isInteger))];
  const candRefs = [...new Set((parsed.labRefs || []).map((r) => String(r).toUpperCase()).filter(Boolean))];
  let resolvedOrderIds: number[] = [];
  if (candOrderIds.length) {
    const rows = await labstackOr(
      labstack.$queryRaw<Array<{ id: number }>>(Prisma.sql`SELECT id FROM public."Order" WHERE id IN (${Prisma.join(candOrderIds)})`),
      [] as Array<{ id: number }>, 4000, { breakerKey: "wa-ocr-order" });
    resolvedOrderIds.push(...rows.map((r) => r.id));
  }
  if (candRefs.length) {
    const rows = await labstackOr(
      labstack.$queryRaw<Array<{ id: number }>>(Prisma.sql`SELECT id FROM public."Order" WHERE upper("labOrderId") IN (${Prisma.join(candRefs)})`),
      [] as Array<{ id: number }>, 4000, { breakerKey: "wa-ocr-ref" });
    resolvedOrderIds.push(...rows.map((r) => r.id));
  }
  resolvedOrderIds = [...new Set(resolvedOrderIds)];

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
