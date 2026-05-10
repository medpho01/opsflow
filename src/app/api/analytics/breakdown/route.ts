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
import { UserRole } from "@prisma/client";
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
  const since = getRangeStart(range);

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
      GROUP BY tr.id, tr.name
      ORDER BY tr.name ASC
    `;
  } else if (dimension === "store") {
    // Store names live in labstack public schema; left-join across
    // schemas works because the FK is nominal (Task.storeId is just a
    // number — no FK constraint to public."Store"). Tasks with no store
    // collapse into a "(no store)" bucket.
    rows = await prisma.$queryRaw<AggRow[]>`
      SELECT
        COALESCE(t."storeId", -1)::text                                                               AS key,
        COALESCE(s."storeName", '(no store)')                                                         AS name,
        COUNT(t.id) FILTER (WHERE t.status NOT IN ('COMPLETED','CANCELLED'))                          AS open,
        COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED' AND t."completedAt" >= ${since})             AS completed,
        COUNT(t.id) FILTER (WHERE t."slaBreachedAt" >= ${since})                                      AS breached,
        COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED' AND t."completedAt" >= ${since}
                            AND t."slaBreachedAt" IS NULL)                                            AS sla_compliant,
        COUNT(t.id)                                                                                   AS total
      FROM taskos.tasks t
      LEFT JOIN public."Store" s ON s.id = t."storeId"
      WHERE t."isArchived" = false
      GROUP BY t."storeId", s."storeName"
      ORDER BY s."storeName" ASC NULLS LAST
    `;
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
