import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { loadTeam, makeTeamMatcher, isAutomated } from "@/lib/wa/team";
import { resolveMentionNames } from "@/lib/wa/mentionNames";

// GET /api/whatsapp/groups/:id/messages — the raw chronological message stream
// for a group (the WhatsApp-replica "Inbox" view). Tags each message with the
// actor role (team/customer/lab) so the stream reads like the real chat.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT))
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const { id } = await params;
  const group = await prisma.waGroup.findUnique({ where: { id }, select: { id: true, jid: true, subject: true, role: true, sendEnabled: true } });
  if (!group) return NextResponse.json({ error: "not found" }, { status: 404 });

  const limit = Math.min(Number(new URL(request.url).searchParams.get("limit")) || 200, 400);
  const rows = await prisma.waMessage.findMany({
    where: { groupId: id },
    orderBy: { ts: "desc" },
    take: limit,
    select: {
      id: true, waMsgId: true, fromMe: true, sender: true, senderJid: true, text: true, ts: true,
      intent: true, orderIds: true, requestIds: true, ticketId: true, mediaType: true, replyToWaId: true,
    },
  });
  rows.reverse();

  const team = await loadTeam();
  const matchTeam = makeTeamMatcher(team);
  const messages = rows.map((m) => {
    const tc = m.fromMe ? null : matchTeam(m.sender, m.senderJid);
    const isTeam = m.fromMe || !!tc;
    const role = isTeam ? "Ops" : group.role === "PROVIDER" ? "Lab" : group.role === "SUPPORT" ? "Customer" : "—";
    return {
      id: m.id, waMsgId: m.waMsgId, fromMe: m.fromMe, sender: m.sender, text: m.text, ts: m.ts,
      intent: m.intent, orderId: (m.orderIds || [])[0] ?? null, requestId: (m.requestIds || [])[0] ?? null,
      ticketId: m.ticketId, mediaType: m.mediaType, isTeam, teamName: isAutomated(m) ? "LabStack (automated)" : m.fromMe ? "You" : tc?.name || null, role,
    };
  });

  // Mark the group read.
  prisma.waGroup.update({ where: { id }, data: { lastReadAt: new Date() } }).catch(() => {});

  // "@157140018823280" → a name, for the chat view (see lib/wa/mentionNames).
  const mentions = await resolveMentionNames(rows.map((m) => m.text), { team });

  return NextResponse.json({ group, messages, mentions });
}
