import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole, Prisma } from "@prisma/client";
import { loadTeam, makeTeamMatcher } from "@/lib/wa/team";
import { patientNames } from "@/lib/wa/patientNames";

export const dynamic = "force-dynamic";

// GET /api/whatsapp/export?type=messages|cases&days=N — CSV download.
//   messages: the raw chat (what is happening), one row per message.
//   cases:    one row per query (pivot by queryType to see the major types).
// CSV opens directly in Excel; no dependency needed.

// Excel-safe CSV cell: quote, double inner quotes, and neutralise embedded
// newlines/CR so a single field never breaks into new rows.
function cell(v: unknown): string {
  let s = v == null ? "" : String(v);
  s = s.replace(new RegExp("[\\r\\n\\u000B\\u000C\\u0085\\u2028\\u2029]+", "g"), " ").trim();
  return `"${s.replace(/"/g, '""')}"`;
}
const row = (cols: unknown[]) => cols.map(cell).join(",");

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT))
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const url = new URL(request.url);
  const t = url.searchParams.get("type");
  const type = t === "cases" ? "cases" : t === "summary" ? "summary" : "messages";
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 7, 1), 90);
  const since = new Date(Date.now() - days * 86400_000);
  const matchTeam = makeTeamMatcher(await loadTeam());
  const roleOf = (grole: string | null, isTeam: boolean) =>
    isTeam ? "Ops" : grole === "PROVIDER" ? "Lab" : grole === "SUPPORT" ? "Customer" : grole === "INTERNAL" ? "Ops" : "—";

  let csv: string;
  let filename: string;

  if (type === "summary") {
    // One row per query type across open cases — the "major types" rollup.
    const rows = await prisma.$queryRaw<Array<{ qt: string; n: bigint }>>`
      SELECT COALESCE(intent, 'OTHER') AS qt, count(*) AS n
      FROM wa_tickets WHERE status <> 'RESOLVED' GROUP BY 1 ORDER BY 2 DESC`;
    const total = rows.reduce((s, r) => s + Number(r.n), 0) || 1;
    const lines = [row(["Query type", "Open cases", "Share %"])];
    for (const r of rows) lines.push(row([r.qt, Number(r.n), ((Number(r.n) / total) * 100).toFixed(1)]));
    lines.push(row(["TOTAL", total, "100.0"]));
    csv = lines.join("\r\n");
    filename = "wa-query-summary.csv";
  } else if (type === "cases") {
    const tickets = await prisma.waTicket.findMany({
      where: { OR: [{ status: { not: "RESOLVED" } }, { resolvedAt: { gte: since } }] },
      orderBy: { lastActivityAt: "desc" },
      take: 10000,
      include: { group: { select: { subject: true, role: true } } },
    });
    const orderIds = [...new Set(tickets.map((t) => t.orderId).filter((x): x is number => !!x))];
    const reqIds = [...new Set(tickets.map((t) => t.requestId).filter((x): x is number => !!x))];
    const names = await patientNames(orderIds, reqIds);
    const briefs = await prisma.waCaseBrief.findMany({
      where: { OR: [{ orderId: { in: orderIds } }, { requestId: { in: reqIds } }] },
      select: { orderId: true, requestId: true, queryType: true, status: true, waiting: true, resolved: true },
    });
    const briefByOrder = new Map(briefs.filter((b) => b.orderId).map((b) => [b.orderId, b]));
    const briefByReq = new Map(briefs.filter((b) => b.requestId).map((b) => [b.requestId, b]));

    const header = ["Case ID", "Origin", "Group", "Order", "Request", "Patient", "Query type", "Status", "Responded via", "First response", "Responder", "AI status", "Next action", "Created", "Last activity", "Resolved at"];
    const lines = [row(header)];
    for (const t of tickets) {
      const b = t.orderId ? briefByOrder.get(t.orderId) : t.requestId ? briefByReq.get(t.requestId) : null;
      const patient = (t.orderId && names[`o${t.orderId}`]) || (t.requestId && names[`r${t.requestId}`]) || "";
      lines.push(row([
        t.id, t.origin === "PROVIDER" ? "Provider request" : "Customer query", t.group?.subject || "", t.orderId || "", t.requestId || "", patient,
        b?.queryType || t.intent || "OTHER", t.status, t.respondedVia || "", t.firstResponseAt?.toISOString() || "", t.lastResponderName || "",
        b?.status || "", b?.waiting || "",
        t.createdAt.toISOString(), t.lastActivityAt.toISOString(), t.resolvedAt?.toISOString() || "",
      ]));
    }
    csv = lines.join("\r\n");
    filename = `wa-queries-${days}d.csv`;
  } else {
    const msgs = await prisma.waMessage.findMany({
      where: { ts: { gte: since } },
      orderBy: { ts: "asc" },
      take: 50000,
      select: { ts: true, direction: true, fromMe: true, sender: true, senderJid: true, text: true, ocrText: true, mediaType: true, intent: true, orderIds: true, group: { select: { subject: true, role: true } } },
    });
    const header = ["Time", "Customer/Group", "Group role", "Actor", "Sender", "Direction", "Order id(s)", "Intent", "Attachment", "Message", "Image summary"];
    const lines = [row(header)];
    for (const m of msgs) {
      const isTeam = m.fromMe || !!matchTeam(m.sender, m.senderJid);
      lines.push(row([
        m.ts.toISOString(), m.group?.subject || "", m.group?.role || "", roleOf(m.group?.role ?? null, isTeam),
        m.fromMe ? "You" : m.sender, m.direction, (m.orderIds || []).join(" "), m.intent || "", m.mediaType || "", m.text, m.ocrText || "",
      ]));
    }
    csv = lines.join("\r\n");
    filename = `wa-chats-${days}d.csv`;
  }

  // BOM so Excel reads UTF-8 (names, ₹, emoji) correctly.
  return new NextResponse("﻿" + csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
