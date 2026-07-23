/**
 * GET /api/analytics/source-load?source=<sourceId>&days=7|14|30
 *
 * Generic source-entity analytics driven by the SINGLE source definition
 * in taskos.data_sources — the same rows that drive polling. Registering a
 * source in the Data Sources UI therefore makes it appear in analytics
 * with no code change (the unification of 23 Jul; previously the contract
 * lived in a separate code registry, so UI-registered sources never
 * showed up here).
 *
 * The contract is assembled from the source row:
 *   table       ← tableReference   (bare name parsed out)
 *   statusField ← statusFieldName
 *   dimension   ← typeFieldName
 *   eventTime / created / lookahead / statusMap ← analyticsConfig JSON,
 *     all optional (a source with no analyticsConfig still gets the Tier-0
 *     heatmap on createdAt + Tier-1 status distribution).
 *
 * Tiers: T0 heatmap, T1 status distribution, T2 fulfillment + aging,
 * T3 type dimension.
 *
 * Degradation over failure: every column is validated against
 * information_schema; missing columns drop their tier and add a warning
 * instead of erroring. Replica discipline (June/July incidents): every
 * query window-bounded + labstackOr-wrapped (503 on sick replica).
 * Identifier safety: table/column names come only from the source row
 * (and are validated), never from request input; request params are
 * enum/existence-checked.
 *
 * Auth: OPS_HEAD only.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { labstackQuery, labstackOr } from "@/lib/db/labstack";
import { UserRole } from "@prisma/client";

const VALID_DAYS = new Set([7, 14, 30]);
const q = (ident: string) => `"${ident.replace(/"/g, "")}"`;

// Parse the bare table name out of a tableReference like `public."Order"`.
function bareTable(ref: string): string {
  return ref.replace(/^.*\./, "").replace(/"/g, "").trim();
}

interface AnalyticsConfig {
  eventTimeField?: string;
  createdField?: string;
  eventTimeLabel?: string;
  lookaheadDays?: number;
  statusFulfilled?: string[];
  statusFailed?: string[];
}

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
  const days = parseInt(searchParams.get("days") ?? "14", 10);
  if (!VALID_DAYS.has(days)) {
    return NextResponse.json({ error: "Invalid days; must be 7, 14 or 30" }, { status: 400 });
  }

  // ── Resolve the source from the registry table ───────────────────────
  // Analytics is decoupled from polling state: show every registered
  // source (active or not) — deactivating stops task creation, not the
  // existence of the underlying data.
  const allSources = await prisma.dataSource.findMany({
    orderBy: { displayName: "asc" },
    select: {
      sourceId: true, displayName: true, tableReference: true,
      statusFieldName: true, typeFieldName: true, analyticsConfig: true,
    },
  });
  const availableSources = allSources.map((s) => ({ key: s.sourceId, label: s.displayName }));

  const sourceKey = searchParams.get("source") ?? allSources[0]?.sourceId;
  const row = allSources.find((s) => s.sourceId === sourceKey);
  if (!row) {
    return NextResponse.json(
      { error: `Unknown source "${sourceKey}"`, availableSources },
      { status: 400 }
    );
  }

  // Build the contract: derive table/status/dimension from the source row,
  // pull the analytics-only bits from analyticsConfig (all defaulted).
  const cfg = (row.analyticsConfig as AnalyticsConfig | null) ?? {};
  const contract = {
    label: row.displayName,
    table: bareTable(row.tableReference),
    statusField: row.statusFieldName || undefined,
    createdField: cfg.createdField ?? "createdAt",
    eventTimeField: cfg.eventTimeField ?? cfg.createdField ?? "createdAt",
    eventTimeLabel: cfg.eventTimeLabel ?? "creation time",
    lookaheadDays: cfg.lookaheadDays ?? 0,
    statusMap:
      (cfg.statusFulfilled?.length || cfg.statusFailed?.length)
        ? { fulfilled: cfg.statusFulfilled ?? [], failed: cfg.statusFailed ?? [] }
        : undefined,
    dimensions: row.typeFieldName
      ? [{ key: "type", label: "Type", column: row.typeFieldName }]
      : [],
  };

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

  let eventCol = requireCol(contract.eventTimeField, "eventTime");
  const createdCol = requireCol(contract.createdField, "created");
  const statusCol = requireCol(contract.statusField, "status");
  const dims = (contract.dimensions ?? []).filter((d) => {
    if (have.has(d.column)) return true;
    warnings.push(`dimension "${d.column}" not found on ${contract.table} — dropped`);
    return false;
  });
  // Fallback, not failure: when the declared eventTime column doesn't
  // exist, chart on creation time instead (arrival is always a valid
  // capacity axis). Only give up when the table has neither — and even
  // then say exactly what to fix. A mis-guessed contract must shrink the
  // panel, never brick it (the Appointment incident, 22 Jul).
  let eventTimeLabel = contract.eventTimeLabel;
  let lookahead = contract.lookaheadDays;
  if (!eventCol && createdCol) {
    eventCol = createdCol;
    eventTimeLabel = "creation time (fallback — declared event column missing)";
    lookahead = 0; // creation time has no booked-ahead future
    warnings.push(
      `charting on "${createdCol}" instead — fix eventTimeField in the analytics registry to restore ${contract.eventTimeLabel}`
    );
  }
  if (!eventCol) {
    return NextResponse.json(
      {
        error: `Neither eventTime ("${contract.eventTimeField}") nor created ("${contract.createdField}") columns exist on ${contract.table} — update this source's analytics contract`,
        warnings,
      },
      { status: 422 }
    );
  }

  const T = `public.${q(contract.table)}`;
  const E = q(eventCol);
  const C = q(createdCol ?? eventCol);
  const dimExpr = dims.length > 0 ? `${q(dims[0].column)}::text` : `NULL`;

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
    // Case-insensitive matching: labstack vocabularies mix conventions
    // ("Ordered" on Request vs "FULL_DELIVERED" on PharmaOrder). A casing
    // mismatch in a contract must not silently misclassify — uppercase
    // both sides.
    const f = contract.statusMap.fulfilled.map((s) => s.toUpperCase());
    const x = contract.statusMap.failed.map((s) => s.toUpperCase());
    const fPh = f.map((_, i) => `$${i + 1}`).join(", ");
    const xPh = x.map((_, i) => `$${f.length + i + 1}`).join(", ");
    const grouped = await labstackOr<GroupRow[] | null>(
      labstackQuery<GroupRow>(
        `SELECT CASE
                  WHEN UPPER(${q(statusCol)}::text) IN (${fPh}) THEN 'fulfilled'
                  WHEN UPPER(${q(statusCol)}::text) IN (${xPh}) THEN 'failed'
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
    const terminal = [...f, ...x]; // already uppercased above
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
           AND UPPER(${q(statusCol)}::text) NOT IN (${tPh})
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
      key: row.sourceId,
      label: contract.label,
      eventTimeLabel,
      lookaheadDays: lookahead,
      hasStatus: !!statusCol,
      hasFulfillment: !!(statusCol && contract.statusMap),
      dimension: dims[0] ? { key: dims[0].key, label: dims[0].label } : null,
    },
    availableSources,
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
