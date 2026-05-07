/**
 * Data Sources API
 * GET /api/data-sources - List all data sources
 * POST /api/data-sources - Register a new data source
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import prisma from "@/lib/db/client";
import { RegisterDataSourceRequest, RegisterDataSourceResponse, ValidationResult } from "@/types/multi-source";

/**
 * GET /api/data-sources
 * List all data sources
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getSessionFromRequest(req);

    // Only OPS_HEAD can view all data sources
    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json(
        { error: "Unauthorized", code: "FORBIDDEN" },
        { status: 403 }
      );
    }

    const dataSources = await prisma.dataSource.findMany({
      select: {
        id: true,
        sourceId: true,
        displayName: true,
        description: true,
        tableReference: true,
        primaryKeyField: true,
        typeFieldName: true,
        statusFieldName: true,
        typeFieldEnumValues: true,
        statusFieldEnumValues: true,
        queryTemplate: true,
        metadataFieldMapping: true,
        isActive: true,
        pollingIntervalMinutes: true,
        pollingType: true,
        syncStrategy: true,
        backfillEnabled: true,
        backfillCompleted: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json({
      dataSources,
      count: dataSources.length,
    });
  } catch (error) {
    console.error("[DataSourcesAPI] GET error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch data sources",
        code: "FETCH_ERROR",
        details: error instanceof Error ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/data-sources
 * Register a new data source
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionFromRequest(req);

    // Only OPS_HEAD can register new data sources
    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json(
        { error: "Unauthorized", code: "FORBIDDEN" },
        { status: 403 }
      );
    }

    const body = (await req.json()) as RegisterDataSourceRequest;

    // Validate required fields
    const requiredFields = [
      "sourceId",
      "displayName",
      "tableReference",
      "primaryKeyField",
      "typeFieldName",
      "statusFieldName",
      "queryTemplate",
    ];

    const missingFields = requiredFields.filter((field) => !body[field as keyof RegisterDataSourceRequest]);
    if (missingFields.length > 0) {
      return NextResponse.json(
        {
          error: "Missing required fields",
          code: "VALIDATION_ERROR",
          details: { missingFields },
        },
        { status: 400 }
      );
    }

    // Check if source already exists
    const existingSource = await prisma.dataSource.findUnique({
      where: { sourceId: body.sourceId },
    });

    if (existingSource) {
      return NextResponse.json(
        {
          error: "Data source already exists",
          code: "CONFLICT",
          details: { sourceId: body.sourceId },
        },
        { status: 409 }
      );
    }

    // Validate connection to source (basic check - would be extended with actual handler validation)
    // For now, we'll allow registration without immediate validation
    // The validation will be done when the polling engine is initialized

    // Create the data source
    const dataSource = await prisma.dataSource.create({
      data: {
        sourceId: body.sourceId,
        displayName: body.displayName,
        description: body.description,
        tableReference: body.tableReference,
        primaryKeyField: body.primaryKeyField || "id",
        typeFieldName: body.typeFieldName,
        statusFieldName: body.statusFieldName,
        typeFieldEnumValues: body.typeFieldEnumValues || null,
        statusFieldEnumValues: body.statusFieldEnumValues || null,
        queryTemplate: body.queryTemplate,
        metadataFieldMapping: body.metadataFieldMapping,
        pollingIntervalMinutes: body.pollingIntervalMinutes || 5,
        pollingType: "DATABASE", // Default to DATABASE
        backfillEnabled: body.backfillEnabled || false,
        backfillDays: body.backfillDays || 7,
        createdById: user.id,
        isActive: true,
      },
    });

    // Return response
    const response: RegisterDataSourceResponse = {
      id: dataSource.id,
      sourceId: dataSource.sourceId,
      displayName: dataSource.displayName,
      validationResult: {
        ok: true,
        message: "Data source registered successfully",
      },
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    console.error("[DataSourcesAPI] POST error:", error);
    return NextResponse.json(
      {
        error: "Failed to register data source",
        code: "CREATION_ERROR",
        details: error instanceof Error ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}
