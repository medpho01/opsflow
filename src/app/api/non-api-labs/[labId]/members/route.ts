/**
 * GET /api/non-api-labs/:labId/members — people who write in the lab's WhatsApp
 * group, for picking its coordinators (the people every bot message
 * @mentions). Lab people first, busiest first: the busiest lab-side writer is
 * almost always the coordinator. LabStack's own team is listed after, marked.
 */
import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { loadTeam, makeTeamMatcher } from "@/lib/wa/team";

export async function GET(request: NextRequest, { params }: { params: Promise<{ labId: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_ADMIN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  const labId = Number((await params).labId);
  const jid = request.nextUrl.searchParams.get("groupJid")
    ?? (await prisma.nonApiLabConfig.findUnique({ where: { labId }, select: { waGroupJid: true } }))?.waGroupJid;
  if (!jid) return NextResponse.json({ members: [] });
  const group = await prisma.waGroup.findUnique({ where: { jid }, select: { id: true } });
  if (!group) return NextResponse.json({ members: [] });

  const rows = await prisma.waMessage.groupBy({
    by: ["senderJid"],
    where: { groupId: group.id, fromMe: false, senderJid: { not: null } },
    _count: { _all: true },
    _max: { ts: true },
  });
  const names = await prisma.waMessage.findMany({
    where: { groupId: group.id, fromMe: false, senderJid: { in: rows.map((r) => r.senderJid!) }, sender: { not: "" } },
    distinct: ["senderJid"],
    orderBy: { ts: "desc" },
    select: { senderJid: true, sender: true },
  });
  const nameOf = new Map(names.map((n) => [n.senderJid, n.sender]));
  const matchTeam = makeTeamMatcher(await loadTeam());
  const members = rows.map((r) => {
    const name = nameOf.get(r.senderJid) ?? r.senderJid!.split("@")[0];
    const team = !!matchTeam(name, r.senderJid) || /labstack/i.test(name);
    return { jid: r.senderJid!, name, messages: r._count._all, lastAt: r._max.ts, team };
  }).sort((a, b) => Number(a.team) - Number(b.team) || b.messages - a.messages);
  return NextResponse.json({ members });
}
