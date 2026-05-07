/**
 * PATCH  /api/task-rules/:id — update any field on a task rule
 * DELETE /api/task-rules/:id — delete a task rule (blocks if tasks exist)
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole, TaskPriority, OrderType } from "@prisma/client";
import { validateTriggerConditionStatuses, getValidOrderStatuses, MetadataOperator } from "@/types";
import { logRuleAudit } from "@/lib/engine/ruleAudit";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  if (id === "MANUAL") {
    return NextResponse.json({ error: "Cannot modify the MANUAL sentinel rule" }, { status: 400 });
  }

  const rule = await prisma.taskRule.findUnique({ where: { id } });
  if (!rule) return NextResponse.json({ error: "Rule not found" }, { status: 404 });

  const body = await request.json();
  const {
    isActive, slaMinutes, priority, name, titleTemplate,
    orderType, taskTypeId, triggerCondition, escalationChainId,
    skillTagIds,
  } = body;

  const updates: Record<string, unknown> = {};

  if (typeof isActive === "boolean") updates.isActive = isActive;

  if (name !== undefined) {
    if (!name.trim()) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    updates.name = name.trim();
  }

  if (titleTemplate !== undefined) {
    if (!titleTemplate.trim()) return NextResponse.json({ error: "titleTemplate cannot be empty" }, { status: 400 });
    updates.titleTemplate = titleTemplate.trim();
  }

  if (orderType !== undefined) {
    if (!Object.values(OrderType).includes(orderType)) {
      return NextResponse.json({ error: `Invalid orderType: ${orderType}` }, { status: 400 });
    }
    updates.orderType = orderType;
  }

  if (taskTypeId !== undefined) {
    const tt = await prisma.taskType.findUnique({ where: { id: Number(taskTypeId) } });
    if (!tt) return NextResponse.json({ error: "Task type not found" }, { status: 404 });
    updates.taskTypeId = Number(taskTypeId);
  }

  if (slaMinutes !== undefined) {
    const mins = parseInt(slaMinutes, 10);
    if (isNaN(mins) || mins < 1) {
      return NextResponse.json({ error: "slaMinutes must be a positive integer" }, { status: 400 });
    }
    updates.slaMinutes = mins;
  }

  if (priority !== undefined) {
    if (!Object.values(TaskPriority).includes(priority)) {
      return NextResponse.json({ error: `Invalid priority: ${priority}` }, { status: 400 });
    }
    updates.priority = priority;
  }

  if (triggerCondition !== undefined) {
    if (!triggerCondition.statusIn?.length) {
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

    updates.triggerCondition = triggerCondition;
  }

  // escalationChainId: null clears it, a number sets it
  if ("escalationChainId" in body) {
    updates.escalationChainId = escalationChainId ? Number(escalationChainId) : null;
  }

  // Skill tags — full replace when provided
  const hasSkillUpdate = Array.isArray(skillTagIds);

  if (Object.keys(updates).length === 0 && !hasSkillUpdate) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  // Run skill update + field update in a transaction
  const updated = await prisma.$transaction(async (tx) => {
    if (hasSkillUpdate) {
      await tx.taskRuleSkill.deleteMany({ where: { taskRuleId: id } });
      if (skillTagIds.length > 0) {
        await tx.taskRuleSkill.createMany({
          data: (skillTagIds as number[]).map((sid) => ({ taskRuleId: id, skillTagId: sid })),
        });
      }
    }

    if (Object.keys(updates).length > 0) {
      return tx.taskRule.update({
        where: { id },
        data: updates,
        include: {
          taskType: { select: { name: true, label: true } },
          requiredSkills: { include: { skillTag: { select: { id: true, name: true, label: true } } } },
          escalationChain: { select: { id: true, name: true } },
        },
      });
    }

    return tx.taskRule.findUnique({
      where: { id },
      include: {
        taskType: { select: { name: true, label: true } },
        requiredSkills: { include: { skillTag: { select: { id: true, name: true, label: true } } } },
        escalationChain: { select: { id: true, name: true } },
      },
    });
  });

  // P4: Log update with changes summary
  if (Object.keys(updates).length > 0 || hasSkillUpdate) {
    const changesSummary: Record<string, { before: any; after: any }> = {};

    // Track field changes
    if (updates.isActive !== undefined) {
      changesSummary.isActive = { before: rule.isActive, after: updates.isActive };
    }
    if (updates.name !== undefined) {
      changesSummary.name = { before: rule.name, after: updates.name };
    }
    if (updates.titleTemplate !== undefined) {
      changesSummary.titleTemplate = { before: rule.titleTemplate, after: updates.titleTemplate };
    }
    if (updates.slaMinutes !== undefined) {
      changesSummary.slaMinutes = { before: rule.slaMinutes, after: updates.slaMinutes };
    }
    if (updates.priority !== undefined) {
      changesSummary.priority = { before: rule.priority, after: updates.priority };
    }
    if (updates.orderType !== undefined) {
      changesSummary.orderType = { before: rule.orderType, after: updates.orderType };
    }
    if (updates.triggerCondition !== undefined) {
      changesSummary.triggerCondition = { before: rule.triggerCondition, after: updates.triggerCondition };
    }
    if (updates.escalationChainId !== undefined) {
      changesSummary.escalationChainId = { before: rule.escalationChainId, after: updates.escalationChainId };
    }

    await logRuleAudit({
      action: "UPDATE",
      ruleId: id,
      changedById: user.id,
      changesSummary: Object.keys(changesSummary).length > 0 ? changesSummary : undefined,
      metadata: { ruleName: updated?.name },
    });
  }

  return NextResponse.json({ rule: updated });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  if (id === "MANUAL") {
    return NextResponse.json({ error: "Cannot delete the MANUAL sentinel rule" }, { status: 400 });
  }

  const taskCount = await prisma.task.count({ where: { taskRuleId: id } });
  if (taskCount > 0) {
    return NextResponse.json(
      { error: `Cannot delete — ${taskCount} task(s) reference this rule. Deactivate it instead.` },
      { status: 409 }
    );
  }

  const rule = await prisma.taskRule.findUnique({ where: { id } });

  await prisma.taskRuleSkill.deleteMany({ where: { taskRuleId: id } });
  await prisma.taskRule.delete({ where: { id } });

  // P4: Log deletion
  await logRuleAudit({
    action: "DELETE",
    ruleId: id,
    changedById: user.id,
    metadata: { ruleName: rule?.name },
  });

  return NextResponse.json({ success: true });
}
