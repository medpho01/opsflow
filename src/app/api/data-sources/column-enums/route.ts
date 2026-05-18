/**
 * Column Enum Values API
 * GET /api/data-sources/column-enums?table={table}&column={column}
 * Fetch possible enum values for a USER-DEFINED type column
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import labstack from "@/lib/db/labstack";
import { Prisma } from "@prisma/client";

/**
 * GET /api/data-sources/column-enums
 * Fetch enum values for a specific column
 * Query params: table (required), column (required)
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getSessionFromRequest(req);

    // Only authenticated users can view enum values
    if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.STORE_ADMIN)) {
      return NextResponse.json(
        { error: "Unauthorized", code: "FORBIDDEN" },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(req.url);
    const table = searchParams.get("table");
    const column = searchParams.get("column");

    if (!table || !column) {
      return NextResponse.json(
        {
          error: "Missing required parameters",
          code: "INVALID_REQUEST",
          details: { required: ["table", "column"] },
        },
        { status: 400 }
      );
    }

    // Strip surrounding double-quotes (PostgreSQL quoted identifiers like "Appointment")
    const tableClean = table.replace(/^"(.+)"$/, "$1");
    const columnClean = column.replace(/^"(.+)"$/, "$1");

    // Validate names after stripping quotes (prevent SQL injection)
    if (!/^[a-zA-Z0-9_]+$/.test(tableClean) || !/^[a-zA-Z0-9_]+$/.test(columnClean)) {
      return NextResponse.json(
        {
          error: "Invalid table or column name",
          code: "INVALID_INPUT",
        },
        { status: 400 }
      );
    }

    // Get the column data type and udt_name from information_schema
    const columnInfo = await labstack.$queryRaw<
      Array<{
        data_type: string;
        udt_name: string;
        udt_schema: string;
      }>
    >(
      Prisma.sql`
        SELECT
          data_type,
          udt_name,
          udt_schema
        FROM
          information_schema.columns
        WHERE
          table_schema = 'public'
          AND table_name = ${tableClean}
          AND column_name = ${columnClean}
        LIMIT 1
      `
    );

    if (columnInfo.length === 0) {
      return NextResponse.json(
        {
          error: "Column not found",
          code: "NOT_FOUND",
        },
        { status: 404 }
      );
    }

    const colInfo = columnInfo[0];
    const dataType = colInfo.data_type;
    const udtName = colInfo.udt_name;
    const udtSchema = colInfo.udt_schema;

    // If it's a USER-DEFINED type (enum), fetch the enum values
    if (dataType === "USER-DEFINED" && udtName) {
      const enumValues = await labstack.$queryRaw<
        Array<{ enumlabel: string }>
      >(
        Prisma.sql`
          SELECT enumlabel
          FROM pg_type
          JOIN pg_enum ON pg_type.oid = pg_enum.enumtypid
          WHERE pg_type.typname = ${udtName}
          AND pg_type.typnamespace = (
            SELECT oid FROM pg_namespace WHERE nspname = ${udtSchema}
          )
          ORDER BY pg_enum.enumsortorder
        `
      );

      const values = enumValues.map((row) => row.enumlabel);

      return NextResponse.json({
        column: columnClean,
        table: tableClean,
        dataType,
        enumType: udtName,
        values,
        found: values.length > 0,
      });
    }

    // For VARCHAR / TEXT columns, try to fetch distinct values as a fallback
    // This covers cases where the source uses string columns instead of enums
    if (dataType === "character varying" || dataType === "text") {
      try {
        const distinctValues = await labstack.$queryRawUnsafe<Array<Record<string, string>>>(
          `SELECT DISTINCT "${columnClean}" as val FROM "${tableClean}" WHERE "${columnClean}" IS NOT NULL ORDER BY "${columnClean}" LIMIT 100`
        );
        const values = distinctValues.map((r) => String(r.val)).filter(Boolean);
        return NextResponse.json({
          column: columnClean,
          table: tableClean,
          dataType,
          enumType: null,
          values,
          found: values.length > 0,
        });
      } catch {
        // Fall through to empty response
      }
    }

    // Not an enum type, return empty values
    return NextResponse.json({
      column: columnClean,
      table: tableClean,
      dataType,
      enumType: null,
      values: [],
      found: false,
      message: `Column is of type "${dataType}", not a USER-DEFINED enum`,
    });
  } catch (error) {
    console.error("[ColumnEnumsAPI] Error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch column enum values",
        code: "FETCH_ERROR",
        details: error instanceof Error ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}
