/**
 * Data Source Seeding Endpoint
 * POST /api/data-sources/seed
 *
 * Allows OPS_HEAD to seed predefined data source configurations
 * Useful for setting up new sources like Camps, Appointments, etc.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { seedCampsDataSource } from "@/lib/seed-camps-source";

export async function POST(req: NextRequest) {
  const user = await getSessionFromRequest(req);

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden - OPS_HEAD only" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { source } = body;

    if (!source) {
      return NextResponse.json(
        { error: "Missing 'source' parameter. Valid: camps, appointments" },
        { status: 400 }
      );
    }

    console.log(`[SeedAPI] Seeding data source: ${source}`);

    let result;

    switch (source.toLowerCase()) {
      case "camps":
        result = await seedCampsDataSource();
        break;

      case "appointments":
        // TODO: Implement appointments seeding
        return NextResponse.json(
          { error: "Appointments seeding not yet implemented" },
          { status: 501 }
        );

      default:
        return NextResponse.json(
          { error: `Unknown source: ${source}` },
          { status: 400 }
        );
    }

    return NextResponse.json({
      success: true,
      message: `Data source '${source}' configured successfully`,
      data: {
        source: result.dataSource,
        taskType: result.taskType,
        rulesCount: result.rules.length,
      },
    });
  } catch (error) {
    console.error("[SeedAPI] Error seeding data source:", error);
    return NextResponse.json(
      {
        error: "Failed to seed data source",
        details: error instanceof Error ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  const user = await getSessionFromRequest(req);

  if (!user || user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  return NextResponse.json({
    message: "Use POST with body: { source: 'camps' | 'appointments' }",
    examples: {
      camps: { source: "camps" },
      appointments: { source: "appointments" },
    },
  });
}
