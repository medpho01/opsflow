/**
 * LabStack replica lookup — the bot's read side.
 *
 * Given candidate order/request ids parsed from a WhatsApp message, fetch
 * their live status straight from the LabStack replica (the SAME read
 * layer OpsFlow uses). Read-only, bounded by a short statement_timeout so
 * a sick replica degrades to "no data" rather than hanging the bot — the
 * June/July 2026 discipline applies here too.
 *
 * We don't know for a given number whether it's an Order id or a Request
 * id (they overlap), so we probe both tables and return whatever matches.
 */
import pg from "pg";

const CONN = process.env.SOURCE_DATABASE_URL;
if (!CONN) console.warn("[lookup] SOURCE_DATABASE_URL not set — lookups will fail (dry-run still classifies).");

// Small dedicated pool; statement_timeout keeps a wedged replica from
// stalling the message handler.
const pool = CONN
  ? new pg.Pool({ connectionString: CONN, max: 3, statement_timeout: 8000, query_timeout: 9000 })
  : null;

export async function lookupIds(ids = []) {
  if (!pool || ids.length === 0) return { orders: [], requests: [] };
  const intIds = ids.map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n));
  if (intIds.length === 0) return { orders: [], requests: [] };
  try {
    const [orders, requests] = await Promise.all([
      pool.query(
        `SELECT id, "orderStatus"::text AS status, "appointmentTime", "statusUpdatedAt", "orderType"::text AS type
         FROM public."Order" WHERE id = ANY($1::int[])`,
        [intIds]
      ).then((r) => r.rows).catch(() => []),
      pool.query(
        `SELECT id, "status"::text AS status, "createdAt"
         FROM public."Request" WHERE id = ANY($1::int[])`,
        [intIds]
      ).then((r) => r.rows).catch(() => []),
    ]);
    return { orders, requests };
  } catch (e) {
    console.error("[lookup] query failed:", e.message);
    return { orders: [], requests: [] };
  }
}

// Resolve city-prefixed lab reference ids (BLR…/HYD…) to our numeric order id
// via Order.labOrderId. Returns a map ref → orderId for the refs that matched.
export async function resolveRefIds(refs = []) {
  if (!pool || refs.length === 0) return {};
  const clean = [...new Set(refs.map((r) => String(r).toUpperCase()).filter(Boolean))];
  if (clean.length === 0) return {};
  try {
    const { rows } = await pool.query(
      `SELECT id, upper("labOrderId") AS ref FROM public."Order" WHERE upper("labOrderId") = ANY($1::text[])`,
      [clean]
    );
    const map = {};
    for (const r of rows) if (r.ref && !map[r.ref]) map[r.ref] = r.id;
    return map;
  } catch (e) {
    console.error("[lookup] resolveRefIds failed:", e.message);
    return {};
  }
}

