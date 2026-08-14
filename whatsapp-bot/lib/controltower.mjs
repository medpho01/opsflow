/**
 * Control Tower integration — the gateway's writes to the OpsFlow (taskos) DB.
 *
 * Responsibilities:
 *   - publish gateway status + live QR   → wa_gateway (singleton "default")
 *   - persist every in-scope message     → wa_messages (idempotent)
 *   - create/enrich tickets              → wa_tickets  (+ context from replica)
 *   - missing-id auto-reply              → wa_outbound (debounced)
 *   - drain the outbound queue           → send via the caller-provided socket
 *
 * Group scope + roles come from wa_groups (admin-configured), replacing the
 * hardcoded /labstack/i filter: only groups present + active are handled.
 */
import { taskos, taskosQuery } from "./taskosdb.mjs";
import { classify, extractIds, extractReferences, DISPOSITION, isLabstack } from "./classifier.mjs";
import { lookupIds, resolveEntities } from "./lookup.mjs";

// ── group cache (jid → config row) ─────────────────────────────────────────
let groupCache = new Map();
export async function refreshGroups() {
  const r = await taskosQuery(
    `SELECT id, jid, subject, role, active, "storeId", "labId", "autoAskIdOnMissing", "sendEnabled" FROM wa_groups`
  );
  const m = new Map();
  for (const g of r.rows) m.set(g.jid, g);
  groupCache = m;
  return m;
}
export const getGroup = (jid) => groupCache.get(jid);
export const knownGroupCount = () => groupCache.size;

// Auto-register groups the gateway discovers on connect. Inserts new jids
// (default role SUPPORT for an admin to classify) and refreshes the subject on
// existing ones — never overwrites an admin's role/mapping. Makes server
// deploys turnkey: no manual seed step. `pairs` = iterable of [jid, subject].
export async function syncGroups(pairs, preActiveJids = null) {
  // preActiveJids: jids to activate on FIRST registration (e.g. hint matches).
  // When null, every discovered group is pre-activated (legacy turnkey). On
  // conflict we only refresh the subject — never the admin's active/role choice.
  const activeSet = preActiveJids ? new Set(preActiveJids) : null;
  for (const [jid, subject] of pairs) {
    const active = activeSet ? activeSet.has(jid) : true;
    try {
      await taskosQuery(
        `INSERT INTO wa_groups (id, jid, subject, role, active, "updatedAt")
           VALUES (gen_random_uuid()::text, $1, $2, 'SUPPORT', $3, now())
         ON CONFLICT (jid) DO UPDATE SET subject = EXCLUDED.subject, "updatedAt" = now()`,
        [jid, subject, active]
      );
    } catch (e) { console.error("syncGroups:", e.message); }
  }
  return refreshGroups();
}

// ── gateway status / QR ────────────────────────────────────────────────────
export async function gatewayUpsert(fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const insCols = keys.map((k) => `"${k}"`).join(", ");
  const insVals = keys.map((_, i) => `$${i + 2}`).join(", ");
  const setCols = keys.map((k, i) => `"${k}" = $${i + 2}`).join(", ");
  await taskosQuery(
    `INSERT INTO wa_gateway (id, ${insCols}, "updatedAt") VALUES ($1, ${insVals}, now())
     ON CONFLICT (id) DO UPDATE SET ${setCols}, "updatedAt" = now()`,
    ["default", ...keys.map((k) => fields[k])]
  );
}
export const setQr = (qr) => gatewayUpsert({ status: "QR", qr, qrUpdatedAt: new Date() });
export const setConnected = (number) =>
  gatewayUpsert({ status: "CONNECTED", connectedNumber: number, qr: null, lastSeenAt: new Date() });
export const setStatus = (status) => gatewayUpsert({ status });
export const heartbeat = (dryRun = null) =>
  gatewayUpsert(dryRun === null ? { lastSeenAt: new Date() } : { lastSeenAt: new Date(), dryRun });

