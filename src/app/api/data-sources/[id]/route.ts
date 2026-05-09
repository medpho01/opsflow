/**
 * Data Source Details API
 * GET /api/data-sources/{id} - Get a specific data source
 * PUT /api/data-sources/{id} - Update a data source
 * DELETE /api/data-sources/{id} - Delete a data source
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import prisma from "@/lib/db/client";

/**
 * GET /api/data-sources/{id}
 * Get a specific data source
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionFromRequest(req);

    // Only OPS_HEAD can view data sources
    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json(
        { error: "Unauthorized", code: "FORBIDDEN" },
        { status: 403 }
      );
    }

    const { id } = await params;

    const dataSource = await prisma.dataSource.findUnique({
      where: { id },
      include: {
        ruleScopes: {
          include: {
            taskRule: true,
          },
        },
      },
    });

    if (!dataSource) {
      return NextResponse.json(
        { error: "Data source not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    return NextResponse.json(dataSource);
  } catch (error) {
    console.error("[DataSourceDetailAPI] GET error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch data source",
        code: "FETCH_ERROR",
        details: error instanceof Error ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/data-sources/{id}
 * Update a data source
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionFromRequest(req);

    // Only OPS_HEAD can update data sources
    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json(
        { error: "Unauthorized", code: "FORBIDDEN" },
        { status: 403 }
      );
    }

    const { id } = await params;
    const body = await req.json();

    // Check if data source exists
    const existingSource = await prisma.dataSource.findUnique({
      where: { id },
    });

    if (!existingSource) {
      return NextResponse.json(
        { error: "Data source not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    // Update allowed fields — sourceId and tableReference are immutable (polling identity)
    const updatedDataSource = await prisma.dataSource.update({
      where: { id },
      data: {
        displayName:            body.displayName            ?? existingSource.displayName,
        description:            body.description            ?? existingSource.description,
        pollingIntervalMinutes: body.pollingIntervalMinutes ?? existingSource.pollingIntervalMinutes,
        isActive:               body.isActive               ?? existingSource.isActive,
        syncStrategy:           body.syncStrategy           ?? existingSource.syncStrategy,
        syncEndpoint:           body.syncEndpoint           ?? existingSource.syncEndpoint,
        backfillEnabled:        body.backfillEnabled        ?? existingSource.backfillEnabled,
        backfillDays:           body.backfillDays           ?? existingSource.backfillDays,
        // Field mappings — editable after creation
        typeFieldName:          body.typeFieldName          ?? existingSource.typeFieldName,
        statusFieldName:        body.statusFieldName        ?? existingSource.statusFieldName,
        primaryKeyField:        body.primaryKeyField        ?? existingSource.primaryKeyField,
        queryTemplate:          body.queryTemplate          ?? existingSource.queryTemplate,
        updatedAt: new Date(),
      },
    });

    return NextResponse.json(updatedDataSource);
  } catch (error) {
    console.error("[DataSourceDetailAPI] PUT error:", error);
    return NextResponse.json(
      {
        error: "Failed to update data source",
        code: "UPDATE_ERROR",
        details: error instanceof Error ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/data-sources/{id}
 * Delete a data source (soft delete or archive)
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionFromRequest(req);

    // Only OPS_HEAD can delete data sources
    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json(
        { error: "Unauthorized", code: "FORBIDDEN" },
        { status: 403 }
      );
    }

    const { id } = await params;

    // Check if data source exists
    const existingSource = await prisma.dataSource.findUnique({
      where: { id },
    });

    if (!existingSource) {
      return NextResponse.json(
        { error: "Data source not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    // Soft delete - mark as inactive
    const updatedDataSource = await prisma.dataSource.update({
      where: { id },
      data: {
        isActive: false,
        updatedAt: new Date(),
      },
    });

    return NextResponse.json({
      success: true,
      message: "Data source deactivated",
      dataSource: updatedDataSource,
    });
  } catch (error) {
    console.error("[DataSourceDetailAPI] DELETE error:", error);
    return NextResponse.json(
      {
        error: "Failed to delete data source",
        code: "DELETE_ERROR",
        details: error instanceof Error ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}
