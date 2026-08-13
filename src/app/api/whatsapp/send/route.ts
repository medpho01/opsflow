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

  const body = await request.json().catch(() => ({}));
  const text = String(body?.text || "").trim();
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });

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

  await prisma.waOutbound.create({ data: { targetJid, text, groupId, createdById: user.id } });
  return NextResponse.json({ ok: true, queuedTo: targetJid });
}
