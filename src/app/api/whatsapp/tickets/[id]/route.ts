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

  // Recognise the order from the CONVERSATION when the case opened id-less. The
  // same thread usually names the order id or the lab reference id in a nearby
  // message (a lab reply, an image caption, "VL7CAE0F - schedule for…"). Adopt it
  // so the case resolves patient / status / lab instead of sitting id-less, and
  // persist it so the whole thread carries the context going forward.
  if (!ticket.orderId && !ticket.requestId) {
    type ConvMsg = { text: string; orderIds: number[]; requestIds: number[]; refIds: string[] };
    const scan = (where: Prisma.WaMessageWhereInput, take: number) =>
      prisma.waMessage.findMany({ where, orderBy: { ts: "desc" }, take, select: { text: true, orderIds: true, requestIds: true, refIds: true } }) as Promise<ConvMsg[]>;
    // Lab reference ids in a set of messages → distinct order ids. Uses stored
    // refIds AND a broad re-scan of the text (formats like "VL7CAE0F" the
    // gateway's narrow extractor can miss); every candidate is validated against
    // Order.labOrderId, so non-refs drop.
    const refsToOrders = async (msgs: ConvMsg[]): Promise<number[]> => {
      const refSet = new Set<string>();
      for (const m of msgs) {
        for (const r of m.refIds || []) refSet.add(r.toUpperCase());
        for (const tok of (m.text || "").toUpperCase().match(/\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{6,14}\b/g) || []) refSet.add(tok);
      }
      const refs = [...refSet].slice(0, 40);
      if (!refs.length) return [];
      const rows = await labstackOr(
        labstack.$queryRaw<Array<{ id: number }>>`SELECT DISTINCT id FROM public."Order" WHERE upper("labOrderId") IN (${Prisma.join(refs)})`,
        [] as Array<{ id: number }>,
      );
      return rows.map((r) => r.id);
    };

    let adoptOrder: number | null = null;
    let adoptRequest: number | null = null;

    // 1) This case's own thread — trust the most recent id it carries.
    const own = await scan({ ticketId: id }, 80);
    for (const m of own) {
      if (m.orderIds?.length) { adoptOrder = m.orderIds[0]; break; }
      if (m.requestIds?.length) { adoptRequest = m.requestIds[0]; break; }
    }
    if (!adoptOrder && !adoptRequest) {
      const ords = await refsToOrders(own);
      if (ords.length === 1) adoptOrder = ords[0];
    }

    // 2) Conversation-window fallback — the displayed thread is usually the group
    // timeline, not this ticket's messages, and a busy lab group discusses many
    // orders. Bound to the time window around THIS case and bind to the order in
    // the id-bearing message CLOSEST to it — the nearest context wins.
    if (!adoptOrder && !adoptRequest) {
      const anchors = (own.length ? await prisma.waMessage.findMany({ where: { ticketId: id }, select: { ts: true } }) : [])
        .map((m) => m.ts.getTime());
      if (!anchors.length) anchors.push((ticket.lastActivityAt || ticket.createdAt).getTime());
      const lo = new Date(Math.min(...anchors) - 120 * 60000);
      const hi = new Date(Math.max(...anchors) + 120 * 60000);
      const near = await prisma.waMessage.findMany({
        where: { groupId: ticket.groupId, ts: { gte: lo, lte: hi } },
        orderBy: { ts: "asc" }, take: 300,
        select: { ts: true, text: true, orderIds: true, refIds: true },
      });
      // Resolve every lab ref seen in the window to an order, once.
      const refSet = new Set<string>();
      for (const m of near) {
        for (const r of m.refIds || []) refSet.add(r.toUpperCase());
        for (const tok of (m.text || "").toUpperCase().match(/\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{6,14}\b/g) || []) refSet.add(tok);
      }
      const refList = [...refSet].slice(0, 60);
      const refRows = refList.length
        ? await labstackOr(
            labstack.$queryRaw<Array<{ id: number; ref: string }>>`SELECT id, upper("labOrderId") AS ref FROM public."Order" WHERE upper("labOrderId") IN (${Prisma.join(refList)})`,
            [] as Array<{ id: number; ref: string }>,
          )
        : [];
      const refMap = new Map(refRows.map((r) => [r.ref, r.id]));
      let bestDist = Infinity;
      for (const m of near) {
        const ords = new Set<number>(m.orderIds || []);
        for (const r of m.refIds || []) { const o = refMap.get(r.toUpperCase()); if (o) ords.add(o); }
        for (const tok of (m.text || "").toUpperCase().match(/\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{6,14}\b/g) || []) { const o = refMap.get(tok); if (o) ords.add(o); }
        if (!ords.size) continue;
        const dist = Math.min(...anchors.map((a) => Math.abs(a - m.ts.getTime())));
        if (dist < bestDist) { bestDist = dist; adoptOrder = [...ords][0]; }
      }
    }

    if (adoptOrder || adoptRequest) {
      ticket.orderId = adoptOrder;
      ticket.requestId = adoptRequest;
      await prisma.waTicket.update({ where: { id }, data: { orderId: adoptOrder, requestId: adoptRequest } }).catch(() => {});
      if (adoptOrder) {
        await prisma.$executeRaw`UPDATE wa_messages SET "orderIds" = array_append("orderIds", ${adoptOrder}) WHERE "ticketId" = ${id} AND NOT (${adoptOrder} = ANY("orderIds"))`.catch(() => {});
      }
    }
  }

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
  const handledIdx = taggedMsgs.map((m) => m.isTeam).lastIndexOf(true);
  const handledMsg = handledIdx >= 0 ? taggedMsgs[handledIdx] : null;
  // How much customer/store/lab activity has landed AFTER our team's last reply.
  // A "last handled" time next to newer unanswered messages reads as handled when
  // the case is actually cold — so surface the gap.
  const newSince = handledIdx >= 0 ? taggedMsgs.slice(handledIdx + 1).filter((m) => !m.isTeam).length : taggedMsgs.filter((m) => !m.isTeam).length;
  const lastHandledBy = handledMsg ? { name: handledMsg.teamName || "Team", ts: handledMsg.ts, newSince } : null;

  // Which media messages actually have their bytes stored? A message can carry a
  // mediaType (we saw the attachment) yet have no bytes — download failed, or it
  // arrived via history where WhatsApp no longer serves the media. The console
  // must say so honestly instead of rendering an invisible broken image.
  const mediaWaIds = taggedMsgs.filter((m) => m.mediaType).map((m) => m.waMsgId);
  const mediaBytesSet = new Set<string>();
  if (mediaWaIds.length) {
    const have = await prisma.waMedia.findMany({ where: { waMsgId: { in: mediaWaIds } }, select: { waMsgId: true } });
    for (const r of have) mediaBytesSet.add(r.waMsgId);
  }

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
  const unresolved = new Set<string>();
  const mentionRe = /@(\d{5,})/g;
  for (const m of taggedMsgs) {
    let mm: RegExpExecArray | null;
    const re = new RegExp(mentionRe.source, "g");
    while ((mm = re.exec(m.text || ""))) {
      const raw = mm[1];
      const name = mentions[raw] || mentions[last10(raw)];
      if (name) mentionMap[raw] = name;
      else unresolved.add(raw);
    }
  }
  // Resolve leftover @mentions (often WhatsApp LID numbers, not phones) against
  // anyone who has EVER spoken — their senderJid local-part → pushName.
  if (unresolved.size) {
    const ids = [...unresolved];
    const rows = await prisma.$queryRaw<Array<{ lp: string; sender: string }>>(
      Prisma.sql`SELECT DISTINCT split_part("senderJid", '@', 1) AS lp, sender
                 FROM wa_messages
                 WHERE "senderJid" IS NOT NULL AND sender <> ''
                   AND split_part("senderJid", '@', 1) IN (${Prisma.join(ids)})`
    ).catch(() => []);
    for (const r of rows) if (r.lp && r.sender && !mentionMap[r.lp]) mentionMap[r.lp] = r.sender;
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
               "statusUpdatedAt", "cancelReason", "labId", "orderType", "labOrderId"
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

  // #1 Bulk status — ONLY when a single message genuinely lists many orders
  // ("71708 71961 … sample collection status"). Previously we unioned every
  // order across the whole thread, which made a single-order case look like it
  // had 27 orders. Now we take the one message with the most ids (if >1).
  const multiMsg = taggedMsgs
    .filter((m) => (m.orderIds || []).length > 1)
    .sort((a, b) => (b.orderIds?.length || 0) - (a.orderIds?.length || 0))[0];
  const bulkOrderIds = multiMsg ? [...new Set(multiMsg.orderIds)] : [];
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
  // Fallback: if no provider group is id-mapped to this lab yet, match by name
  // (lab "Orange Health - Hyderabad" → group "LS <> Orange Ops") so the agent
  // doesn't have to pick the lab that we already know.
  if (!labGroup && lab?.name) {
    const kw = lab.name
      .split(/[\s\-<>|.,]+/)
      .find((w) => w.length > 2 && !/^(health|healthtech|diagnostics?|labs?|lab|centre|center|pvt|ltd|llp|the|and)$/i.test(w));
    if (kw) {
      labGroup = await prisma.waGroup.findFirst({
        where: { role: "PROVIDER", active: true, subject: { contains: kw, mode: "insensitive" } },
        select: { id: true, jid: true, subject: true, labId: true },
      });
    }
  }
  const providerGroups = await prisma.waGroup.findMany({
    where: { role: "PROVIDER", active: true },
    select: { id: true, jid: true, subject: true, labId: true },
    orderBy: { subject: "asc" },
  });

  // LLM case brief (status / timeline / resolution / suggestions), keyed by the
  // canonical order or request. Produced continuously by the gateway analyst.
  const brief = (ticket.orderId || ticket.requestId)
    ? await prisma.waCaseBrief.findFirst({
        where: ticket.orderId ? { orderId: ticket.orderId } : { requestId: ticket.requestId! },
      })
    : null;

  // Delivery status of replies we sent from the console for this case, so the
  // agent sees QUEUED / SENT / FAILED (+reason) instead of a silent void.
  const outbound = await prisma.waOutbound.findMany({
    where: { ticketId: ticket.id },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { id: true, text: true, status: true, error: true, targetJid: true, createdAt: true, sentAt: true },
  });

  // Have we already asked the lab and are we still waiting on their reply? Lets
  // the console show "asked 2h ago · no reply yet" so we don't re-ping the lab
  // every time the case is opened. A lab reply = any inbound in that group after
  // our ask.
  const provForAsk = [...providerGroups, ...(labGroup ? [labGroup] : [])];
  const jidToGroupId = new Map(provForAsk.map((g) => [g.jid, g.id] as const));
  let labAsk: { askedAt: string; awaiting: boolean; repliedAt: string | null; status: string; targetJid: string } | null = null;
  if (jidToGroupId.size > 0) {
    const lastAsk = await prisma.waOutbound.findFirst({
      where: { ticketId: ticket.id, targetJid: { in: [...jidToGroupId.keys()] }, status: { in: ["QUEUED", "SENT"] } },
      orderBy: { createdAt: "desc" },
      select: { targetJid: true, createdAt: true, sentAt: true, status: true },
    });
    if (lastAsk) {
      const since = lastAsk.sentAt ?? lastAsk.createdAt;
      const gid = jidToGroupId.get(lastAsk.targetJid);
      const reply = gid
        ? await prisma.waMessage.findFirst({
            where: { groupId: gid, direction: "IN", fromMe: false, ts: { gt: since } },
            orderBy: { ts: "asc" },
            select: { ts: true },
          })
        : null;
      labAsk = {
        askedAt: since.toISOString(),
        awaiting: !reply,
        repliedAt: reply ? reply.ts.toISOString() : null,
        status: lastAsk.status,
        targetJid: lastAsk.targetJid,
      };
    }
  }

  return NextResponse.json({
    ticket: {
      id: ticket.id, status: ticket.status, intent: ticket.intent,
      orderId: ticket.orderId, requestId: ticket.requestId,
      // Entity-resolution provenance — which namespace the id resolved to, how
      // sure we are, any staleness warning, and the runner-up to switch to.
      entity: {
        kind: ticket.entityKind || (ticket.orderId ? "ORDER" : ticket.requestId ? "REQUEST" : null),
        confidence: ticket.idConfidence || "high",
        warning: ticket.idWarning || null,
        alt: (ticket.idAlt as { kind: string; id: number } | null) || null,
      },
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
    labAsk,
    brief,
    bulkStatuses,
    related,
    timeline,
    mentions: mentionMap,
    suggestResolve,
    messages: taggedMsgs.map((m) => ({
      id: m.id, direction: m.direction, fromMe: m.fromMe, sender: m.sender,
      text: m.text, ts: m.ts, intent: m.intent, waMsgId: m.waMsgId,
      ticketId: m.ticketId, isTeam: m.isTeam, teamName: m.teamName,
      mediaType: m.mediaType, mediaMime: m.mediaMime, hasBytes: mediaBytesSet.has(m.waMsgId),
      ocrText: m.ocrText, ocrJson: m.ocrJson,
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

  // Manually (re)bind the case to the correct entity: link an order/request id
  // when a thread lost it, or SWAP to the resolver's runner-up when it guessed
  // wrong (a live reschedule that bound to a year-old delivered order). Validate
  // against the replica, clear the low-confidence warning (human-confirmed), and
  // re-tag the thread so context/timeline resolve to the right thing.
  if (body.orderId === null) data.orderId = null;
  if (body.requestId === null) data.requestId = null;

  const bind = body.swapTo?.kind && body.swapTo?.id
    ? { kind: String(body.swapTo.kind).toLowerCase(), id: Number(body.swapTo.id) }
    : body.orderId != null ? { kind: "order", id: Number(body.orderId) }
    : body.requestId != null ? { kind: "request", id: Number(body.requestId) }
    : null;

  let relink: { col: "orderIds" | "requestIds"; id: number } | null = null;
  if (bind) {
    if (!Number.isInteger(bind.id) || bind.id <= 0) return NextResponse.json({ error: "invalid id" }, { status: 400 });
    if (bind.kind === "order") {
      const exists = await labstackOr(labstack.$queryRaw<Array<{ id: number }>>`SELECT id FROM public."Order" WHERE id = ${bind.id} LIMIT 1`, [] as Array<{ id: number }>);
      if (!exists.length) return NextResponse.json({ error: `order ${bind.id} not found` }, { status: 400 });
      data.orderId = bind.id; data.requestId = null; data.entityKind = "ORDER";
      relink = { col: "orderIds", id: bind.id };
    } else if (bind.kind === "request") {
      const exists = await labstackOr(labstack.$queryRaw<Array<{ id: number }>>`SELECT id FROM public."Request" WHERE id = ${bind.id} LIMIT 1`, [] as Array<{ id: number }>);
      if (!exists.length) return NextResponse.json({ error: `request ${bind.id} not found` }, { status: 400 });
      data.requestId = bind.id; data.orderId = null; data.entityKind = "REQUEST";
      relink = { col: "requestIds", id: bind.id };
    } else {
      return NextResponse.json({ error: "swapTo.kind must be order or request" }, { status: 400 });
    }
    data.idConfidence = "high";
    data.idWarning = null;
    data.idAlt = Prisma.DbNull;
  }

  if (Object.keys(data).length === 0) return NextResponse.json({ error: "no fields" }, { status: 400 });

  try {
    const ticket = await prisma.waTicket.update({ where: { id }, data });
    // Tag every message already threaded to this case with the bound id so the
    // whole conversation carries the corrected context going forward.
    if (relink) {
      await prisma.$executeRawUnsafe(
        `UPDATE wa_messages SET "${relink.col}" = array_append("${relink.col}", $1) WHERE "ticketId" = $2 AND NOT ($1 = ANY("${relink.col}"))`,
        relink.id, id,
      );
    }
    return NextResponse.json({ ticket });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