// admin command (RELINK / LOGOUT) — read once and clear
export async function consumeCommand() {
  const r = await taskosQuery(`SELECT command FROM wa_gateway WHERE id = 'default'`);
  const cmd = r.rows[0]?.command || null;
  if (cmd) await taskosQuery(`UPDATE wa_gateway SET command = NULL, "commandRequestedAt" = NULL WHERE id = 'default'`);
  return cmd;
}

// ── ticket helpers ─────────────────────────────────────────────────────────
async function enrichContext(orderId, requestId) {
  try {
    const ids = [orderId, requestId].filter(Boolean);
    if (!ids.length) return null;
    const { orders = [], requests = [] } = await lookupIds(ids);
    const o = orders[0], rq = requests[0];
    if (o) return {
      kind: "order", id: o.id, status: o.status || o.orderStatus,
      appointmentTime: o.appointmentTime, orderType: o.orderType, capturedAt: new Date().toISOString(),
    };
    if (rq) return { kind: "request", id: rq.id, status: rq.status, capturedAt: new Date().toISOString() };
  } catch (e) { /* replica hiccup — leave context null */ }
  return null;
}

// find an open ticket for this group+id, else create one
async function upsertTicket({ group, orderId, requestId, intent, ts }) {
  const idCond = orderId ? `"orderId" = $2` : requestId ? `"requestId" = $2` : `"orderId" IS NULL AND "requestId" IS NULL`;
  const idVal = orderId || requestId || null;
  const params = idVal ? [group.id, idVal] : [group.id];
  const found = await taskosQuery(
    `SELECT id FROM wa_tickets WHERE "groupId" = $1 AND ${idCond} AND status <> 'RESOLVED'
       ORDER BY "lastActivityAt" DESC LIMIT 1`,
    params
  );
  if (found.rows[0]) {
    await taskosQuery(
      `UPDATE wa_tickets SET "lastActivityAt" = $2, intent = COALESCE($3, intent) WHERE id = $1`,
      [found.rows[0].id, ts, intent]
    );
    return found.rows[0].id;
  }
  const ctx = await enrichContext(orderId, requestId);
  const status = !idVal ? "WAITING_INFO" : "OPEN";
  const r = await taskosQuery(
    `INSERT INTO wa_tickets (id, "groupId", "storeId", status, "orderId", "requestId", intent, "contextSnapshot", "lastActivityAt", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, now(), now()) RETURNING id`,
    [group.id, group.storeId, status, orderId, requestId, intent, ctx ? JSON.stringify(ctx) : null, ts]
  );
  return r.rows[0].id;
}

// ── message ingest ─────────────────────────────────────────────────────────
const lastAskAt = new Map(); // jid → ts (debounce auto-ask)
// Master kill switch for the "share the order id" auto-reply. OFF by default —
// it must be explicitly enabled with WA_AUTO_ASK=true AND per-group opt-in.
// Without this, an admin toggle alone can spam partner groups.
const AUTO_ASK_ENABLED = process.env.WA_AUTO_ASK === "true";

/**
 * Persist a message and (for substantive inbound) attach it to a ticket.
 * Returns { stored, ticketId, autoAsk } — autoAsk is the text to send if a
 * missing-id nudge is due.
 */
