import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

// POST /api/whatsapp/send — free text to a group (by id) or a raw number.
// body: { text, groupId? , toNumber? }
export async function POST(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  // JSON (text) or multipart (text + attachment), like the case reply route.
  let body: Record<string, unknown> = {};
  let media: { mime: string; name: string; bytes: Buffer } | null = null;
  if ((request.headers.get("content-type") || "").includes("multipart/form-data")) {
    const form = await request.formData();
    body = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string")) as Record<string, unknown>;
    const file = form.get("file");
    if (file && typeof file !== "string") {
      const buf = Buffer.from(await file.arrayBuffer());
      if (buf.length > 16 * 1024 * 1024) return NextResponse.json({ error: "attachment too large (max 16MB)" }, { status: 400 });
      if (buf.length > 0) media = { mime: file.type || "application/octet-stream", name: file.name || "file", bytes: buf };
    }
  } else {
    body = await request.json().catch(() => ({}));
  }
  const text = String(body?.text || "").trim();
  if (!text && !media) return NextResponse.json({ error: "text or an attachment is required" }, { status: 400 });

  let targetJid: string | null = null;
  let groupId: string | null = null;

  if (body.groupId) {
    const group = await prisma.waGroup.findUnique({ where: { id: String(body.groupId) } });
    if (!group) return NextResponse.json({ error: "group not found" }, { status: 404 });
    targetJid = group.jid;
    groupId = group.id;
  } else if (body.toNumber) {
    const digits = String(body.toNumber).replace(/\D/g, "");
    if (digits.length < 8) return NextResponse.json({ error: "enter a valid number with country code" }, { status: 400 });
    targetJid = `${digits}@s.whatsapp.net`;
  } else {
    return NextResponse.json({ error: "provide groupId or toNumber" }, { status: 400 });
  }

  const quotedWaId = body?.quotedWaMsgId ? String(body.quotedWaMsgId) : null;
  await prisma.waOutbound.create({
    data: {
      targetJid, text, groupId, createdById: user.id, quotedWaId,
      ...(media ? { mediaMime: media.mime, mediaName: media.name, mediaBytes: media.bytes } : {}),
    },
  });
  return NextResponse.json({ ok: true, queuedTo: targetJid });
}
