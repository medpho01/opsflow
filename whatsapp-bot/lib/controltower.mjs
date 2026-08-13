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
import { classify, extractIds, DISPOSITION, isLabstack } from "./classifier.mjs";
import { lookupIds } from "./lookup.mjs";

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
export async function syncGroups(pairs) {
  for (const [jid, subject] of pairs) {
    try {
      await taskosQuery(
        `INSERT INTO wa_groups (id, jid, subject, role, active, "updatedAt")
           VALUES (gen_random_uuid()::text, $1, $2, 'SUPPORT', true, now())
         ON CONFLICT (jid) DO UPDATE SET subject = EXCLUDED.subject, "updatedAt" = now()`,
        [jid, subject]
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
export const heartbeat = () => gatewayUpsert({ lastSeenAt: new Date() });

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

/**
 * Persist a message and (for substantive inbound) attach it to a ticket.
 * Returns { stored, ticketId, autoAsk } — autoAsk is the text to send if a
 * missing-id nudge is due.
 */
export async function ingestMessage(m) {
  const { jid, waMsgId, fromMe, sender, text, ts, replyToWaId } = m;
  const group = getGroup(jid);
  if (!group || !group.active) return { stored: false }; // not an admin-configured active group

  const intent = classify(text, sender);
  const { ids, requestIds } = extractIds(text);
  const orderId = ids.find((x) => !requestIds.includes(x)) || null;
  const requestId = requestIds[0] || null;
  const side = fromMe || isLabstack(sender) ? "LAB" : "PARTNER";
  const substantive = intent !== "NOISE" && intent !== "SYSTEM";

  let ticketId = null;
  let autoAsk = null;
  if (substantive && !fromMe) {
    ticketId = await upsertTicket({ group, orderId: orderId ? +orderId : null, requestId: requestId ? +requestId : null, intent, ts });
    // missing-id auto-reply (debounced 30 min/group)
    const needsId = DISPOSITION[intent] === "AUTO_ANSWER" && !orderId && !requestId;
    if (needsId && group.autoAskIdOnMissing) {
      const last = lastAskAt.get(jid) || 0;
      if (Date.now() - last > 30 * 60 * 1000) {
        lastAskAt.set(jid, Date.now());
        autoAsk = "Please share the order/booking ID and your query so we can act on it 🙏";
      }
    }
  }

  const stored = await taskosQuery(
    `INSERT INTO wa_messages (id, "waMsgId", "groupId", "ticketId", direction, "fromMe", sender, text, ts, "replyToWaId", intent, "orderIds", "requestIds", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     ON CONFLICT ("waMsgId") DO NOTHING RETURNING id`,
    [waMsgId, group.id, ticketId, fromMe ? "OUT" : "IN", fromMe, sender, text, ts, replyToWaId,
     intent, ids.map(Number).filter(Boolean), requestIds.map(Number).filter(Boolean)]
  );

  if (autoAsk) await enqueueOutbound({ targetJid: jid, text: autoAsk, groupId: group.id, ticketId });
  return { stored: !!stored.rows[0], ticketId, autoAsk, side, intent };
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
      const waId = await send(row.targetJid, row.text, row.quotedWaId);
      await taskosQuery(`UPDATE wa_outbound SET status='SENT', "sentWaMsgId"=$2, "sentAt"=now() WHERE id=$1`, [row.id, waId || null]);
      sent++;
    } catch (e) {
      await taskosQuery(`UPDATE wa_outbound SET status='FAILED', error=$2 WHERE id=$1`, [row.id, (e?.message || String(e)).slice(0, 300)]);
    }
  }
  return { drained: rows.length, sent };
}
