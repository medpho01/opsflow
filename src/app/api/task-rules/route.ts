/**
 * GET  /api/task-rules  — list all task rules with stats
 * POST /api/task-rules  — create a new task rule
 *
 * Validation is shared with PATCH via lib/validation/task-rules.ts
 * (zod schemas + per-source status check). POST and PATCH can no longer
 * drift apart on what they accept.
 */
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";
import { logRuleAudit } from "@/lib/engine/ruleAudit";
import {
  createRuleSchema,
  validateStatusesAgainstSource,
  zodErrorToResponse,
} from "@/lib/validation/task-rules";
import { getValidOrderStatuses } from "@/types";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rules = await prisma.taskRule.findMany({
    where: { id: { not: "MANUAL" } },
    include: {
      taskType: { select: { id: true, name: true, label: true } },
      requiredSkills: { include: { skillTag: { select: { id: true, name: true, label: true } } } },
      escalationChain: { select: { id: true, name: true } },
      dataSource: { select: { id: true, sourceId: true, displayName: true, typeFieldEnumValues: true, statusFieldEnumValues: true } },
      _count: { select: { tasks: true } },
    },
    orderBy: [{ name: "asc" }, { priority: "asc" }],
  });

  const last24h = new Date(Date.now() - 86_400_000);
  const recentCounts = await prisma.task.groupBy({
    by: ["taskRuleId"],
    where: { createdAt: { gte: last24h }, taskRuleId: { not: "MANUAL" } },
    _count: { id: true },
  });
  const recentMap = Object.fromEntries(recentCounts.map((r) => [r.taskRuleId, r._count.id]));

  const shaped = rules.map((r) => ({
    id: r.id,
    name: r.name,
    dataSourceId: r.dataSourceId,
    dataSource: r.dataSource,
    // Defensive: allowedTypes/allowedStatuses are JSONB; coerce malformed
    // legacy rows to [] so the UI never crashes on a non-array.
    allowedTypes: Array.isArray(r.allowedTypes) ? r.allowedTypes as string[] : [],
    allowedStatuses: Array.isArray(r.allowedStatuses) ? r.allowedStatuses as string[] : [],
    pollingIntervalMinutes: r.pollingIntervalMinutes,
    priority: r.priority,
    slaMinutes: r.slaMinutes,
    isActive: r.isActive,
    titleTemplate: r.titleTemplate,
    triggerCondition: r.triggerCondition,
    assignmentStrategy: r.assignmentStrategy,
    taskType: r.taskType,
    requiredSkills: r.requiredSkills.map((s) => s.skillTag),
    escalationChain: r.escalationChain,
    totalTasksCreated: r._count.tasks,
    tasksLast24h: recentMap[r.id] ?? 0,
  }));

  return NextResponse.json({ rules: shaped });
}

export async function POST(request: NextRequest) {
  const requestId = newRequestId();
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized", requestId }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden", requestId }, { status: 403 });
  }

  let parsed: import("@/lib/validation/task-rules").CreateRuleInput;
  try {
    parsed = createRuleSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ ...zodErrorToResponse(err), requestId }, { status: 400 });
    }
    throw err;
  }

  try {
    // Validate data source exists
    const dataSource = await prisma.dataSource.findUnique({ where: { id: parsed.dataSourceId } });
    if (!dataSource) return NextResponse.json({ error: "Data source not found", requestId }, { status: 404 });

    // Validate status values against the SOURCE's enum (not just LabstackOrderStatus).
    // Previously POST skipped this check entirely; PATCH applied it. They're now consistent.
    // Skipped for drafts — authors may save partial work with a placeholder status.
    if (!parsed.isDraft) {
      const statusValidation = await validateStatusesAgainstSource(
        parsed.dataSourceId,
        parsed.triggerCondition.statusIn
      );
      if (!statusValidation.valid) {
        return NextResponse.json({
          error: "Invalid order status in triggerCondition.statusIn",
          code: "VALIDATION_ERROR",
          invalidStatuses: statusValidation.invalidStatuses,
          validStatuses: statusValidation.validStatuses ?? getValidOrderStatuses(),
          requestId,
        }, { status: 400 });
      }
    }

    // Resolve task type — use provided id if supplied, otherwise auto-default to first available
    let resolvedTaskTypeId: number;
    if (parsed.taskTypeId) {
      const taskType = await prisma.taskType.findUnique({ where: { id: parsed.taskTypeId } });
      if (!taskType) return NextResponse.json({ error: "Task type not found", requestId }, { status: 404 });
      resolvedTaskTypeId = taskType.id;
    } else {
      const defaultType = await prisma.taskType.findFirst({ orderBy: { id: "asc" } });
      if (!defaultType) return NextResponse.json({ error: "No task types configured", requestId }, { status: 500 });
      resolvedTaskTypeId = defaultType.id;
    }

    const rule = await prisma.taskRule.create({
      data: {
        name: parsed.name,
        dataSourceId: parsed.dataSourceId,
        allowedTypes: parsed.allowedTypes,
        allowedStatuses: parsed.allowedStatuses,
        pollingIntervalMinutes: parsed.pollingIntervalMinutes,
        taskTypeId: resolvedTaskTypeId,
        titleTemplate: parsed.titleTemplate,
        slaMinutes: parsed.slaMinutes,
        priority: parsed.priority as never,
        triggerCondition: parsed.triggerCondition,
        assignmentStrategy: parsed.assignmentStrategy,
        // Drafts land inactive — they pass validation but won't fire until
        // the author flips the toggle. See W3.2 in the audit roadmap.
        isActive: !parsed.isDraft,
        escalationChainId: parsed.escalationChainId ?? null,
        requiredSkills: parsed.skillTagIds.length
          ? { create: parsed.skillTagIds.map((id) => ({ skillTagId: id })) }
          : undefined,
      },
      include: {
        taskType: { select: { id: true, name: true, label: true } },
        requiredSkills: { include: { skillTag: { select: { id: true, name: true, label: true } } } },
        escalationChain: { select: { id: true, name: true } },
        dataSource: { select: { id: true, sourceId: true, displayName: true } },
      },
    });

    await logRuleAudit({
      action: "CREATE",
      ruleId: rule.id,
      changedById: user.id,
      metadata: {
        ruleName: rule.name,
        dataSourceId: rule.dataSourceId,
        priority: rule.priority,
        allowedTypes: parsed.allowedTypes,
        allowedStatuses: parsed.allowedStatuses,
        isDraft: parsed.isDraft,
      },
    });

    return NextResponse.json({ rule, requestId }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "TaskRulesAPI.POST",
        code: "CREATION_ERROR",
        userMessage: "Failed to create task rule",
        error,
      }),
      { status: 500 }
    );
  }
}
