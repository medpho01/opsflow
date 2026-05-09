/**
 * POST /api/task-rules/{id}/clone
 *
 * Duplicates an existing rule. Operating teams typically need 6–10 rules
 * per source that are 80% identical (same source, same skills, same
 * assignment, different status/timing) — building each from scratch
 * is the single biggest authoring-time cost in this product.
 *
 * The clone:
 *   - keeps everything from the source rule (titleTemplate, allowedTypes,
 *     allowedStatuses, triggerCondition, slaMinutes, priority, escalation,
 *     skills, dataSource)
 *   - lands as `isActive: false` so the author reviews/tweaks before firing
 *   - gets a "Copy of <name>" prefix (or "<name> (N)" if a copy already
 *     exists, to avoid name collisions in the list view)
 *   - emits a `CREATE` audit row with metadata.clonedFrom = sourceRuleId
 *
 * Body:  { newName?: string }   — optional override for the new rule name
 * Response: 201 { rule: <full-rule-with-relations> }
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";
import { logRuleAudit } from "@/lib/engine/ruleAudit";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = newRequestId();
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized", requestId }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden", requestId }, { status: 403 });
  }

  const { id } = await params;
  if (id === "MANUAL") {
    return NextResponse.json({ error: "Cannot clone the MANUAL sentinel rule", requestId }, { status: 400 });
  }

  const source = await prisma.taskRule.findUnique({
    where: { id },
    include: {
      requiredSkills: { select: { skillTagId: true } },
    },
  });
  if (!source) return NextResponse.json({ error: "Rule not found", requestId }, { status: 404 });

  let newName: string | undefined;
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body?.newName === "string" && body.newName.trim()) {
      newName = body.newName.trim();
    }
  } catch { /* empty body is fine */ }

  // Pick a non-colliding name. "Copy of X", then "Copy of X (2)", etc.
  if (!newName) {
    const baseName = `Copy of ${source.name}`;
    let candidate = baseName;
    let n = 2;
    while (await prisma.taskRule.findFirst({ where: { name: candidate } })) {
      candidate = `${baseName} (${n})`;
      n++;
      if (n > 99) {
        return NextResponse.json(
          { error: "Too many copies of this rule already exist; pass `newName` explicitly", requestId },
          { status: 409 }
        );
      }
    }
    newName = candidate;
  } else {
    // Caller-supplied name still needs uniqueness
    const collision = await prisma.taskRule.findFirst({ where: { name: newName } });
    if (collision) {
      return NextResponse.json(
        { error: `A rule named "${newName}" already exists`, code: "NAME_CONFLICT", requestId },
        { status: 409 }
      );
    }
  }

  try {
    const cloned = await prisma.taskRule.create({
      data: {
        name: newName,
        dataSourceId: source.dataSourceId,
        // JSONB pass-through — the original was already validated when it
        // was saved, no need to re-zod-parse here.
        triggerCondition: source.triggerCondition as never,
        allowedTypes: source.allowedTypes as never,
        allowedStatuses: source.allowedStatuses as never,
        pollingIntervalMinutes: source.pollingIntervalMinutes,
        taskTypeId: source.taskTypeId,
        titleTemplate: source.titleTemplate,
        slaMinutes: source.slaMinutes,
        priority: source.priority,
        triggerType: source.triggerType,
        assignmentStrategy: source.assignmentStrategy,
        escalationChainId: source.escalationChainId,
        // Important: clones are inactive by default. Author reviews + flips.
        isActive: false,
        requiredSkills: source.requiredSkills.length
          ? { create: source.requiredSkills.map((s) => ({ skillTagId: s.skillTagId })) }
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
      ruleId: cloned.id,
      changedById: user.id,
      metadata: {
        ruleName: cloned.name,
        clonedFrom: source.id,
        clonedFromName: source.name,
      },
    });

    return NextResponse.json({ rule: cloned, clonedFrom: source.id, requestId }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "TaskRulesAPI.clone",
        code: "CLONE_ERROR",
        userMessage: "Failed to clone task rule",
        error,
      }),
      { status: 500 }
    );
  }
}
