import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

// GET /api/whatsapp/groups/:id/participants — the people who can be @-mentioned
// in this group's chat: everyone who has spoken in it. Returns { name, jid,
// localpart } so the composer can insert "@Name" and send with the real jid.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT))
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const { id } = await params;
  const rows = await prisma.waMessage.findMany({
    where: { groupId: id, fromMe: false, senderJid: { not: null }, sender: { not: "" } },
    distinct: ["senderJid"],
    orderBy: { ts: "desc" },
    take: 300,
    select: { sender: true, senderJid: true },
  });

  const seen = new Set<string>();
  const participants = rows
    .filter((r) => r.senderJid && !seen.has(r.senderJid) && seen.add(r.senderJid))
    .map((r) => ({
      name: r.sender || (r.senderJid || "").split("@")[0],
      jid: r.senderJid as string,
      localpart: (r.senderJid as string).split("@")[0],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ participants });
}
