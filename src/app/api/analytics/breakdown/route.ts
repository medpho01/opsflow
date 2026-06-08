/**
 * GET /api/analytics/breakdown?dimension=source|rule|store|task-type&range=today|week|month
 *
 * Per-dimension performance metrics for the analytics dashboard.
 * Closes the audit's two P0 PM gaps (no source-level analytics, no
 * rule-level analytics) plus the P1 store-level gap, with task-type
 * as a fourth axis since the join cost is the same.
 *
 * Each row: open / completed (in range) / breached (in range) / SLA %.
 *
 * Single endpoint with a `dimension` query param rather than four
 * routes; the SQL shape is identical aside from the GROUP BY column +
 * the join needed to fetch the dimension's display name.
 *
 * Auth: OPS_HEAD only (matches /api/analytics/* convention).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import labstack, { labstackOr } from "@/lib/db/labstack";
import { Prisma, UserRole } from "@prisma/client";
import { getRangeStart } from "../_helpers";

type Dimension = "source" | "rule" | "store" | "task-type";

interface BreakdownRow {
  key: string | number;
  name: string;
  open: number;
  completed: number;
  breached: number;
  slaCompliance: number; // 0..100, or null when nothing completed
  total: number; // total tasks ever associated with this key (open + completed + cancelled etc.)
}

interface AggRow {
  key: string | number | null;
  name: string | null;
  open: bigint;
  completed: bigint;
  breached: bigint;
  sla_compliant: bigint;
  total: bigint;
}

const VALID_DIMENSIONS = new Set<Dimension>(["source", "rule", "store", "task-type"]);

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const dimension = (searchParams.get("dimension") ?? "source") as Dimension;
  if (!VALID_DIMENSIONS.has(dimension)) {
    return NextResponse.json(
      { error: `Invalid dimension; must be one of ${Array.from(VALID_DIMENSIONS).join(", ")}` },
      { status: 400 }
    );
  }

  const range = searchParams.get("range") ?? "today";
  const dataSourceId = searchParams.get("dataSourceId"); // W5
  const since = getRangeStart(range);

  // Source filter: dimension="source" already groups by source so a
  // filter would just trivially return one row — we skip it there.
  // For rule / store / task-type, EXISTS-subquery the matching source.
  const sourceFilter = dataSourceId && dimension !== "source"
    ? Prisma.sql`AND EXISTS (
        SELECT 1 FROM taskos.task_rules tr2
        WHERE tr2.id = t."taskRuleId" AND tr2."dataSourceId" = ${dataSourceId}
      )`
    : Prisma.empty;
  // For dimension="rule", the GROUP BY already references task_rules tr;
  // we can filter on tr.dataSourceId directly (cheaper than EXISTS).
  const ruleSourceFilter = dataSourceId && dimension === "rule"
    ? Prisma.sql`AND tr."dataSourceId" = ${dataSourceId}`
    : Prisma.empty;

  // Each dimension differs only in (a) which table we group by and
  // (b) the join needed to surface its human-readable name. SQL kept
  // raw because Prisma's groupBy doesn't compose join + filter in the
  // shape we need (Prisma groupBy returns scalar counts only and
  // doesn't accept a related-name SELECT in the same call).
  let rows: AggRow[];

  if (dimension === "source") {
    rows = await prisma.$queryRaw<AggRow[]>`
      SELECT
        ds.id::text                                                                                   AS key,
        ds."displayName"                                                                              AS name,
        COUNT(t.id) FILTER (WHERE t.status NOT IN ('COMPLETED','CANCELLED'))                          AS open,
        COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED' AND t."completedAt" >= ${since})             AS completed,
        COUNT(t.id) FILTER (WHERE t."slaBreachedAt" >= ${since})                                      AS breached,
        COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED' AND t."completedAt" >= ${since}
                            AND t."slaBreachedAt" IS NULL)                                            AS sla_compliant,
        COUNT(t.id)                                                                                   AS total
      FROM taskos.data_sources ds
      LEFT JOIN taskos.task_rules tr ON tr."dataSourceId" = ds.id
      LEFT JOIN taskos.tasks t        ON t."taskRuleId"   = tr.id AND t."isArchived" = false
      WHERE ds."isActive" = true
      GROUP BY ds.id, ds."displayName"
      ORDER BY ds."displayName" ASC
    `;
  } else if (dimension === "rule") {
    rows = await prisma.$queryRaw<AggRow[]>`
      SELECT
        tr.id::text                                                                                   AS key,
        tr.name                                                                                       AS name,
        COUNT(t.id) FILTER (WHERE t.status NOT IN ('COMPLETED','CANCELLED'))                          AS open,
        COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED' AND t."completedAt" >= ${since})             AS completed,
        COUNT(t.id) FILTER (WHERE t."slaBreachedAt" >= ${since})                                      AS breached,
        COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED' AND t."completedAt" >= ${since}
                            AND t."slaBreachedAt" IS NULL)                                            AS sla_compliant,
        COUNT(t.id)                                                                                   AS total
      FROM taskos.task_rules tr
      LEFT JOIN taskos.tasks t ON t."taskRuleId" = tr.id AND t."isArchived" = false
      WHERE tr."isActive" = true
      ${ruleSourceFilter}
      GROUP BY tr.id, tr.name
      ORDER BY tr.name ASC
    `;
  } else if (dimension === "store") {
    // Two-step lookup so this works when taskos and labstack are on
    // different physical databases (a cross-DB JOIN would fail there).
    // 1) Aggregate task counts by storeId on the taskos DB.
    // 2) Resolve store names from labstack for the storeIds we saw.
    // Tasks with no store collapse into a "(no store)" bucket.
    const aggRows = await prisma.$queryRaw<Array<Omit<AggRow, "name"> & { storeId: number | null }>>`
      SELECT
        COALESCE(t."storeId", -1)::text                                                               AS key,
        t."storeId"                                                                                   AS "storeId",
        COUNT(t.id) FILTER (WHERE t.status NOT IN ('COMPLETED','CANCELLED'))                          AS open,
        COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED' AND t."completedAt" >= ${since})             AS completed,
        COUNT(t.id) FILTER (WHERE t."slaBreachedAt" >= ${since})                                      AS breached,
        COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED' AND t."completedAt" >= ${since}
                            AND t."slaBreachedAt" IS NULL)                                            AS sla_compliant,
        COUNT(t.id)                                                                                   AS total
      FROM taskos.tasks t
      WHERE t."isArchived" = false
      ${sourceFilter}
      GROUP BY t."storeId"
    `;

    const storeIds = aggRows.map((r) => r.storeId).filter((id): id is number => id !== null);
    const storeNameById = new Map<number, string>();
    if (storeIds.length > 0) {
      // labstackOr — store-name resolution is a nice-to-have; if labstack
      // is stuck we skip it and breakdown rows render with storeId
      // numerics instead of holding the analytics page hostage.
      const stores = await labstackOr(
        labstack.$queryRaw<Array<{ id: number; storeName: string }>>`
          SELECT id, "storeName" FROM public."Store" WHERE id = ANY(${storeIds}::int[])
        `,
        [] as Array<{ id: number; storeName: string }>,
      );
      for (const s of stores) storeNameById.set(s.id, s.storeName);
    }

    rows = aggRows
      .map((r) => ({
        ...r,
        name: r.storeId == null ? "(no store)" : (storeNameById.get(r.storeId) ?? "(no store)"),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } else {
    // task-type
    rows = await prisma.$queryRaw<AggRow[]>`
      SELECT
        tt.id::text                                                                                   AS key,
        tt.label                                                                                      AS name,
        COUNT(t.id) FILTER (WHERE t.status NOT IN ('COMPLETED','CANCELLED'))                          AS open,
        COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED' AND t."completedAt" >= ${since})             AS completed,
        COUNT(t.id) FILTER (WHERE t."slaBreachedAt" >= ${since})                                      AS breached,
        COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED' AND t."completedAt" >= ${since}
                            AND t."slaBreachedAt" IS NULL)                                            AS sla_compliant,
        COUNT(t.id)                                                                                   AS total
      FROM taskos.task_types tt
      LEFT JOIN taskos.tasks t ON t."taskTypeId" = tt.id AND t."isArchived" = false
      ${sourceFilter}
      GROUP BY tt.id, tt.label
      ORDER BY tt.label ASC
    `;
  }

  const breakdown: BreakdownRow[] = rows.map((r) => {
    const completed = Number(r.completed);
    const slaCompliant = Number(r.sla_compliant);
    const slaCompliance =
      completed > 0 ? Math.round((slaCompliant / completed) * 100) : 100;
    return {
      key: r.key ?? "(none)",
      name: r.name ?? "(unnamed)",
      open: Number(r.open),
      completed,
      breached: Number(r.breached),
      slaCompliance,
      total: Number(r.total),
    };
  });

  return NextResponse.json({
    dimension,
    range,
    since: since.toISOString(),
    breakdown,
  });
}
