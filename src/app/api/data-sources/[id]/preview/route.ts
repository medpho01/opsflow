/**
 * Data Source Preview API
 * GET /api/data-sources/{id}/preview?limit=10
 *
 * Returns the most recent N rows from the source's underlying table so the
 * head can sanity-check what the polling engine will see — without waiting
 * for the next poll cycle.
 *
 * Behaviour:
 *   - Uses the source's `tableReference` directly (validated at registration time).
 *   - Orders by `updated_at` DESC if the column exists, else `id` DESC, else
 *     no ORDER BY (with a flag in the response so the UI can warn).
 *   - Capped at 50 rows to keep the response small.
 *   - Returns column metadata (name + data_type) alongside the rows so the UI
 *     can render typed cells.
 *
 * Failure modes:
 *   - 400 if the source's tableReference no longer matches a valid identifier
 *     shape (defence; should never happen for sources created via the API).
 *   - 404 if the source ID doesn't exist.
 *   - 500 if the source's table no longer exists or columns can't be read.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { Prisma, UserRole } from "@prisma/client";
import prisma from "@/lib/db/client";
import labstack from "@/lib/db/labstack";
import {
  isValidTableReference,
  bareTableName,
} from "@/lib/validation/data-sources";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = newRequestId();

  try {
    const user = await getSessionFromRequest(req);

    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json(
        { error: "Unauthorized", code: "FORBIDDEN", requestId },
        { status: 403 }
      );
    }

    const { id } = await params;

    // Parse limit (clamped to MAX_LIMIT)
    const url = new URL(req.url);
    const rawLimit = parseInt(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10);
    const limit = Math.min(MAX_LIMIT, Math.max(1, isNaN(rawLimit) ? DEFAULT_LIMIT : rawLimit));

    // ─── Source lookup ────────────────────────────────────────────────────
    const dataSource = await prisma.dataSource.findUnique({
      where: { id },
      select: {
        id: true,
        sourceId: true,
        displayName: true,
        tableReference: true,
        primaryKeyField: true,
      },
    });

    if (!dataSource) {
      return NextResponse.json(
        { error: "Data source not found", code: "NOT_FOUND", requestId },
        { status: 404 }
      );
    }

    // Re-validate tableReference shape — defence in depth in case a source
    // was somehow created/edited with a malformed value before validation
    // landed (e.g. via direct DB write).
    if (!isValidTableReference(dataSource.tableReference)) {
      return NextResponse.json(
        {
          error: "Source has an invalid tableReference",
          code: "INVALID_SOURCE_CONFIG",
          requestId,
          details: { tableReference: dataSource.tableReference },
        },
        { status: 400 }
      );
    }

    const bareTable = bareTableName(dataSource.tableReference);

    // ─── Discover columns to pick a sensible ORDER BY ─────────────────────
    // Prefer `updated_at` (canonical), then `updatedAt`, then the primary key.
    const columns = await labstack.$queryRaw<
      Array<{ column_name: string; data_type: string; ordinal_position: number }>
    >(Prisma.sql`
      SELECT column_name, data_type, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${bareTable}
      ORDER BY ordinal_position
    `);

    if (columns.length === 0) {
      return NextResponse.json(
        {
          error: `Table "${bareTable}" not found in schema "public"`,
          code: "TABLE_NOT_FOUND",
          requestId,
        },
        { status: 500 }
      );
    }

    const columnNames = new Set(columns.map((c) => c.column_name));
    let orderByColumn: string | null = null;
    if (columnNames.has("updated_at")) orderByColumn = "updated_at";
    else if (columnNames.has("updatedAt")) orderByColumn = "updatedAt";
    else if (columnNames.has(dataSource.primaryKeyField)) orderByColumn = dataSource.primaryKeyField;

    // ─── Fetch rows ───────────────────────────────────────────────────────
    // tableReference and orderByColumn have both been validated/whitelisted
    // (orderByColumn comes from information_schema, not user input). Limit
    // is clamped to a small integer.
    //
    // We use Prisma.raw for the table identifier because Prisma's parameter
    // placeholder syntax is for VALUES, not identifiers — the standard PG
    // pattern. Safe because the value has cleared isValidTableReference.
    const orderByClause = orderByColumn
      ? Prisma.sql`ORDER BY ${Prisma.raw(`"${orderByColumn}"`)} DESC NULLS LAST`
      : Prisma.empty;

    const rows = await labstack.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT * FROM ${Prisma.raw(dataSource.tableReference)}
      ${orderByClause}
      LIMIT ${limit}
    `);

    // BigInt handling — Postgres `bigint` columns become JS `BigInt`, which
    // JSON.stringify can't serialize. Coerce to string per cell.
    const safeRows = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        out[k] = typeof v === "bigint" ? v.toString() : v;
      }
      return out;
    });

    return NextResponse.json({
      source: {
        id: dataSource.id,
        sourceId: dataSource.sourceId,
        displayName: dataSource.displayName,
        tableReference: dataSource.tableReference,
      },
      columns,
      rows: safeRows,
      meta: {
        limit,
        rowCount: safeRows.length,
        orderedBy: orderByColumn,
        orderedDesc: !!orderByColumn,
      },
      requestId,
    });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "DataSourcePreviewAPI.GET",
        code: "PREVIEW_ERROR",
        userMessage: "Failed to preview data source",
        error,
      }),
      { status: 500 }
    );
  }
}
