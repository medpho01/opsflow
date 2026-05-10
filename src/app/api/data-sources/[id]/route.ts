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
import {
  isValidSqlIdentifier,
  isValidPollingInterval,
  isValidBackfillDays,
  isReadOnlyQueryTemplate,
  POLLING_INTERVAL_MIN,
  POLLING_INTERVAL_MAX,
  validationError,
} from "@/lib/validation/data-sources";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

/**
 * GET /api/data-sources/{id}
 * Get a specific data source
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = newRequestId();

  try {
    const user = await getSessionFromRequest(req);

    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json(
        { error: "Unauthorized", code: "FORBIDDEN", requestId },
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
        { error: "Data source not found", code: "NOT_FOUND", requestId },
        { status: 404 }
      );
    }

    return NextResponse.json(dataSource);
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "DataSourceDetailAPI.GET",
        code: "FETCH_ERROR",
        userMessage: "Failed to fetch data source",
        error,
      }),
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
  const requestId = newRequestId();

  try {
    const user = await getSessionFromRequest(req);

    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json(
        { error: "Unauthorized", code: "FORBIDDEN", requestId },
        { status: 403 }
      );
    }

    const { id } = await params;
    const body = await req.json();

    const existingSource = await prisma.dataSource.findUnique({
      where: { id },
    });

    if (!existingSource) {
      return NextResponse.json(
        { error: "Data source not found", code: "NOT_FOUND", requestId },
        { status: 404 }
      );
    }

    // ─── Field-shape validation (only when caller is changing the field) ──
    // Each writable field is checked iff present in the body — preserves the
    // partial-update semantic but prevents PUT from being a back door around
    // the POST-time guards.
    if (body.primaryKeyField !== undefined && !isValidSqlIdentifier(body.primaryKeyField)) {
      return NextResponse.json({ ...validationError("primaryKeyField", "must be a valid SQL column identifier"), requestId }, { status: 400 });
    }
    if (body.typeFieldName !== undefined && !isValidSqlIdentifier(body.typeFieldName)) {
      return NextResponse.json({ ...validationError("typeFieldName", "must be a valid SQL column identifier"), requestId }, { status: 400 });
    }
    if (body.statusFieldName !== undefined && !isValidSqlIdentifier(body.statusFieldName)) {
      return NextResponse.json({ ...validationError("statusFieldName", "must be a valid SQL column identifier"), requestId }, { status: 400 });
    }
    if (body.queryTemplate !== undefined && !isReadOnlyQueryTemplate(body.queryTemplate)) {
      return NextResponse.json({ ...validationError("queryTemplate", "must be a single read-only query starting with SELECT or WITH; INSERT/UPDATE/DELETE/DDL not allowed"), requestId }, { status: 400 });
    }
    if (body.pollingIntervalMinutes !== undefined && !isValidPollingInterval(body.pollingIntervalMinutes)) {
      return NextResponse.json({ ...validationError("pollingIntervalMinutes", `must be an integer between ${POLLING_INTERVAL_MIN} and ${POLLING_INTERVAL_MAX}`), requestId }, { status: 400 });
    }
    if (body.backfillEnabled !== undefined && typeof body.backfillEnabled !== "boolean") {
      return NextResponse.json({ ...validationError("backfillEnabled", "must be a boolean"), requestId }, { status: 400 });
    }
    if (body.backfillDays !== undefined && !isValidBackfillDays(body.backfillDays)) {
      return NextResponse.json({ ...validationError("backfillDays", "must be an integer between 0 and 365"), requestId }, { status: 400 });
    }
    if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
      return NextResponse.json({ ...validationError("isActive", "must be a boolean"), requestId }, { status: 400 });
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
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "DataSourceDetailAPI.PUT",
        code: "UPDATE_ERROR",
        userMessage: "Failed to update data source",
        error,
      }),
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
  const requestId = newRequestId();

  try {
    const user = await getSessionFromRequest(req);

    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json(
        { error: "Unauthorized", code: "FORBIDDEN", requestId },
        { status: 403 }
      );
    }

    const { id } = await params;

    const existingSource = await prisma.dataSource.findUnique({
      where: { id },
    });

    if (!existingSource) {
      return NextResponse.json(
        { error: "Data source not found", code: "NOT_FOUND", requestId },
        { status: 404 }
      );
    }

    // Soft delete — mark inactive; rule scopes & polling logs preserved.
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
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "DataSourceDetailAPI.DELETE",
        code: "DELETE_ERROR",
        userMessage: "Failed to delete data source",
        error,
      }),
      { status: 500 }
    );
  }
}
