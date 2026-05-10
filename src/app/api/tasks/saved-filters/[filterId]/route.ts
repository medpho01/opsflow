/**
 * DELETE /api/tasks/saved-filters/{filterId}  — delete a saved filter
 * PATCH  /api/tasks/saved-filters/{filterId}  — update a saved filter's usage count
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ filterId: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { filterId: filterIdStr } = await params;
    const filterId = parseInt(filterIdStr.replace("filter_", ""), 10);
    if (isNaN(filterId)) {
      return NextResponse.json({ error: "Invalid filter ID" }, { status: 400 });
    }

    // Ensure the filter belongs to the current user
    const filter = await prisma.userSavedFilter.findFirst({
      where: { id: filterId, userId: user.id },
    });

    if (!filter) {
      return NextResponse.json({ error: "Filter not found" }, { status: 404 });
    }

    await prisma.userSavedFilter.delete({
      where: { id: filterId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[SavedFilters] DELETE Error:", error);
    return NextResponse.json(
      { error: "Failed to delete filter" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ filterId: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { filterId: filterIdStr } = await params;
    const filterId = parseInt(filterIdStr.replace("filter_", ""), 10);
    if (isNaN(filterId)) {
      return NextResponse.json({ error: "Invalid filter ID" }, { status: 400 });
    }

    const body = await request.json();
    const { incrementUsage } = body;

    // Ensure the filter belongs to the current user
    const filter = await prisma.userSavedFilter.findFirst({
      where: { id: filterId, userId: user.id },
    });

    if (!filter) {
      return NextResponse.json({ error: "Filter not found" }, { status: 404 });
    }

    const updated = await prisma.userSavedFilter.update({
      where: { id: filterId },
      data: {
        usageCount: incrementUsage
          ? { increment: 1 }
          : filter.usageCount,
        updatedAt: new Date(),
      },
    });

    return NextResponse.json({
      id: `filter_${updated.id}`,
      name: updated.filterName,
      usage: updated.usageCount,
    });
  } catch (error) {
    console.error("[SavedFilters] PATCH Error:", error);
    return NextResponse.json(
      { error: "Failed to update filter" },
      { status: 500 }
    );
  }
}