export async function ingestMessage(m) {
  const { jid, waMsgId, fromMe, sender, senderJid, replyToWaId } = m;
  const { mediaKind = null, mediaMime = null, mediaFilename = null, mediaBytes = null } = m;
  const ts = m.ts;
  const group = getGroup(jid);
  if (!group || !group.active) return { stored: false }; // not an admin-configured active group

  // Caption-less media still needs a legible label in list views / threads.
  const mediaLabel = mediaKind === "document" ? `📄 ${mediaFilename || "Document"}`
    : mediaKind === "image" ? "📷 Photo"
    : mediaKind ? `📎 ${mediaKind}` : "";
  const text = (m.text && m.text.trim()) || mediaLabel;

  const intent = classify(text, sender);
  // Canonical, VALIDATED id resolution. Order/Request/Appointment ids overlap
  // numerically, so we never trust a bare number blindly: extractReferences
  // keeps the namespaces apart and resolveEntities validates each against the
  // replica, canonicalizing to a single Order key and flagging what it can't
  // safely decide. This is what stops us from showing the wrong patient.
  const refs = extractReferences(text);
  const resolved = await resolveEntities(refs).catch((e) => {
    console.error("resolveEntities:", e.message);
    return { orderIds: [], requestIds: [], primary: null, ambiguous: [] };
  });
  let allOrderIds = resolved.orderIds;
  let validRequestIds = resolved.requestIds;
  const ambiguousIds = resolved.ambiguous.map((a) => a.n);
  let orderId = resolved.primary?.orderId || null;
  let requestId = resolved.primary?.requestId || null;
  let idType = resolved.primary?.type || null;
  let idVia = resolved.primary?.via || null;
  let inheritedTicketId = null;

  // Reply-chain inheritance. People reply to a root message ("any update on
  // 46259?") without repeating the id ("still pending?"). WhatsApp gives us the
  // quoted message id (replyToWaId); if THIS message resolved no id of its own,
  // inherit the quoted message's already-resolved order/request + ticket so the
  // reply threads to the same case. One hop suffices — inheritance is applied
  // at ingest, so the parent already carries any it inherited.
  if (!orderId && !requestId && replyToWaId) {
    const parent = (await taskosQuery(
      `SELECT "orderIds", "requestIds", "ticketId", "idType", "idVia" FROM wa_messages WHERE "waMsgId" = $1 LIMIT 1`,
      [replyToWaId]
    )).rows[0];
    if (parent && ((parent.orderIds && parent.orderIds.length) || (parent.requestIds && parent.requestIds.length))) {
      allOrderIds = parent.orderIds || [];
      validRequestIds = parent.requestIds || [];
      orderId = allOrderIds[0] || null;
      requestId = validRequestIds[0] || null;
      idType = parent.idType || (orderId ? "ORDER" : requestId ? "REQUEST" : null);
      idVia = `reply · ${parent.idVia || (orderId ? `order ${orderId}` : `request ${requestId}`)}`;
      inheritedTicketId = parent.ticketId || null;
    }
  }

  const side = fromMe || isLabstack(sender) ? "LAB" : "PARTNER";
  const substantive = intent !== "NOISE" && intent !== "SYSTEM";

  let ticketId = null;
  let autoAsk = null;
  if (substantive && !fromMe) {
    ticketId = await upsertTicket({ group, orderId: orderId ? +orderId : null, requestId: requestId ? +requestId : null, intent, ts });
    // missing-id auto-reply (debounced 30 min/group). Suppressed when we
    // inherited an id from the quoted message — the reply IS anchored.
    const needsId = DISPOSITION[intent] === "AUTO_ANSWER" && !orderId && !requestId && !inheritedTicketId;
    if (AUTO_ASK_ENABLED && needsId && group.autoAskIdOnMissing) {
      const last = lastAskAt.get(jid) || 0;
      if (Date.now() - last > 30 * 60 * 1000) {
        lastAskAt.set(jid, Date.now());
        autoAsk = "Please share the order/booking ID and your query so we can act on it 🙏";
      }
    }
  }

  // A reply (even a team ack) threads to the parent's case when it carried no
  // id of its own — so the chain stays intact in the thread and timeline.
  const threadTicketId = ticketId || inheritedTicketId;
  const stored = await taskosQuery(
    `INSERT INTO wa_messages (id, "waMsgId", "groupId", "ticketId", direction, "fromMe", sender, "senderJid", text, ts, "replyToWaId", intent, "orderIds", "requestIds", "refIds", "idType", "idVia", "ambiguousIds", "mediaType", "mediaMime", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now())
     ON CONFLICT ("waMsgId") DO NOTHING RETURNING id`,
    [waMsgId, group.id, threadTicketId, fromMe ? "OUT" : "IN", fromMe, sender, senderJid || null, text, ts, replyToWaId,
     intent, allOrderIds, validRequestIds, refs.refs, idType, idVia, ambiguousIds, mediaKind, mediaMime]
  );

  // Backfill-safe: if this message row already existed as text-only (media was
  // dropped before capture), tag its media flags now so the console shows it.
  if (mediaKind) {
    await taskosQuery(
      `UPDATE wa_messages SET "mediaType"=$2, "mediaMime"=$3 WHERE "waMsgId"=$1 AND "mediaType" IS DISTINCT FROM $2`,
      [waMsgId, mediaKind, mediaMime]
    ).catch(() => {});
  }
  // Persist the raw bytes separately so the console can serve/interpret them.
  if (mediaBytes && mediaMime) {
    await taskosQuery(
      `INSERT INTO wa_media (id, "waMsgId", "groupId", mime, bytes, "createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, now())
       ON CONFLICT ("waMsgId") DO NOTHING`,
      [waMsgId, group.id, mediaMime, mediaBytes]
    ).catch((e) => console.error("wa_media insert:", e.message));
  }

  if (autoAsk) await enqueueOutbound({ targetJid: jid, text: autoAsk, groupId: group.id, ticketId });
  return { stored: !!stored.rows[0], ticketId, autoAsk, side, intent, media: mediaKind };
}

