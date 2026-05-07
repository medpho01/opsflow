/**
 * Task Assignment Validation API
 * POST /api/tasks/validate-assignment
 * Test assignment before task creation
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { simulateAssignment } from "@/lib/task-creation/assignment-service";
import { SourceEntity } from "@/types/multi-source";

interface ValidateAssignmentRequest {
  sourceId: string;
  entity: SourceEntity;
  strategyName: string;
  strategyConfig?: Record<string, unknown>;
  storeId?: number;
  requiredSkills?: string[];
  taskDate?: string; // ISO date string
}

/**
 * POST /api/tasks/validate-assignment
 * Simulate assignment and return which agent would be assigned
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionFromRequest(req);

    // OPS_HEAD can validate assignments
    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json(
        { error: "Unauthorized", code: "FORBIDDEN" },
        { status: 403 }
      );
    }

    const body = (await req.json()) as ValidateAssignmentRequest;

    // Validate request
    if (!body.sourceId || !body.entity || !body.strategyName) {
      return NextResponse.json(
        {
          error: "Missing required fields",
          code: "VALIDATION_ERROR",
          details: { required: ["sourceId", "entity", "strategyName"] },
        },
        { status: 400 }
      );
    }

    // Simulate assignment
    const result = await simulateAssignment({
      sourceId: body.sourceId,
      entity: body.entity,
      strategyName: body.strategyName,
      strategyConfig: body.strategyConfig,
      storeId: body.storeId,
      requiredSkills: body.requiredSkills,
      taskDate: body.taskDate ? new Date(body.taskDate) : undefined,
    });

    return NextResponse.json({
      success: result.success,
      strategy: result.strategy,
      assignedToId: result.assignedToId || null,
      teamMemberId: result.teamMemberId || null,
      reason: result.reason,
      error: result.error || null,
      simulatedAt: result.simulatedAt,
    });
  } catch (error) {
    console.error("[ValidateAssignmentAPI] Error:", error);
    return NextResponse.json(
      {
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details: error instanceof Error ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}
