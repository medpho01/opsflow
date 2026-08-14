import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import labstack, { labstackOr } from "@/lib/db/labstack";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole, WaTicketStatus, Prisma } from "@prisma/client";
import { patientNameFor, patientNames } from "@/lib/wa/patientNames";
import { loadTeam, makeTeamMatcher } from "@/lib/wa/team";

// GET /api/whatsapp/tickets/:id — ticket + full thread + live order context
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const { id } = await params;
  const ticket = await prisma.waTicket.findUnique({
    where: { id },
    include: { group: true },
  });
  if (!ticket) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Opening a conversation marks the group read (clears its unread count).
  prisma.waGroup.update({ where: { id: ticket.groupId }, data: { lastReadAt: new Date() } }).catch(() => {});

  // Thread the conversation to THIS order/request (the case) when we have an id,
  // so the agent works one order in isolation. Fall back to the group thread.
  let msgs: Prisma.WaMessageGetPayload<object>[] = [];
  if (ticket.orderId || ticket.requestId) {
    const where: Prisma.WaMessageWhereInput = ticket.orderId
      ? { groupId: ticket.groupId, orderIds: { has: ticket.orderId } }
      : { groupId: ticket.groupId, requestIds: { has: ticket.requestId! } };
    msgs = await prisma.waMessage.findMany({ where, orderBy: { ts: "asc" }, take: 120 });
  }
  if (msgs.length < 2) {
    const recent = await prisma.waMessage.findMany({ where: { groupId: ticket.groupId }, orderBy: { ts: "desc" }, take: 120 });
    msgs = recent.reverse();
  }
  const groupMessages = msgs;
  const patient = await patientNameFor(ticket.orderId, ticket.requestId);

  // Identify OUR team (roster) so team replies are distinct from customer msgs.
  const team = await loadTeam();
  const matchTeam = makeTeamMatcher(team);
  const taggedMsgs = groupMessages.map((m) => {
    const tc = m.fromMe ? null : matchTeam(m.sender, m.senderJid);
    return { ...m, isTeam: m.fromMe || !!tc, teamName: m.fromMe ? "You" : tc?.name || null };
  });
  const handledMsg = [...taggedMsgs].reverse().find((m) => m.isTeam);
  const lastHandledBy = handledMsg ? { name: handledMsg.teamName || "Team", ts: handledMsg.ts } : null;

  // Resolve @mentions (e.g. "@919811111111" / "@271686813356076") to names.
  // Two sources: the team roster, and anyone who has spoken in the thread
  // (their senderJid → pushName). Keyed by the full local-part and its last 10
  // digits so a phone-jid mention and a roster phone line up.
  const last10 = (s: string) => (s || "").replace(/\D/g, "").slice(-10);
  const mentions: Record<string, string> = {};
  const addMention = (idDigits: string, name?: string | null) => {
    if (!idDigits || !name) return;
    mentions[idDigits] = name;
    const l10 = idDigits.slice(-10);
    if (l10 && !mentions[l10]) mentions[l10] = name;
  };
  for (const t of team) {
    const d = (t.phone || "").replace(/\D/g, "");
    if (d) addMention(d, t.name);
  }
  for (const m of taggedMsgs) {
    const d = (m.senderJid || "").split("@")[0].replace(/\D/g, "");
    if (d) addMention(d, m.teamName || m.sender);
  }
  // Only expose the mentions actually referenced in the thread's text.
  const mentionMap: Record<string, string> = {};
  const mentionRe = /@(\d{5,})/g;
  for (const m of taggedMsgs) {
    let mm: RegExpExecArray | null;
    const re = new RegExp(mentionRe.source, "g");
    while ((mm = re.exec(m.text || ""))) {
      const raw = mm[1];
      const name = mentions[raw] || mentions[last10(raw)];
      if (name) mentionMap[raw] = name;
    }
  }

  // Cross-group activity for THIS order: a Store case surfaces the Provider's
  // status; a Provider case surfaces the Store's question. Maps status ↔ query.
  let related: Array<{ groupId: string; groupSubject: string; groupRole: string; sender: string; text: string; ts: Date }> = [];
  if (ticket.orderId || ticket.requestId) {
    const relWhere: Prisma.WaMessageWhereInput = {
      NOT: { groupId: ticket.groupId },
      ...(ticket.orderId ? { orderIds: { has: ticket.orderId } } : { requestIds: { has: ticket.requestId! } }),
    };
    const rows = await prisma.waMessage.findMany({
      where: relWhere, orderBy: { ts: "desc" }, take: 20,
      include: { group: { select: { id: true, subject: true, role: true } } },
    });
    related = rows.map((m) => ({ groupId: m.group.id, groupSubject: m.group.subject, groupRole: m.group.role, sender: m.sender, text: m.text, ts: m.ts }));
  }

  // Auto-close signal: nudge the agent to resolve when the case looks handled —
  // our team has replied AND the newest message in the thread is that reply
  // (the ball is no longer in the customer's court). Stronger when a provider
  // status has also landed for this order (query ↔ status closed).
  const newest = taggedMsgs[taggedMsgs.length - 1];
  const suggestResolve =
    ticket.status !== "RESOLVED" && lastHandledBy && newest?.isTeam
      ? {
          reason:
            related.length > 0
              ? `${lastHandledBy.name} replied after the provider's update — looks resolved.`
              : `${lastHandledBy.name} sent the last reply — looks handled.`,
        }
      : null;

  // Full cross-group journey for THIS order: every message that referenced it,
  // in ANY group, in time order. An agent juggling many orders across groups
  // can miss that the lab already answered in another thread — this stitches
  // the whole story into one timeline so the current state is obvious.
  let timeline: Array<{
    id: string; groupId: string; groupSubject: string; groupRole: string;
    sender: string; text: string; intent: string | null; ts: Date;
    isTeam: boolean; teamName: string | null; isCurrentGroup: boolean;
  }> = [];
  if (ticket.orderId || ticket.requestId) {
    const tlWhere: Prisma.WaMessageWhereInput = ticket.orderId
      ? { orderIds: { has: ticket.orderId } }
      : { requestIds: { has: ticket.requestId! } };
    const rows = await prisma.waMessage.findMany({
      where: tlWhere, orderBy: { ts: "asc" }, take: 100,
      include: { group: { select: { id: true, subject: true, role: true } } },
    });
    timeline = rows.map((m) => {
      const tc = m.fromMe ? null : matchTeam(m.sender, m.senderJid);
      return {
        id: m.id, groupId: m.group.id, groupSubject: m.group.subject, groupRole: m.group.role,
        sender: m.sender, text: m.text, intent: m.intent, ts: m.ts,
        isTeam: m.fromMe || !!tc, teamName: m.fromMe ? "You" : tc?.name || null,
        isCurrentGroup: m.group.id === ticket.groupId,
      };
    });
  }

  // Best-effort live context from the LabStack replica (falls back to snapshot).
  let live: unknown = null;
  if (ticket.orderId) {
    const rows = await labstackOr(
      labstack.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, "orderStatus", "appointmentTime", "phleboName", "phleboNumber",
               "statusUpdatedAt", "cancelReason", "labId", "orderType"
        FROM public."Order" WHERE id = ${ticket.orderId} LIMIT 1`,
      [] as Array<Record<string, unknown>>, 4000, { breakerKey: "wa-order-ctx" }
    );
    live = rows[0] || null;
  } else if (ticket.requestId) {
    const rows = await labstackOr(
      labstack.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, status, "createdAt", "isServiceable", "quotedPrice"
        FROM public."Request" WHERE id = ${ticket.requestId} LIMIT 1`,
      [] as Array<Record<string, unknown>>, 4000, { breakerKey: "wa-req-ctx" }
    );
    live = rows[0] || null;
  }

  // #1 Bulk status — one message often lists many orders ("71708 71961 …
  // sample collection status"). Pull the latest status for EVERY order named
  // across this case's thread so the agent can answer all of them at once.
  const bulkOrderIds = [...new Set(taggedMsgs.flatMap((m) => m.orderIds || []))].filter(Boolean);
  let bulkStatuses: Array<{ orderId: number; status: string | null; appt: string | null; patient: string | null }> = [];
  if (bulkOrderIds.length > 1) {
    const rows = await labstackOr(
      labstack.$queryRaw<Array<{ id: number; status: string | null; appt: Date | null }>>(
        Prisma.sql`SELECT id, "orderStatus"::text AS status, "appointmentTime" AS appt
                   FROM public."Order" WHERE id IN (${Prisma.join(bulkOrderIds)})`
      ),
      [] as Array<{ id: number; status: string | null; appt: Date | null }>, 5000, { breakerKey: "wa-bulk-ctx" }
    );
    const names = await patientNames(bulkOrderIds, []);
    const byId = new Map(rows.map((r) => [r.id, r]));
    bulkStatuses = bulkOrderIds
      .map((oid) => ({ orderId: oid, status: byId.get(oid)?.status ?? null, appt: byId.get(oid)?.appt ? String(byId.get(oid)!.appt) : null, patient: names[`o${oid}`] || null }))
      .sort((a, b) => a.orderId - b.orderId);
  }

  // #2 Reply targets. Store = this group. Lab = a PROVIDER group for the order's
  // OWN lab (from live context), falling back to the store group's mapped lab.
  // Also expose every provider group so the agent can pick when none is mapped.
  const orderLabId = (live as { labId?: number } | null)?.labId ?? ticket.group?.labId ?? null;
  let labGroup: { id: string; jid: string; subject: string; labId: number | null } | null = null;
  let lab: { id: number; name: string | null; city: string | null } | null = null;
  if (orderLabId) {
    labGroup = await prisma.waGroup.findFirst({
      where: { role: "PROVIDER", labId: orderLabId },
      select: { id: true, jid: true, subject: true, labId: true },
    });
    // The lab the order is actually assigned to (real name from the replica).
    const labRows = await labstackOr(
      labstack.$queryRaw<Array<{ id: number; name: string | null; city: string | null }>>`
        SELECT id, "labName" AS name, city FROM public."Lab" WHERE id = ${orderLabId} LIMIT 1`,
      [] as Array<{ id: number; name: string | null; city: string | null }>, 3000, { breakerKey: "wa-lab-name" }
    );
    lab = labRows[0] || null;
  }
  const providerGroups = await prisma.waGroup.findMany({
    where: { role: "PROVIDER", active: true },
    select: { id: true, jid: true, subject: true, labId: true },
    orderBy: { subject: "asc" },
  });

  // Delivery status of replies we sent from the console for this case, so the
  // agent sees QUEUED / SENT / FAILED (+reason) instead of a silent void.
  const outbound = await prisma.waOutbound.findMany({
    where: { ticketId: ticket.id },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { id: true, text: true, status: true, error: true, targetJid: true, createdAt: true, sentAt: true },
  });

  return NextResponse.json({
    ticket: {
      id: ticket.id, status: ticket.status, intent: ticket.intent,
      orderId: ticket.orderId, requestId: ticket.requestId,
      contextSnapshot: ticket.contextSnapshot, liveContext: live, patient, lastHandledBy,
      assignedToId: ticket.assignedToId, slaDueAt: ticket.slaDueAt,
      lastActivityAt: ticket.lastActivityAt, createdAt: ticket.createdAt,
    },
    group: ticket.group
      ? { id: ticket.group.id, jid: ticket.group.jid, subject: ticket.group.subject, role: ticket.group.role, storeId: ticket.group.storeId, labId: ticket.group.labId, sendEnabled: ticket.group.sendEnabled }
      : null,
    labGroup,
    lab,
    providerGroups,
    outbound,
    bulkStatuses,
    related,
    timeline,
    mentions: mentionMap,
    suggestResolve,
    messages: taggedMsgs.map((m) => ({
      id: m.id, direction: m.direction, fromMe: m.fromMe, sender: m.sender,
      text: m.text, ts: m.ts, intent: m.intent, waMsgId: m.waMsgId,
      ticketId: m.ticketId, isTeam: m.isTeam, teamName: m.teamName,
      mediaType: m.mediaType, mediaMime: m.mediaMime, ocrText: m.ocrText, ocrJson: m.ocrJson,
      idType: m.idType, idVia: m.idVia,
    })),
  });
}

// PATCH /api/whatsapp/tickets/:id — change status / assignment
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const data: Record<string, unknown> = {};
  if (body.status !== undefined) {
    if (!Object.values(WaTicketStatus).includes(body.status))
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    data.status = body.status;
    if (body.status === "RESOLVED") data.resolvedAt = new Date();
  }
  if (body.assignedToId !== undefined) data.assignedToId = body.assignedToId === null ? null : Number(body.assignedToId);
  if (Object.keys(data).length === 0) return NextResponse.json({ error: "no fields" }, { status: 400 });

  try {
    const ticket = await prisma.waTicket.update({ where: { id }, data });
    return NextResponse.json({ ticket });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
