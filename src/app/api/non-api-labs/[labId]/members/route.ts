/**
 * GET /api/non-api-labs/:labId/members — people who wrote in the lab's WhatsApp
 * group in the last 30 days, lab people first and busiest first, with the one
 * the bot @mentions automatically (lib/wa/coordinators.ts) marked `auto`.
 */
import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { groupMembers } from "@/lib/wa/coordinators";

export async function GET(request: NextRequest, { params }: { params: Promise<{ labId: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_ADMIN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  const labId = Number((await params).labId);
  const jid = request.nextUrl.searchParams.get("groupJid")
    ?? (await prisma.nonApiLabConfig.findUnique({ where: { labId }, select: { waGroupJid: true } }))?.waGroupJid;
  if (!jid) return NextResponse.json({ members: [] });
  const members = await groupMembers(jid);
  const autoJid = members.find((member) => !member.team)?.jid ?? null;
  return NextResponse.json({ members: members.map((member) => ({ ...member, auto: member.jid === autoJid })) });
}
