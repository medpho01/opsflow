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

export async function closePool() {
  if (pool) await pool.end().catch(() => {});
}
