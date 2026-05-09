/**
 * Data Source Validation API
 * POST /api/data-sources/validate
 * Validate a data source configuration before registration.
 *
 * Returns:
 *   - 200 + { ok: true,  message }  → table & required columns exist
 *   - 200 + { ok: false, message }  → validation failed (table or column missing)
 *   - 400 + { error, code, requestId, details } → bad input shape
 *   - 500 + { error, code, requestId, details } → unexpected server/DB error
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { Prisma, UserRole } from "@prisma/client";
import prisma from "@/lib/db/client";
import {
  isValidSourceId,
  isValidTableReference,
  isValidSqlIdentifier,
  bareTableName,
  validationError,
} from "@/lib/validation/data-sources";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

export async function POST(req: NextRequest) {
  const requestId = newRequestId();

  try {
    const user = await getSessionFromRequest(req);

    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json(
        { error: "Unauthorized", code: "FORBIDDEN", requestId },
        { status: 403 }
      );
    }

    const body = await req.json();
    const { sourceId, tableReference, primaryKeyField, typeFieldName, statusFieldName } = body ?? {};

    // ─── Input validation ─────────────────────────────────────────────────
    // Each required field must be present AND match the right shape. Bad input
    // is a 400; the body identifies which specific field failed.
    if (!sourceId || !tableReference || !primaryKeyField || !typeFieldName || !statusFieldName) {
      return NextResponse.json(
        {
          error: "Missing required fields",
          code: "VALIDATION_ERROR",
          requestId,
          details: { required: ["sourceId", "tableReference", "primaryKeyField", "typeFieldName", "statusFieldName"] },
        },
        { status: 400 }
      );
    }

    if (!isValidSourceId(sourceId)) {
      return NextResponse.json({ ...validationError("sourceId", "must be a valid identifier (letters, digits, underscore; ≤63 chars; cannot start with digit)"), requestId }, { status: 400 });
    }
    if (!isValidTableReference(tableReference)) {
      return NextResponse.json({ ...validationError("tableReference", "must be a valid table reference like 'Order', 'public.Order', or 'public.\"Order\"'"), requestId }, { status: 400 });
    }
    for (const [field, value] of [
      ["primaryKeyField", primaryKeyField],
      ["typeFieldName", typeFieldName],
      ["statusFieldName", statusFieldName],
    ] as const) {
      if (!isValidSqlIdentifier(value)) {
        return NextResponse.json({ ...validationError(field, "must be a valid SQL column identifier"), requestId }, { status: 400 });
      }
    }

    // ─── Schema lookup ────────────────────────────────────────────────────
    // All values reaching this point have been character-class validated.
    // The query uses parameterised placeholders via Prisma.join — no string
    // concatenation, no Prisma.raw on user-supplied data.
    const bareTable = bareTableName(tableReference);
    const requiredColumns = [primaryKeyField, typeFieldName, statusFieldName];

    const tableInfo = await prisma.$queryRaw<
      Array<{ column_name: string; data_type: string }>
    >(Prisma.sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${bareTable}
        AND column_name IN (${Prisma.join(requiredColumns)})
    `);

    // ─── Compute outcome ──────────────────────────────────────────────────
    if (tableInfo.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          message: `Table "${bareTable}" not found in schema "public", or none of the required columns exist on it`,
          requestId,
        },
        { status: 200 }
      );
    }

    const foundColumns = new Set(tableInfo.map((t) => t.column_name));
    const missingColumns = requiredColumns.filter((c) => !foundColumns.has(c));
    if (missingColumns.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          message: `Missing columns on "${bareTable}": ${missingColumns.join(", ")}`,
          missingColumns,
          requestId,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        message: `Validation successful — table "${bareTable}" has all required columns`,
        columns: tableInfo,
        requestId,
      },
      { status: 200 }
    );
  } catch (error) {
    // Real server/DB error — distinct from a "validation failed" 200.
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "DataSourcesAPI.validate",
        code: "VALIDATION_ENDPOINT_ERROR",
        userMessage: "Validation could not be performed due to a server error",
        error,
      }),
      { status: 500 }
    );
  }
}
