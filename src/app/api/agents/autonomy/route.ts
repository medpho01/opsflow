/**
 * GET  /api/agents/autonomy — the matrix: action × scope with level, agreement and sample.
 * POST /api/agents/autonomy — { action, desk, scopeKind, scopeKey, direction: "promote" | "demote", force? } (OPS_HEAD).
 *   Promote only at ≥98% over ≥200 cases unless force (FR-13.2). Demote always.
 */
import { NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { agentsRoute, bad } from "@/lib/agents/api";
import { DEFAULT_LEVELS } from "@/lib/agents/guard/guard";
import { canPromote, nextLevel, prevLevel, PROMOTE_MIN_CASES, PROMOTE_MIN_RATE } from "@/lib/agents/autonomy";

const ACTIONS: Array<{ action: string; desk: string; label: string }> = [
  { action: "ask", desk: "LAB", label: "Lab ask (batched, templated)" },
  { action: "reminder", desk: "LAB", label: "Lab reminder with @mention" },
  { action: "manager_whatsapp", desk: "LAB", label: "WhatsApp to the lab manager" },
  { action: "call", desk: "LAB", label: "Call the lab manager" },
  { action: "status_write", desk: "LAB", label: "Status write to the console" },
  { action: "create_task", desk: "LAB", label: "Task for a person" },
  { action: "store_reply", desk: "STORE", label: "Store answer from console data" },
  { action: "ack", desk: "STORE", label: "Store 'noted' on a change request" },
  { action: "store_alert", desk: "STORE", label: "Store alert: patient unreachable" },
  { action: "store_warning", desk: "STORE", label: "Store at-risk warning" },
  { action: "create_task", desk: "STORE", label: "Task from a store request" },
  { action: "create_task", desk: "INTAKE", label: "Intake task (placeholder lab, placement error)" },
];

export const GET = agentsRoute("autonomy", async (_request, { requestId }) => {
  const rows = await prisma.agentAutonomy.findMany({ orderBy: [{ desk: "asc" }, { action: "asc" }, { scopeKind: "asc" }] });
  const matrix = ACTIONS.map((a) => {
    const scoped = rows.filter((r) => r.action === a.action && r.desk === a.desk);
    const all = scoped.find((r) => r.scopeKind === "ALL");
    return {
      ...a, defaultLevel: all?.level ?? DEFAULT_LEVELS[a.action as keyof typeof DEFAULT_LEVELS] ?? "SHADOW",
      scopes: ["A", "B", "C"].map((tier) => { const r = scoped.find((x) => x.scopeKind === "TIER" && x.scopeKey === tier); return { scopeKind: "TIER", scopeKey: tier, level: r?.level ?? all?.level ?? DEFAULT_LEVELS[a.action as keyof typeof DEFAULT_LEVELS] ?? "SHADOW", agreementRate: r?.agreementRate ?? null, sampleSize: r?.sampleSize ?? 0, canPromote: r ? canPromote(r) : false, promotedAt: r?.promotedAt ?? null }; }),
      overrides: scoped.filter((r) => r.scopeKind === "LAB" || r.scopeKind === "STORE").map((r) => ({ scopeKind: r.scopeKind, scopeKey: r.scopeKey, level: r.level, agreementRate: r.agreementRate, sampleSize: r.sampleSize, canPromote: canPromote(r) })),
    };
  });
  return NextResponse.json({ matrix, gate: { rate: PROMOTE_MIN_RATE, cases: PROMOTE_MIN_CASES }, requestId });
});

export const POST = agentsRoute("autonomy", async (request, { user, requestId }) => {
  const body = await request.json().catch(() => ({})) as { action?: string; desk?: string; scopeKind?: string; scopeKey?: string; direction?: string; force?: boolean };
  if (!body.action || !body.desk || !body.scopeKind || !body.scopeKey || !["promote", "demote"].includes(body.direction ?? "")) return bad(requestId, "Expected { action, desk, scopeKind, scopeKey, direction }");
  const where = { action_desk_scopeKind_scopeKey: { action: body.action, desk: body.desk, scopeKind: body.scopeKind, scopeKey: body.scopeKey } };
  const row = await prisma.agentAutonomy.findUnique({ where });
  const current = row?.level ?? DEFAULT_LEVELS[body.action as keyof typeof DEFAULT_LEVELS] ?? "SHADOW";
  if (body.direction === "promote" && !body.force && !(row && canPromote(row))) {
    return NextResponse.json({ error: `Promotion needs ${Math.round(PROMOTE_MIN_RATE * 100)}% agreement over ${PROMOTE_MIN_CASES} cases (now ${row ? `${Math.round((row.agreementRate ?? 0) * 100)}% over ${row.sampleSize}` : "no data"}). Pass force to override.`, code: "GATE", requestId }, { status: 409 });
  }
  const level = body.direction === "promote" ? nextLevel(current) : prevLevel(current);
  const saved = await prisma.agentAutonomy.upsert({ where, update: { level, setBy: user.id, promotedAt: body.direction === "promote" ? new Date() : row?.promotedAt ?? null }, create: { ...where.action_desk_scopeKind_scopeKey, level, setBy: user.id, promotedAt: body.direction === "promote" ? new Date() : null } });
  return NextResponse.json({ ok: true, row: saved, requestId });
}, { headOnly: true });