/**
 * Re-resolve stored messages in a recent window against the CURRENT logic:
 * validate ids, canonicalize to an order, and inherit order/request + ticket
 * down reply chains. Fixes threading/ids retroactively for messages captured
 * before this logic existed. Does NOT touch media (bytes were never stored;
 * media backfill needs a WhatsApp history re-fetch). Idempotent.
 * Processes oldest→newest so a reply's parent is already re-resolved.
 */
export async function reresolveWindow({ days = 3 } = {}) {
  await refreshGroups();
  const rows = (await taskosQuery(
    `SELECT m."waMsgId", m.text, m."replyToWaId", m."fromMe", m.sender, m.ts, m.intent, g.jid AS gjid
       FROM wa_messages m JOIN wa_groups g ON g.id = m."groupId"
      WHERE m.ts >= now() - ($1 || ' days')::interval AND g.active = true
      ORDER BY m.ts ASC`,
    [String(days)]
  )).rows;

  let updated = 0, inherited = 0, tickets = 0;
  for (const r of rows) {
    const refs = extractReferences(r.text || "");
    const resolved = await resolveEntities(refs).catch(() => ({ orderIds: [], requestIds: [], primary: null, ambiguous: [] }));
    let allOrderIds = resolved.orderIds;
    let validRequestIds = resolved.requestIds;
    let orderId = resolved.primary?.orderId || null;
    let requestId = resolved.primary?.requestId || null;
    let idType = resolved.primary?.type || null;
    let idVia = resolved.primary?.via || null;
    let ticketId = null;

    if (!orderId && !requestId && r.replyToWaId) {
      const parent = (await taskosQuery(
        `SELECT "orderIds", "requestIds", "ticketId", "idType", "idVia" FROM wa_messages WHERE "waMsgId" = $1 LIMIT 1`,
        [r.replyToWaId]
      )).rows[0];
      if (parent && ((parent.orderIds && parent.orderIds.length) || (parent.requestIds && parent.requestIds.length))) {
        allOrderIds = parent.orderIds || [];
        validRequestIds = parent.requestIds || [];
        orderId = allOrderIds[0] || null;
        requestId = validRequestIds[0] || null;
        idType = parent.idType || (orderId ? "ORDER" : requestId ? "REQUEST" : null);
        idVia = `reply · ${parent.idVia || (orderId ? `order ${orderId}` : `request ${requestId}`)}`;
        ticketId = parent.ticketId || null;
        inherited++;
      }
    }

    const group = getGroup(r.gjid);
    const substantive = r.intent !== "NOISE" && r.intent !== "SYSTEM";
    if (group && substantive && !r.fromMe && (orderId || requestId)) {
      ticketId = await upsertTicket({ group, orderId: orderId ? +orderId : null, requestId: requestId ? +requestId : null, intent: r.intent, ts: r.ts });
      tickets++;
    }

    await taskosQuery(
      `UPDATE wa_messages SET "orderIds"=$2, "requestIds"=$3, "refIds"=$4, "idType"=$5, "idVia"=$6, "ambiguousIds"=$7, "ticketId"=COALESCE($8, "ticketId") WHERE "waMsgId"=$1`,
      [r.waMsgId, allOrderIds, validRequestIds, refs.refs, idType, idVia, resolved.ambiguous.map((a) => a.n), ticketId]
    );
    updated++;
  }
  return { scanned: rows.length, updated, inherited, tickets };
}

