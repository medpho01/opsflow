/**
 * GET  /api/task-rules  — list all task rules with stats
 * POST /api/task-rules  — create a new task rule
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole, TaskPriority } from "@prisma/client";
import { MetadataOperator } from "@/types";
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
    allowedTypes: r.allowedTypes as string[],
    allowedStatuses: r.allowedStatuses as string[],
    pollingIntervalMinutes: r.pollingIntervalMinutes,
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
    name, dataSourceId, allowedTypes, allowedStatuses, pollingIntervalMinutes,
    taskTypeId, titleTemplate, slaMinutes, priority, triggerCondition,
    escalationChainId, skillTagIds,
  } = body;

  // Validate required fields
  if (!name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!dataSourceId) return NextResponse.json({ error: "dataSourceId is required" }, { status: 400 });
  if (!titleTemplate?.trim()) return NextResponse.json({ error: "titleTemplate is required" }, { status: 400 });
  if (!slaMinutes || Number(slaMinutes) < 1) {
    return NextResponse.json({ error: "slaMinutes must be a positive integer" }, { status: 400 });
  }
  if (!priority || !Object.values(TaskPriority).includes(priority)) {
    return NextResponse.json({ error: "valid priority is required" }, { status: 400 });
  }
  if (!triggerCondition?.statusIn?.length) {
    return NextResponse.json({ error: "triggerCondition.statusIn must have at least one status" }, { status: 400 });
  }

  // Validate metadata conditions if provided
  if (triggerCondition?.metadataConditions) {
    const validOps: MetadataOperator[] = [
      "exists", "not_exists", "equals", "not_equals",
      "contains", "starts_with", "ends_with",
      ">", ">=", "<", "<="
    ];
    for (const mc of triggerCondition.metadataConditions) {
      if (!mc.fieldPath || !mc.operator) {
        return NextResponse.json({ error: "Each metadataCondition must have fieldPath and operator" }, { status: 400 });
      }
      if (!validOps.includes(mc.operator as MetadataOperator)) {
        return NextResponse.json({ error: `Invalid operator: ${mc.operator}` }, { status: 400 });
      }
      if (["equals", "not_equals", "contains", "starts_with", "ends_with", ">", ">=", "<", "<="].includes(mc.operator) && mc.value === undefined) {
        return NextResponse.json({ error: `metadataCondition '${mc.operator}' requires a value` }, { status: 400 });
      }
    }
  }

  // Validate data source exists
  const dataSource = await prisma.dataSource.findUnique({ where: { id: dataSourceId } });
  if (!dataSource) return NextResponse.json({ error: "Data source not found" }, { status: 404 });

  // Resolve task type — use provided id if supplied, otherwise auto-default to first available
  let resolvedTaskTypeId: number;
  if (taskTypeId) {
    const taskType = await prisma.taskType.findUnique({ where: { id: Number(taskTypeId) } });
    if (!taskType) return NextResponse.json({ error: "Task type not found" }, { status: 404 });
    resolvedTaskTypeId = taskType.id;
  } else {
    const defaultType = await prisma.taskType.findFirst({ orderBy: { id: "asc" } });
    if (!defaultType) return NextResponse.json({ error: "No task types configured" }, { status: 500 });
    resolvedTaskTypeId = defaultType.id;
  }

  const rule = await prisma.taskRule.create({
    data: {
      name: name.trim(),
      dataSourceId,
      allowedTypes: (allowedTypes as string[] | undefined) ?? [],
      allowedStatuses: (allowedStatuses as string[] | undefined) ?? [],
      pollingIntervalMinutes: pollingIntervalMinutes ? Number(pollingIntervalMinutes) : 15,
      taskTypeId: resolvedTaskTypeId,
      titleTemplate: titleTemplate.trim(),
      slaMinutes: Number(slaMinutes),
      priority,
      triggerCondition,
      isActive: true,
      escalationChainId: escalationChainId ? Number(escalationChainId) : null,
      requiredSkills: skillTagIds?.length
        ? { create: (skillTagIds as number[]).map((id: number) => ({ skillTagId: id })) }
        : undefined,
    },
    include: {
      taskType: { select: { name: true, label: true } },
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
      allowedTypes,
      allowedStatuses,
    },
  });

  return NextResponse.json({ rule }, { status: 201 });
}
