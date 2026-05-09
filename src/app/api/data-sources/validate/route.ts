/**
 * Data Source Validation API
 * POST /api/data-sources/validate
 * Validate a data source configuration before registration
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import prisma from "@/lib/db/client";
import { Prisma } from "@prisma/client";

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionFromRequest(req);

    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json(
        { error: "Unauthorized", code: "FORBIDDEN" },
        { status: 403 }
      );
    }

    const body = await req.json();
    const { sourceId, tableReference, primaryKeyField, typeFieldName, statusFieldName } = body;

    if (!sourceId || !tableReference || !primaryKeyField || !typeFieldName || !statusFieldName) {
      return NextResponse.json(
        {
          error: "Missing required fields",
          code: "VALIDATION_ERROR",
        },
        { status: 400 }
      );
    }

    // Normalise to bare table name — strip schema prefix and quotes
    // Handles both "Appointment" and 'public."Appointment"' formats
    const bareTableName = tableReference
      .replace(/^[^."]+\."?/, "") // strip schema prefix e.g. public."
      .replace(/"$/, "");          // strip trailing quote

    // Validate table exists and has required columns
    const tableInfo = await prisma.$queryRaw<
      Array<{
        column_name: string;
        data_type: string;
      }>
    >(
      Prisma.sql`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = ${bareTableName}
        AND column_name IN (${Prisma.raw(
          [primaryKeyField, typeFieldName, statusFieldName]
            .map((col) => `'${col}'`)
            .join(",")
        )})
      `
    );

    if (tableInfo.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          message: `Table "${bareTableName}" not found or columns don't exist`,
        },
        { status: 200 }
      );
    }

    const foundColumns = tableInfo.map((t) => t.column_name);
    const requiredColumns = [primaryKeyField, typeFieldName, statusFieldName];
    const missingColumns = requiredColumns.filter((col) => !foundColumns.includes(col));

    if (missingColumns.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          message: `Missing columns: ${missingColumns.join(", ")}`,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        message: "Validation successful - table and columns exist",
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[DataSourceValidateAPI] Error:", error);
    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : "Validation failed",
      },
      { status: 200 }
    );
  }
}