// ── Canonical entity resolution ─────────────────────────────────────────────
// Order / Request / Appointment ids overlap numerically, so a bare number can
// name any of the three. We validate EVERYTHING against the replica and
// canonicalize to a single Order key, tracking provenance. Policy ("ask when
// not sure"): trust lab-refs, explicit request/appt labels, and bare numbers
// that validate as an Order (the partner convention); flag as ambiguous a bare
// number that is NOT an order but matches both a request and an appointment.
//
// Returns { orderIds:[canonical Order ids], requestIds:[validated Request ids],
//   primary:{ orderId, requestId, type, via } | null, ambiguous:[{ n, in:[…] }] }
export async function resolveEntities({ refs = [], reqLabeled = [], apptLabeled = [], bare = [] } = {}) {
  const empty = { orderIds: [], requestIds: [], primary: null, ambiguous: [] };
  if (!pool) return empty;
  const orderIds = new Set();
  const requestIds = new Set();
  const ambiguous = [];
  // provenance candidates in priority order; first with an orderId wins primary
  const prov = []; // { orderId?, requestId?, type, via }

  const asInts = (a) => [...new Set(a.map((x) => parseInt(x, 10)).filter(Number.isInteger))];
  const q = async (sql, params) => { try { return (await pool.query(sql, params)).rows; } catch (e) { console.error("[resolve]", e.message); return []; } };

  // 1) lab-refs (BLR…) → Order.labOrderId — unambiguous
  const refMap = await resolveRefIds(refs);
  for (const [ref, oid] of Object.entries(refMap)) { orderIds.add(oid); prov.push({ orderId: oid, type: "REF", via: ref }); }

  // 2) appt-labeled → Appointment.order_id
  const apptInts = asInts(apptLabeled);
  if (apptInts.length) {
    const rows = await q(`SELECT id, order_id FROM public."Appointment" WHERE id = ANY($1::int[])`, [apptInts]);
    for (const row of rows) if (row.order_id) { orderIds.add(row.order_id); prov.push({ orderId: row.order_id, type: "APPOINTMENT", via: `appt ${row.id}` }); }
  }

  // 3) request-labeled → validate Request, then its Order via Order.requestId
  const reqInts = asInts(reqLabeled);
  if (reqInts.length) {
    const validReq = await q(`SELECT id FROM public."Request" WHERE id = ANY($1::int[])`, [reqInts]);
    const rids = validReq.map((x) => x.id);
    for (const rid of rids) requestIds.add(rid);
    if (rids.length) {
      const ord = await q(`SELECT id, "requestId" FROM public."Order" WHERE "requestId" = ANY($1::int[])`, [rids]);
      for (const row of ord) { orderIds.add(row.id); prov.push({ orderId: row.id, requestId: row.requestId, type: "REQUEST", via: `request ${row.requestId}` }); }
      // a request with no order yet is still a valid case anchor
      for (const rid of rids) if (!ord.some((o) => o.requestId === rid)) prov.push({ requestId: rid, type: "REQUEST", via: `request ${rid}` });
    }
  }

  // 4) bare numbers → Order first (convention). Non-orders: probe request/appt.
  const bareInts = asInts(bare);
  if (bareInts.length) {
    const asOrder = await q(`SELECT id FROM public."Order" WHERE id = ANY($1::int[])`, [bareInts]);
    const orderSet = new Set(asOrder.map((x) => x.id));
    for (const id of orderSet) { orderIds.add(id); prov.push({ orderId: id, type: "ORDER", via: `order ${id}` }); }
    const leftover = bareInts.filter((n) => !orderSet.has(n));
    if (leftover.length) {
      const [asReq, asAppt] = await Promise.all([
        q(`SELECT id FROM public."Request" WHERE id = ANY($1::int[])`, [leftover]),
        q(`SELECT id, order_id FROM public."Appointment" WHERE id = ANY($1::int[])`, [leftover]),
      ]);
      const reqSet = new Set(asReq.map((x) => x.id));
      const apptMap = new Map(asAppt.map((x) => [x.id, x.order_id]));
      for (const n of leftover) {
        const inReq = reqSet.has(n), inAppt = apptMap.has(n);
        if (inReq && inAppt) { ambiguous.push({ n, in: ["request", "appointment"] }); continue; } // not sure → ask
        if (inAppt) { const oid = apptMap.get(n); if (oid) { orderIds.add(oid); prov.push({ orderId: oid, type: "APPOINTMENT", via: `appt ${n}` }); } }
        else if (inReq) { requestIds.add(n); prov.push({ requestId: n, type: "REQUEST", via: `request ${n}` }); }
        // matches nothing → not an id (phone/pincode/qty); ignore
      }
    }
  }

  const primary = prov.find((p) => p.orderId) || prov.find((p) => p.requestId) || null;
  return { orderIds: [...orderIds], requestIds: [...requestIds], primary, ambiguous };
}

// Order → labId, for inferring which lab a provider group belongs to.
export async function orderLabs(ids = []) {
  if (!pool || !ids.length) return [];
  const intIds = [...new Set(ids.map((x) => parseInt(x, 10)).filter(Number.isInteger))];
  if (!intIds.length) return [];
  try {
    return (await pool.query(`SELECT id, "labId" FROM public."Order" WHERE id = ANY($1::int[]) AND "labId" IS NOT NULL`, [intIds])).rows;
  } catch (e) { console.error("[lookup] orderLabs:", e.message); return []; }
}

export async function closePool() {
  if (pool) await pool.end().catch(() => {});
}
