/**
 * Read an image message (27 Oct 2026): a screenshot of a lab's order page, a
 * slot list, a booking confirmation. Returns what it shows in a sentence, plus
 * the order ids and lab references visible in it, validated against LabStack.
 * Cached on the message (ocrText/ocrJson); one model call per image.
 */
import { Prisma } from "@prisma/client";
import prisma from "@/lib/db/client";
import labstack, { labstackOr } from "@/lib/db/labstack";

export const VISION_MODEL = process.env.WA_VISION_MODEL || "claude-haiku-4-5-20251001";

export type VisionResult =
  | { ok: true; cached: boolean; ocrText: string; ocrJson: { model: string; at: string; orderIds: number[]; labRefs: string[]; status: string | null; patient: string | null }; resolvedOrderIds: number[]; candRefs: string[] }
  | { ok: false; status: number; error: string; detail?: string };

const PROMPT =
  "You are assisting a diagnostic-lab operations agent. Read this image (often a screenshot of an order page, " +
  "a lab report, a prescription, a payment/UPI screenshot, a slot list, or an order list). " +
  "Return ONLY a JSON object, no prose: " +
  '{"summary":"<=100 words describing the image for the agent, incl. any status, date or time slots shown",' +
  '"orderIds":[integer order/booking/lab-order ids visible, e.g. 73077],' +
  '"labRefs":["city-prefixed refs like BLR5560683, VL…, or long booking ids if any"],' +
  '"status":"any order status shown or empty","patient":"patient name if shown or empty",' +
  // A slot screen read as "booking interface with available slots" told the store nothing (30 Oct 2026, #95568).
  '"slots":["every appointment time offered as available, each with am/pm, e.g. 10:15 am or 7 am-8 am; empty if none"],' +
  '"booked":"the one appointment time shown as booked or confirmed (not merely offered), e.g. 10:15 am; empty if none"}';

/** `fresh`: read the image again, ignoring the cached reading; `save: false`: change nothing (a replay). */
export async function interpretImage(waMsgId: string, opts: { fresh?: boolean; save?: boolean } = {}): Promise<VisionResult> {
  const msg = await prisma.waMessage.findUnique({ where: { waMsgId }, select: { id: true, mediaType: true, ocrText: true, ocrJson: true, orderIds: true, refIds: true, text: true } });
  if (!msg) return { ok: false, status: 404, error: "not found" };
  if (msg.ocrText && !opts.fresh) {
    const j = (msg.ocrJson ?? {}) as { orderIds?: number[]; labRefs?: string[]; status?: string | null; patient?: string | null; model?: string; at?: string };
    return { ok: true, cached: true, ocrText: msg.ocrText, ocrJson: { model: j.model ?? VISION_MODEL, at: j.at ?? "", orderIds: j.orderIds ?? [], labRefs: j.labRefs ?? [], status: j.status ?? null, patient: j.patient ?? null }, resolvedOrderIds: j.orderIds ?? [], candRefs: j.labRefs ?? [] };
  }
  if (msg.mediaType !== "image") return { ok: false, status: 400, error: "not an image" };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, status: 501, error: "vision-not-configured", detail: "Set ANTHROPIC_API_KEY in the app environment to enable image interpretation." };
  const media = await prisma.waMedia.findUnique({ where: { waMsgId }, select: { mime: true, bytes: true } });
  if (!media) return { ok: false, status: 404, error: "media bytes not found" };
  const buf = Buffer.isBuffer(media.bytes) ? media.bytes : Buffer.from(media.bytes);
  const mime = /^image\/(png|jpeg|gif|webp)$/.test(media.mime || "") ? media.mime : "image/jpeg";

  let parsed: { summary?: string; orderIds?: number[]; labRefs?: string[]; status?: string; patient?: string; slots?: unknown[]; booked?: string } = {};
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: VISION_MODEL, max_tokens: 800,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mime, data: buf.toString("base64") } },
          // The caption says what the screenshot is for ("slots available", "booked as asked") (30 Oct 2026).
          { type: "text", text: (msg.text ?? "").trim() ? `${PROMPT}\nThe sender's caption: ${JSON.stringify((msg.text ?? "").trim().slice(0, 300))}` : PROMPT },
        ] }],
      }),
    });
    if (!res.ok) return { ok: false, status: 502, error: "vision-call-failed", detail: (await res.text().catch(() => "")).slice(0, 300) };
    const data = await res.json();
    let txt = (data?.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("").trim();
    txt = txt.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const a = txt.indexOf("{"), z = txt.lastIndexOf("}");
    if (a >= 0 && z > a) txt = txt.slice(a, z + 1);
    parsed = JSON.parse(txt);
  } catch (e) {
    return { ok: false, status: 502, error: "vision-call-error", detail: (e as Error).message };
  }
  // The times are spelled out after the summary, so whatever reads the sentence sees them.
  const booked = String(parsed.booked ?? "").trim();
  const slots = (parsed.slots ?? []).map((x) => String(x).trim()).filter(Boolean).slice(0, 12);
  const ocrText = [(parsed.summary || "").trim(), booked ? `Booked: ${booked}.` : "", slots.length ? `Slots: ${slots.join(", ")}.` : ""].filter(Boolean).join(" ");
  if (!ocrText) return { ok: false, status: 502, error: "empty interpretation" };

  // Only ids that exist as orders count — the model reads digits, LabStack says which are orders.
  const candOrderIds = [...new Set((parsed.orderIds || []).map((x) => parseInt(String(x), 10)).filter(Number.isInteger))];
  const candRefs = [...new Set((parsed.labRefs || []).map((r) => String(r).toUpperCase()).filter(Boolean))];
  let resolvedOrderIds: number[] = [];
  if (candOrderIds.length) {
    const rows = await labstackOr(labstack.$queryRaw<Array<{ id: number }>>(Prisma.sql`SELECT id FROM public."Order" WHERE id IN (${Prisma.join(candOrderIds)})`), [] as Array<{ id: number }>, 4000, { breakerKey: "wa-ocr-order" });
    resolvedOrderIds.push(...rows.map((r) => r.id));
  }
  if (candRefs.length) {
    const rows = await labstackOr(labstack.$queryRaw<Array<{ id: number }>>(Prisma.sql`SELECT id FROM public."Order" WHERE upper("labOrderId") IN (${Prisma.join(candRefs)})`), [] as Array<{ id: number }>, 4000, { breakerKey: "wa-ocr-ref" });
    resolvedOrderIds.push(...rows.map((r) => r.id));
  }
  resolvedOrderIds = [...new Set(resolvedOrderIds)];
  const ocrJson = { model: VISION_MODEL, at: new Date().toISOString(), orderIds: resolvedOrderIds, labRefs: candRefs, status: parsed.status || null, patient: parsed.patient || null };
  if (opts.save === false) return { ok: true, cached: false, ocrText, ocrJson, resolvedOrderIds, candRefs };
  await prisma.waMessage.update({ where: { id: msg.id }, data: { ocrText, ocrJson, orderIds: { set: [...new Set([...(msg.orderIds || []), ...resolvedOrderIds])] }, refIds: { set: [...new Set([...(msg.refIds || []), ...candRefs])] } } }).catch(() => {});
  await prisma.waMedia.update({ where: { waMsgId }, data: { ocrText } }).catch(() => {});
  return { ok: true, cached: false, ocrText, ocrJson, resolvedOrderIds, candRefs };
}
