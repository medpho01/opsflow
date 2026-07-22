/**
 * GET /api/analytics/source-load?source=orders|requests|appointments&days=7|14|30
 *
 * Generic source-entity analytics driven by the analytics contract in
 * lib/analytics/sourceRegistry. Replaces the orders-only /order-load
 * endpoint: same Tier-0 heatmap payload, plus status distribution (T1),
 * fulfillment split (T2), and open-backlog aging (T2) for any source
 * whose contract declares the fields.
 *
 * Degradation over failure: every configured column is validated against
 * information_schema first; missing columns drop their tier and add a
 * warning to the response instead of erroring. A wrong contract guess
 * renders a smaller panel, never a 500.
 *
 * Replica discipline (June/July 2026 incidents): every query is bounded
 * by a time window on the source table, wrapped in labstackOr with an
 * 8s ceiling on the API breaker — a sick replica yields a clean 503.
 * Identifier safety: table/column names come exclusively from the code
 * registry (validated against information_schema besides), never from
 * request input; the only request-controlled values are whitelist-
 * validated enums (source key, days).
 *
 * Auth: OPS_HEAD only (matches /api/analytics/* convention).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { labstackQuery, labstackOr } from "@/lib/db/labstack";
import { UserRole } from "@prisma/client";
import { SOURCE_ANALYTICS, listSources } from "@/lib/analytics/sourceRegistry";

const VALID_DAYS = new Set([7, 14, 30]);
const q = (ident: string) => `"${ident.replace(/"/g, "")}"`;

interface CellRow { ist_date: string; ist_hour: number; dim: string | null; cnt: number }
interface StatusRow { status: string; cnt: number }
interface GroupRow { grp: string; cnt: number }
interface AgingRow { bucket: string; cnt: number }

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const sourceKey = searchParams.get("source") ?? "orders";
  const contract = SOURCE_ANALYTICS[sourceKey];
  if (!contract) {
    return NextResponse.json(
      { error: `Unknown source; must be one of ${Object.keys(SOURCE_ANALYTICS).join(", ")}` },
      { status: 400 }
    );
  }
  const days = parseInt(searchParams.get("days") ?? "14", 10);
  if (!VALID_DAYS.has(days)) {
    return NextResponse.json({ error: "Invalid days; must be 7, 14 or 30" }, { status: 400 });
  }

  // ── Validate the contract against the live schema ────────────────────
  const columns = await labstackOr<Array<{ column_name: string }> | null>(
    labstackQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1`,
      [contract.table]
    ),
    null,
    8_000,
    { breakerKey: "api" }
  );
  if (columns === null) {
    return NextResponse.json(
      { error: "Source database temporarily unavailable — try again in a moment", code: "LABSTACK_TIMEOUT" },
      { status: 503 }
    );
  }
  if (columns.length === 0) {
    return NextResponse.json(
      { error: `Table public."${contract.table}" not found — check the source's analytics contract` },
      { status: 404 }
    );
  }
  const have = new Set(columns.map((c) => c.column_name));
  const warnings: string[] = [];
  const requireCol = (col: string | undefined, what: string): string | null => {
    if (!col) return null;
    if (have.has(col)) return col;
    warnings.push(`${what} column "${col}" not found on ${contract.table} — tier disabled`);
    return null;
  };

  const eventCol = requireCol(contract.eventTimeField, "eventTime");
  const createdCol = requireCol(contract.createdField, "created");
  const statusCol = requireCol(contract.statusField, "status");
  const dims = (contract.dimensions ?? []).filter((d) => {
    if (have.has(d.column)) return true;
    warnings.push(`dimension "${d.column}" not found on ${contract.table} — dropped`);
    return false;
  });
  if (!eventCol) {
    return NextResponse.json(
      { error: `eventTime column "${contract.eventTimeField}" missing on ${contract.table} — nothing to chart`, warnings },
      { status: 422 }
    );
  }

  const T = `public.${q(contract.table)}`;
  const E = q(eventCol);
  const C = q(createdCol ?? eventCol);
  const dimExpr = dims.length > 0 ? `${q(dims[0].column)}::text` : `NULL`;
  const lookahead = contract.lookaheadDays;

  // ── T0 — heatmap cells (IST date × hour × first dimension) ───────────
  const cells = await labstackOr<CellRow[] | null>(
    labstackQuery<CellRow>(
      `SELECT
         to_char((${E} + INTERVAL '330 minutes')::date, 'YYYY-MM-DD') AS ist_date,
         EXTRACT(HOUR FROM ${E} + INTERVAL '330 minutes')::int        AS ist_hour,
         ${dimExpr}                                                    AS dim,
         count(*)::int                                                 AS cnt
       FROM ${T}
       WHERE ${E} >= NOW() - INTERVAL '${days} days'
         AND ${E} <  NOW() + INTERVAL '${lookahead} days'
       GROUP BY 1, 2, 3
       ORDER BY 1, 2`
    ),
    null,
    8_000,
    { breakerKey: "api" }
  );
  if (cells === null) {
    return NextResponse.json(
      { error: "Source database temporarily unavailable — try again in a moment", code: "LABSTACK_TIMEOUT" },
      { status: 503 }
    );
  }

  // ── T1 — current status mix of entities created in the window ────────
  let statusCounts: StatusRow[] | null = null;
  if (statusCol) {
    statusCounts = await labstackOr<StatusRow[] | null>(
      labstackQuery<StatusRow>(
        `SELECT ${q(statusCol)}::text AS status, count(*)::int AS cnt
         FROM ${T}
         WHERE ${C} >= NOW() - INTERVAL '${days} days'
         GROUP BY 1 ORDER BY 2 DESC`
      ),
      null,
      8_000,
      { breakerKey: "api" }
    );
  }

  // ── T2 — fulfillment split + open-backlog aging ───────────────────────
  let fulfillment: Record<string, number> | null = null;
  let aging: Record<string, number> | null = null;
  if (statusCol && contract.statusMap) {
    const f = contract.statusMap.fulfilled;
    const x = contract.statusMap.failed;
    const fPh = f.map((_, i) => `$${i + 1}`).join(", ");
    const xPh = x.map((_, i) => `$${f.length + i + 1}`).join(", ");
    const grouped = await labstackOr<GroupRow[] | null>(
      labstackQuery<GroupRow>(
        `SELECT CASE
                  WHEN ${q(statusCol)}::text IN (${fPh}) THEN 'fulfilled'
                  WHEN ${q(statusCol)}::text IN (${xPh}) THEN 'failed'
                  ELSE 'open'
                END AS grp,
                count(*)::int AS cnt
         FROM ${T}
         WHERE ${C} >= NOW() - INTERVAL '${days} days'
         GROUP BY 1`,
        [...f, ...x]
      ),
      null,
      8_000,
      { breakerKey: "api" }
    );
    if (grouped) {
      fulfillment = { fulfilled: 0, failed: 0, open: 0 };
      for (const r of grouped) fulfillment[r.grp] = r.cnt;
    }

    // Aging looks beyond the display window (open debt older than the
    // window matters most) but stays bounded at 60d for index safety.
    const terminal = [...f, ...x];
    const tPh = terminal.map((_, i) => `$${i + 1}`).join(", ");
    const agingRows = await labstackOr<AgingRow[] | null>(
      labstackQuery<AgingRow>(
        `SELECT CASE
                  WHEN ${C} >= NOW() - INTERVAL '1 day'  THEN 'd1'
                  WHEN ${C} >= NOW() - INTERVAL '3 days' THEN 'd3'
                  WHEN ${C} >= NOW() - INTERVAL '7 days' THEN 'd7'
                  ELSE 'older'
                END AS bucket,
                count(*)::int AS cnt
         FROM ${T}
         WHERE ${C} >= NOW() - INTERVAL '60 days'
           AND ${q(statusCol)}::text NOT IN (${tPh})
         GROUP BY 1`,
        terminal
      ),
      null,
      8_000,
      { breakerKey: "api" }
    );
    if (agingRows) {
      aging = { d1: 0, d3: 0, d7: 0, older: 0 };
      for (const r of agingRows) aging[r.bucket] = r.cnt;
    }
  }

  const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  return NextResponse.json({
    source: {
      key: contract.key,
      label: contract.label,
      eventTimeLabel: contract.eventTimeLabel,
      lookaheadDays: lookahead,
      hasStatus: !!statusCol,
      hasFulfillment: !!(statusCol && contract.statusMap),
      dimension: dims[0] ? { key: dims[0].key, label: dims[0].label } : null,
    },
    availableSources: listSources(),
    days,
    todayIST,
    warnings,
    cells: cells.map((r) => ({
      istDate: typeof r.ist_date === "string" ? r.ist_date : new Date(r.ist_date).toISOString().slice(0, 10),
      istHour: r.ist_hour,
      type: r.dim ?? "",
      count: r.cnt,
    })),
    statusCounts: statusCounts?.map((r) => ({ status: r.status, count: r.cnt })) ?? null,
    fulfillment,
    aging,
  });
}
