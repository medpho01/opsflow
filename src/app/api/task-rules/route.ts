/**
 * GET  /api/task-rules  — list all task rules with stats
 * POST /api/task-rules  — create a new task rule
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole, OrderType, TaskPriority } from "@prisma/client";
import { validateTriggerConditionStatuses, getValidOrderStatuses, MetadataOperator } from "@/types";
import { logRuleAudit } from "@/lib/engine/ruleAudit";

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rules = await prisma.taskRule.findMany({
    where: { id: { not: "MANUAL" } },
    include: {
      taskType: { select: { name: true, label: true } },
      requiredSkills: { include: { skillTag: { select: { id: true, name: true, label: true } } } },
      escalationChain: { select: { id: true, name: true } },
      _count: { select: { tasks: true } },
    },
    orderBy: [{ orderType: "asc" }, { priority: "asc" }],
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
    orderType: r.orderType,
    priority: r.priority,
    slaMinutes: r.slaMinutes,
    isActive: r.isActive,
    titleTemplate: r.titleTemplate,
    triggerCondition: r.triggerCondition,
    taskType: r.taskType,
    requiredSkills: r.requiredSkills.map((s) => s.skillTag),
    escalationChain: r.escalationChain,
    totalTasksCreated: r._count.tasks,
    tasksLast24h: recentMap[r.id] ?? 0,
  }));

  return NextResponse.json({ rules: shaped });
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const {
    name, orderType, taskTypeId, titleTemplate,
    slaMinutes, priority, triggerCondition,
    escalationChainId, skillTagIds,
  } = body;

  // Validate required fields
  if (!name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!orderType || !Object.values(OrderType).includes(orderType)) {
    return NextResponse.json({ error: "valid orderType is required" }, { status: 400 });
  }
  if (!taskTypeId) return NextResponse.json({ error: "taskTypeId is required" }, { status: 400 });
  if (!titleTemplate?.trim()) return NextResponse.json({ error: "titleTemplate is required" }, { status: 400 });
  if (!slaMinutes || Number(slaMinutes) < 1) {
    return NextResponse.json({ error: "slaMinutes must be a positive integer" }, { status: 400 });
  }
  if (!priority || !Object.values(TaskPriority).includes(priority)) {
    return NextResponse.json({ error: "valid priority is required" }, { status: 400 });
  }

  // Validate trigger condition
  if (!triggerCondition?.statusIn?.length) {
    return NextResponse.json({ error: "triggerCondition.statusIn must have at least one status" }, { status: 400 });
  }

  // NEW P1: Validate status values
  const statusValidation = validateTriggerConditionStatuses(triggerCondition.statusIn);
  if (!statusValidation.valid) {
    return NextResponse.json({
      error: "Invalid order status in triggerCondition.statusIn",
      invalidStatuses: statusValidation.invalidStatuses,
      validStatuses: getValidOrderStatuses(),
    }, { status: 400 });
  }

  // NEW P2: Validate metadata conditions if provided
  if (triggerCondition?.metadataConditions) {
    const validOps: MetadataOperator[] = [
      "exists", "not_exists", "equals", "not_equals",
      "contains", "starts_with", "ends_with",
      ">", ">=", "<", "<="
    ];

    for (const mc of triggerCondition.metadataConditions) {
      if (!mc.fieldPath || !mc.operator) {
        return NextResponse.json({
          error: "Each metadataCondition must have fieldPath and operator",
        }, { status: 400 });
      }

      if (!validOps.includes(mc.operator as any)) {
        return NextResponse.json({
          error: `Invalid operator: ${mc.operator}. Valid: ${validOps.join(", ")}`,
        }, { status: 400 });
      }

      // Value is required for most operators
      if (
        ["equals", "not_equals", "contains", "starts_with", "ends_with", ">", ">=", "<", "<="]
          .includes(mc.operator)
        && mc.value === undefined
      ) {
        return NextResponse.json({
          error: `metadataCondition with operator '${mc.operator}' requires a value`,
        }, { status: 400 });
      }
    }
  }

  // Verify taskType exists
  const taskType = await prisma.taskType.findUnique({ where: { id: Number(taskTypeId) } });
  if (!taskType) return NextResponse.json({ error: "Task type not found" }, { status: 404 });

  const rule = await prisma.taskRule.create({
    data: {
      name: name.trim(),
      orderType,
      taskTypeId: Number(taskTypeId),
      titleTemplate: titleTemplate.trim(),
      slaMinutes: Number(slaMinutes),
      priority,
      triggerCondition,
      isActive: true,
      escalationChainId: escalationChainId ? Number(escalationChainId) : null,
      requiredSkills: skillTagIds?.length
        ? { create: (skillTagIds as number[]).map((id) => ({ skillTagId: id })) }
        : undefined,
    },
    include: {
      taskType: { select: { name: true, label: true } },
      requiredSkills: { include: { skillTag: { select: { id: true, name: true, label: true } } } },
      escalationChain: { select: { id: true, name: true } },
    },
  });

  // P4: Log rule creation
  await logRuleAudit({
    action: "CREATE",
    ruleId: rule.id,
    changedById: user.id,
    metadata: {
      ruleName: rule.name,
      orderType: rule.orderType,
      priority: rule.priority,
    },
  });

  return NextResponse.json({ rule }, { status: 201 });
}
