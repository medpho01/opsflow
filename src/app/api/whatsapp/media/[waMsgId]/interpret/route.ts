import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

// POST /api/whatsapp/media/:waMsgId/interpret — run cloud vision over an image
// message and cache the interpretation on the message. Reads patient/order
// context so the model frames what it sees for a lab-ops agent. Idempotent:
// returns the cached result if already interpreted. Requires ANTHROPIC_API_KEY
// in the app environment; without it, returns a clear "not configured" note.
const VISION_MODEL = process.env.WA_VISION_MODEL || "claude-haiku-4-5-20251001";

export async function POST(request: NextRequest, { params }: { params: Promise<{ waMsgId: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const { waMsgId } = await params;
  const msg = await prisma.waMessage.findUnique({
    where: { waMsgId },
    select: { id: true, mediaType: true, ocrText: true, ocrJson: true, orderIds: true },
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
    "You are assisting a diagnostic-lab operations agent triaging WhatsApp messages. " +
    "Describe this image concisely for the agent: what kind of document it is (lab report, prescription, " +
    "payment/UPI screenshot, order list, ID proof, address, etc.), and extract the key facts " +
    "(patient name, test names + values with flags, order/booking ids, amounts, dates). " +
    "If it is a lab report, note any out-of-range values. Keep it under 120 words. " +
    "If the image is unreadable, say so.";

  let ocrText: string;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 400,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mime, data: buf.toString("base64") } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json({ error: "vision-call-failed", status: res.status, detail: detail.slice(0, 300) }, { status: 502 });
    }
    const data = await res.json();
    ocrText = (data?.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n").trim();
  } catch (e) {
    return NextResponse.json({ error: "vision-call-error", detail: (e as Error).message }, { status: 502 });
  }
  if (!ocrText) return NextResponse.json({ error: "empty interpretation" }, { status: 502 });

  await prisma.waMessage.update({ where: { id: msg.id }, data: { ocrText, ocrJson: { model: VISION_MODEL, at: new Date().toISOString() } } }).catch(() => {});
  await prisma.waMedia.update({ where: { waMsgId }, data: { ocrText } }).catch(() => {});
  return NextResponse.json({ ocrText });
}