// Newest stored message per active group — used to anchor a history re-fetch.
export async function newestPerActiveGroup() {
  const rows = (await taskosQuery(
    `SELECT DISTINCT ON (g.jid) g.jid, m."waMsgId", m."fromMe", m.ts
       FROM wa_messages m JOIN wa_groups g ON g.id = m."groupId"
      WHERE g.active = true
      ORDER BY g.jid, m.ts DESC`
  )).rows;
  return rows;
}

// ── outbound queue ─────────────────────────────────────────────────────────
export async function enqueueOutbound({ targetJid, text, groupId = null, ticketId = null, quotedWaId = null, createdById = null }) {
  await taskosQuery(
    `INSERT INTO wa_outbound (id, "targetJid", text, status, "groupId", "ticketId", "quotedWaId", "createdById", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, 'QUEUED', $3, $4, $5, $6, now())`,
    [targetJid, text, groupId, ticketId, quotedWaId, createdById]
  );
}

/**
 * Drain queued outbound rows. `send(targetJid, text, quotedWaId)` must return
 * the sent WhatsApp message id (or throw). Respects per-group sendEnabled.
 */
export async function drainOutbound(send, { limit = 5 } = {}) {
  const rows = (await taskosQuery(
    `SELECT o.id, o."targetJid", o.text, o."groupId", o."quotedWaId", g."sendEnabled", g.subject
       FROM wa_outbound o LEFT JOIN wa_groups g ON g.id = o."groupId"
      WHERE o.status = 'QUEUED' ORDER BY o."createdAt" ASC LIMIT $1`, [limit]
  )).rows;
  let sent = 0;
  for (const row of rows) {
    // a group target must be send-enabled; non-group (raw number) sends are allowed
    if (row.groupId && !row.sendEnabled) {
      await taskosQuery(`UPDATE wa_outbound SET status='FAILED', error=$2, attempts=attempts+1 WHERE id=$1`,
        [row.id, `sending disabled for group "${row.subject}"`]);
      continue;
    }
    await taskosQuery(`UPDATE wa_outbound SET status='SENDING', attempts=attempts+1 WHERE id=$1`, [row.id]);
    try {
      // Build a quoted stub so the reply threads under the original message.
      // WhatsApp only renders a quote when the quoted message lives in the SAME
      // chat, so require the quoted message's group jid to match the target.
      let quoted = null;
      if (row.quotedWaId) {
        const qm = (await taskosQuery(
          `SELECT m."waMsgId", m."senderJid", m."fromMe", m.text, g.jid AS gjid
             FROM wa_messages m JOIN wa_groups g ON g.id = m."groupId"
            WHERE m."waMsgId" = $1 LIMIT 1`, [row.quotedWaId]
        )).rows[0];
        if (qm && qm.gjid === row.targetJid) {
          quoted = {
            key: { remoteJid: qm.gjid, id: qm.waMsgId, fromMe: !!qm.fromMe, participant: qm.senderJid || undefined },
            message: { conversation: qm.text || "" },
          };
        }
      }
      const waId = await send(row.targetJid, row.text, quoted);
      await taskosQuery(`UPDATE wa_outbound SET status='SENT', "sentWaMsgId"=$2, "sentAt"=now() WHERE id=$1`, [row.id, waId || null]);
      sent++;
    } catch (e) {
      await taskosQuery(`UPDATE wa_outbound SET status='FAILED', error=$2 WHERE id=$1`, [row.id, (e?.message || String(e)).slice(0, 300)]);
    }
  }
  return { drained: rows.length, sent };
}
