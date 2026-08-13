import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

export const dynamic = "force-dynamic";

const ANSWERABLE = new Set(["STATUS_CHECK", "REPORT_REQUEST", "CANCEL_REASON"]);
const ESC_RE = /escalat|urgent|asap|multiple|again|not done|still|pending since|reminder|remind|very bad|worst/i;

// One row per group, WhatsApp-style: latest message, unread count, and the
// top pending action. Sorted by most recent activity.
const SQL = `
WITH latest AS (
  SELECT DISTINCT ON ("groupId") "groupId", text, sender, ts, direction, "fromMe"
  FROM wa_messages ORDER BY "groupId", ts DESC
),
unread AS (
  SELECT m."groupId", count(*)::int n FROM wa_messages m JOIN wa_groups g ON g.id = m."groupId"
  WHERE m.direction = 'IN' AND (g."lastReadAt" IS NULL OR m.ts > g."lastReadAt")
  GROUP BY m."groupId"
),
opentix AS (
  SELECT "groupId", count(*)::int n FROM wa_tickets WHERE status <> 'RESOLVED' GROUP BY "groupId"
),
toptix AS (
  SELECT DISTINCT ON ("groupId") "groupId", id AS ticket_id, intent, "orderId", "requestId", status
  FROM wa_tickets ORDER BY "groupId", (status <> 'RESOLVED') DESC, "lastActivityAt" DESC
),
brk AS (
  SELECT "groupId", jsonb_object_agg(intent, n) obj FROM (
    SELECT "groupId", COALESCE(intent, 'OTHER') intent, count(*)::int n
    FROM wa_tickets WHERE status <> 'RESOLVED' GROUP BY "groupId", COALESCE(intent, 'OTHER')
  ) s GROUP BY "groupId"
)
SELECT g.id, g.subject, g.role,
       l.text AS last_text, l.sender AS last_sender, l.ts AS last_ts, l.direction AS last_dir, l."fromMe" AS last_fromme,
       COALESCE(u.n, 0) AS unread, COALESCE(o.n, 0) AS open_tickets,
       t.ticket_id, t.intent AS top_intent, t."orderId" AS top_order, t."requestId" AS top_request, t.status AS top_status,
       b.obj AS breakdown
FROM wa_groups g
JOIN latest l ON l."groupId" = g.id
LEFT JOIN unread u ON u."groupId" = g.id
LEFT JOIN opentix o ON o."groupId" = g.id
LEFT JOIN toptix t ON t."groupId" = g.id
LEFT JOIN brk b ON b."groupId" = g.id
WHERE g.active AND g.role <> 'IGNORE'
ORDER BY l.ts DESC
LIMIT 250`;

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(SQL);

  let totalUnread = 0;
  const conversations = rows.map((r) => {
    const unread = Number(r.unread) || 0;
    totalUnread += unread;
    const intent = (r.top_intent as string) || null;
    const hasId = !!(r.top_order || r.top_request);
    return {
      groupId: r.id, subject: r.subject, role: r.role,
      ticketId: r.ticket_id || null,
      lastText: r.last_text, lastSender: r.last_sender, lastTs: r.last_ts,
      lastFromMe: r.last_fromme, lastDir: r.last_dir,
      unread, openTickets: Number(r.open_tickets) || 0,
      topIntent: intent, topOrderId: r.top_order || r.top_request || null,
      breakdown: (r.breakdown as Record<string, number>) || {},
      answerReady: hasId && ANSWERABLE.has(intent || "") && (r.top_status as string) !== "RESOLVED",
      escalating: ESC_RE.test((r.last_text as string) || ""),
    };
  });

  return NextResponse.json({ conversations, totalUnread });
}
