/**
 * GET /api/tasks/filters/schema
 *
 * Returns all available filter options for the filter UI to render.
 * Includes active statuses, priorities, assignees, and date range presets.
 *
 * This endpoint is called once on page load to populate filter dropdowns.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    // Fetch all active agents for assignee list
    const agents = await prisma.user.findMany({
      where: {
        role: UserRole.OPS_AGENT,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
      },
      orderBy: { name: "asc" },
    });

    // Fetch all active data sources for the data-source filter
    const dataSources = await prisma.dataSource.findMany({
      where: { isActive: true },
      select: { id: true, sourceId: true, displayName: true },
      orderBy: { displayName: "asc" },
    });

    // All valid task statuses
    const statuses = [
      "CREATED",
      "ASSIGNED",
      "IN_PROGRESS",
      "BLOCKED",
      "BREACHED",
      "COMPLETED",
      "CANCELLED",
    ];

    // All valid priorities
    const priorities = ["LOW", "MEDIUM", "HIGH", "URGENT"];

    // Date range presets for quick filtering
    const dateRangePresets = [
      { label: "Today", value: "today" },
      { label: "This Week", value: "thisWeek" },
      { label: "This Month", value: "thisMonth" },
      { label: "Custom Range", value: "custom" },
    ];

    const schema = {
      statuses,
      priorities,
      assignees: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
      })),
      dataSources,
      dateRangePresets,
    };

    return NextResponse.json(schema);
  } catch (error) {
    console.error("[FilterSchema] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch filter schema" },
      { status: 500 }
    );
  }
}
