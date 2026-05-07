/**
 * Get Table Columns
 * GET /api/data-sources/table-columns?table=table_name
 *
 * Returns list of columns for a specific table
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import prisma from "@/lib/db/client";
import { Prisma } from "@prisma/client";

export async function GET(req: NextRequest) {
  const user = await getSessionFromRequest(req);

  if (!user || user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json(
      { error: "Unauthorized - OPS_HEAD only" },
      { status: 403 }
    );
  }

  const tableName = req.nextUrl.searchParams.get("table");

  if (!tableName) {
    return NextResponse.json(
      { error: "Missing 'table' query parameter" },
      { status: 400 }
    );
  }

  // Validate table name to prevent SQL injection
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
    return NextResponse.json(
      { error: "Invalid table name" },
      { status: 400 }
    );
  }

  try {
    // Query to get columns for the table
    const result = await prisma.$queryRaw<
      Array<{ column_name: string; data_type: string; is_nullable: string }>
    >(
      Prisma.sql`
        SELECT
          column_name,
          data_type,
          is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = ${tableName}
        ORDER BY ordinal_position ASC
      `
    );

    const columns = result.map((row) => ({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === "YES",
      label: row.column_name
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" "),
    }));

    return NextResponse.json({
      table: tableName,
      columns,
      count: columns.length,
    });
  } catch (error) {
    console.error("[TableColumns] Error fetching columns:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch table columns",
        details: error instanceof Error ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}
