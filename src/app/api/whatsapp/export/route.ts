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
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const url = new URL(request.url);
  const type = url.searchParams.get("type") === "cases" ? "cases" : "messages";
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 7, 1), 90);
  const since = new Date(Date.now() - days * 86400_000);
  const matchTeam = makeTeamMatcher(await loadTeam());
  const roleOf = (grole: string | null, isTeam: boolean) =>
    isTeam ? "Ops" : grole === "PROVIDER" ? "Lab" : grole === "SUPPORT" ? "Customer" : grole === "INTERNAL" ? "Ops" : "—";

  let csv: string;
  let filename: string;

  if (type === "cases") {
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

    const header = ["Case ID", "Customer group", "Order", "Request", "Patient", "Query type", "Status", "AI status", "Next action", "Created", "Last activity", "Resolved at"];
    const lines = [row(header)];
    for (const t of tickets) {
      const b = t.orderId ? briefByOrder.get(t.orderId) : t.requestId ? briefByReq.get(t.requestId) : null;
      const patient = (t.orderId && names[`o${t.orderId}`]) || (t.requestId && names[`r${t.requestId}`]) || "";
      lines.push(row([
        t.id, t.group?.subject || "", t.orderId || "", t.requestId || "", patient,
        b?.queryType || t.intent || "OTHER", t.status, b?.status || "", b?.waiting || "",
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
      select: { ts: true, direction: true, fromMe: true, sender: true, senderJid: true, text: true, ocrText: true, intent: true, orderIds: true, group: { select: { subject: true, role: true } } },
    });
    const header = ["Time", "Customer/Group", "Group role", "Actor", "Sender", "Direction", "Order id(s)", "Intent", "Message", "Image summary"];
    const lines = [row(header)];
    for (const m of msgs) {
      const isTeam = m.fromMe || !!matchTeam(m.sender, m.senderJid);
      lines.push(row([
        m.ts.toISOString(), m.group?.subject || "", m.group?.role || "", roleOf(m.group?.role ?? null, isTeam),
        m.fromMe ? "You" : m.sender, m.direction, (m.orderIds || []).join(" "), m.intent || "", m.text, m.ocrText || "",
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
