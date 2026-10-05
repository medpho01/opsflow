/**
 * GET  /api/message-rules — every message rule with what it has done, plus
 *                           the engine mode and the pickers the editor needs.
 * POST /api/message-rules — create a rule.
 *
 * Ops Head only: these decide what real labs are sent.
 */
import { NextRequest, NextResponse } from "next/server";
import { Prisma, UserRole } from "@prisma/client";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";
import { ensureMigratedToRules } from "@/lib/provider-rules/migrate";
import { BUILT_IN_RULES } from "@/lib/provider-rules/builtins";
import { messageRuleSchema, flattenZodError } from "@/lib/provider-rules/validation";
import { ensureNonApiTemplates } from "@/lib/non-api-labs/templates";

async function requireOpsHead(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  return user && user.role === UserRole.OPS_HEAD ? user : null;
}

export async function GET(request: NextRequest) {
  const requestId = newRequestId();
  try {
    if (!(await requireOpsHead(request))) return NextResponse.json({ error: "Unauthorized", requestId }, { status: 403 });
    await ensureMigratedToRules();
    await ensureNonApiTemplates().catch(() => undefined);

    const [rules, stats, templates, labs] = await Promise.all([
      prisma.providerMessageRule.findMany({ orderBy: [{ builtInKey: "asc" }, { createdAt: "asc" }] }),
      prisma.providerMessageLedger.groupBy({ by: ["ruleId", "outcome", "shadow"], _count: { _all: true } }),
      prisma.labCommunicationTemplate.findMany({ select: { key: true, name: true, isActive: true }, orderBy: { name: "asc" } }),
      prisma.nonApiLabConfig.findMany({ select: { labId: true, labName: true }, orderBy: { labName: "asc" } }),
    ]);

    const counts = new Map<string, Record<string, number>>();
    for (const row of stats) {
      if (row.shadow) continue;
      const key = row.outcome.toLowerCase();
      const entry = counts.get(row.ruleId) ?? {};
      entry[key] = (entry[key] ?? 0) + row._count._all;
      counts.set(row.ruleId, entry);
    }
    // Built-ins in the order they happen to an order, then authored rules oldest first.
    const builtInOrder = new Map(BUILT_IN_RULES.map((rule, index) => [rule.builtInKey, index]));
    const ordered = [...rules].sort((a, b) =>
      (builtInOrder.get(a.builtInKey ?? "") ?? 99) - (builtInOrder.get(b.builtInKey ?? "") ?? 99)
      || a.createdAt.getTime() - b.createdAt.getTime());
    return NextResponse.json({
      rules: ordered.map((rule) => ({ ...rule, stats: counts.get(rule.id) ?? {} })),
      templates,
      labs,
    });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "MessageRulesAPI.GET", code: "FETCH_ERROR", userMessage: "Failed to load message rules", error }), { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const requestId = newRequestId();
  try {
    if (!(await requireOpsHead(request))) return NextResponse.json({ error: "Unauthorized", requestId }, { status: 403 });
    const parsed = messageRuleSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid rule", code: "VALIDATION_ERROR", details: flattenZodError(parsed.error), requestId }, { status: 400 });
    }
    const rule = await prisma.providerMessageRule.create({
      data: { ...parsed.data, triggerCondition: parsed.data.triggerCondition as Prisma.InputJsonValue },
    });
    return NextResponse.json({ rule }, { status: 201 });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "MessageRulesAPI.POST", code: "CREATE_ERROR", userMessage: "Failed to create the rule", error }), { status: 500 });
  }
}
