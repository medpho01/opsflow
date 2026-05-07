/**
 * GET  /api/tasks/saved-filters  — fetch user's saved filter combinations
 * POST /api/tasks/saved-filters  — save a new filter combination
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";

interface SavedFilter {
  status?: string[];
  priority?: string[];
  assigneeId?: number[];
  dateFrom?: string;
  dateTo?: string;
  slaRiskOnly?: boolean;
}

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const filters = await prisma.userSavedFilter.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        filterName: true,
        filterJson: true,
        createdAt: true,
        usageCount: true,
      },
      orderBy: { usageCount: "desc" },
    });

    return NextResponse.json({
      filters: filters.map((f) => ({
        id: `filter_${f.id}`,
        name: f.filterName,
        filters: f.filterJson as SavedFilter,
        createdAt: f.createdAt.toISOString(),
        usage: f.usageCount,
      })),
    });
  } catch (error) {
    console.error("[SavedFilters] GET Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch saved filters" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json();
    const { name, filters } = body;

    if (!name || !filters) {
      return NextResponse.json(
        { error: "name and filters are required" },
        { status: 400 }
      );
    }

    if (typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Filter name must be non-empty string" },
        { status: 400 }
      );
    }

    // Upsert: if name already exists for this user, update it. Otherwise, create.
    const savedFilter = await prisma.userSavedFilter.upsert({
      where: {
        userId_filterName: {
          userId: user.id,
          filterName: name.trim(),
        },
      },
      create: {
        userId: user.id,
        filterName: name.trim(),
        filterJson: filters as SavedFilter,
        usageCount: 1,
      },
      update: {
        filterJson: filters as SavedFilter,
        updatedAt: new Date(),
      },
    });

    return NextResponse.json(
      {
        id: `filter_${savedFilter.id}`,
        name: savedFilter.filterName,
        filters: savedFilter.filterJson,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[SavedFilters] POST Error:", error);
    return NextResponse.json(
      { error: "Failed to save filter" },
      { status: 500 }
    );
  }
}
