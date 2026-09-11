import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

// GET /api/whatsapp/media/:waMsgId — serve the raw bytes for an image/document
// message so the console can render it. OPS_HEAD only; bytes live in the shared
// taskos DB (wa_media), captured by the gateway.
export async function GET(request: NextRequest, { params }: { params: Promise<{ waMsgId: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT))
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const { waMsgId } = await params;
  const media = await prisma.waMedia.findUnique({ where: { waMsgId }, select: { mime: true, bytes: true } });
  if (!media) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = Buffer.isBuffer(media.bytes) ? media.bytes : Buffer.from(media.bytes);
  return new NextResponse(body as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": media.mime || "application/octet-stream",
      "Content-Length": String(body.length),
      "Cache-Control": "private, max-age=86400",
    },
  });
}
