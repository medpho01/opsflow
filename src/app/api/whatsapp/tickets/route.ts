import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

// Focus zones by leverage × urgency. Nothing is hidden — low-signal items sink
// into MUTED. Answerable status/report with an id float to QUICK_ANSWER.
const ACT_NOW = new Set(["ESCALATION", "TECH_ISSUE"]);
const QUICK = new Set(["STATUS_CHECK", "REPORT_REQUEST", "CANCEL_REASON"]);
const NEEDS_CALL = new Set(["RESCHEDULE", "CANCEL_REQUEST", "NEW_BOOKING", "CREATE_ACTION", "PATIENT_DATA"]);
const ASK_LAB = new Set(["SERVICEABILITY", "SLOT_CHECK", "FEASIBILITY_QUOTE"]);
const ESC_RE = /escalat|urgent|asap|multiple|again|not done|still|pending since|reminder|remind|waiting since|very bad|worst/i;

const ZONE_BASE: Record<string, number> = { ACT_NOW: 1000, QUICK_ANSWER: 800, NEEDS_CALL: 600, ASK_LAB: 400, MUTED: 100 };

function zoneOf(intent: string, hasId: boolean): string {
  if (ACT_NOW.has(intent)) return "ACT_NOW";
  if (QUICK.has(intent) && hasId) return "QUICK_ANSWER";
  if (NEEDS_CALL.has(intent)) return "NEEDS_CALL";
  if (ASK_LAB.has(intent)) return "ASK_LAB";
  return "MUTED";
}

// GET /api/whatsapp/tickets?view=active|resolved
export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const view = request.nextUrl.searchParams.get("view") || "active";
  const where = view === "resolved"
    ? { status: { in: ["RESOLVED" as const] } }
    : { status: { notIn: ["RESOLVED" as const] } };

  const rows = await prisma.waTicket.findMany({
    where,
    take: 300,
    orderBy: { lastActivityAt: "desc" },
    include: {
      group: { select: { subject: true, role: true } },
      messages: { orderBy: { ts: "desc" }, take: 1, select: { text: true, sender: true, ts: true, direction: true } },
    },
  });

  const now = Date.now();
  const tickets = rows.map((t) => {
    const hasId = !!(t.orderId || t.requestId);
    const last = t.messages[0] || null;
    const escalating = ESC_RE.test(last?.text || "");
    const zone = zoneOf(t.intent || "", hasId);
    const waiting = t.status === "WAITING_LAB" || t.status === "WAITING_INFO";
    const ageMin = (now - new Date(t.lastActivityAt).getTime()) / 60000;
    const priority = Math.round(
      ZONE_BASE[zone] +
      (escalating ? 200 : 0) +
      Math.min(ageMin, 240) * 0.5 -
      (waiting ? 300 : 0) -
      (t.status === "ANSWERED" ? 250 : 0)
    );
    return {
      id: t.id, status: t.status, intent: t.intent,
      orderId: t.orderId, requestId: t.requestId, context: t.contextSnapshot,
      group: t.group?.subject, groupRole: t.group?.role,
      lastActivityAt: t.lastActivityAt, lastMessage: last,
      zone, priority, escalating, waiting,
    };
  }).sort((a, b) => b.priority - a.priority);

  const zoneCounts = tickets.reduce<Record<string, number>>((a, t) => ((a[t.zone] = (a[t.zone] || 0) + 1), a), {});
  return NextResponse.json({ tickets, zoneCounts, view });
}
