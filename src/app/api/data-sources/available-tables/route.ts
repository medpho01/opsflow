/**
 * Get Available Tables
 * GET /api/data-sources/available-tables
 *
 * Returns list of all tables in the database
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

  try {
    // Query to get all tables from public schema
    const result = await prisma.$queryRaw<Array<{ table_name: string }>>(
      Prisma.sql`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        ORDER BY table_name ASC
      `
    );

    const tables = result.map((row) => ({
      name: row.table_name,
      label: row.table_name
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" "),
    }));

    return NextResponse.json({
      tables,
      count: tables.length,
    });
  } catch (error) {
    console.error("[AvailableTables] Error fetching tables:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch available tables",
        details: error instanceof Error ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}
