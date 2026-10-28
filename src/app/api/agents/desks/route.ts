/**
 * GET /api/agents/desks — every lab and store with each desk's state and what shadow has shown.
 * PUT /api/agents/desks — { desk, scopeKind, scopeId, state, force? } (OPS_HEAD).
 *   Going LIVE needs 7 days in shadow unless force; LIVE arms the 14-day rollback gate.
 */
import { NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { agentsRoute, bad } from "@/lib/agents/api";
import { loadDirectory } from "@/lib/agents/directory";
import { runReadiness, STORE_INTENTS } from "@/lib/agents/store/readiness";

const DESKS_FOR = { LAB: ["LAB", "INTAKE"], STORE: ["STORE"] } as const;

export const GET = agentsRoute("desks", async (_request, { requestId }) => {
  const dir = await loadDirectory();
  const [rows, shadow, executed] = await Promise.all([
    prisma.agentDeskState.findMany(),
    prisma.agentAction.groupBy({ by: ["desk", "orderId"], where: { outcome: "RECORDED", createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, _count: { _all: true } }),
    prisma.agentAction.groupBy({ by: ["desk"], where: { outcome: "EXECUTED", createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, _count: { _all: true } }),
  ]);
  const stateOf = (desk: string, scopeKind: string, scopeId: number) => rows.find((r) => r.desk === desk && r.scopeKind === scopeKind && r.scopeId === scopeId);
  const journeys = await prisma.agentJourney.findMany({ where: { closedAt: null }, select: { orderId: true, labId: true, storeId: true } });
  const shadowByScope = (desk: string, scopeKind: string, scopeId: number) => shadow.filter((s) => s.desk === desk && journeys.some((j) => j.orderId === s.orderId && (scopeKind === "LAB" ? j.labId === scopeId : j.storeId === scopeId))).reduce((n, s) => n + s._count._all, 0);
  const labs = [...dir.labs.values()].sort((a, b) => a.labName.localeCompare(b.labName)).map((l) => ({
    scopeKind: "LAB", scopeId: l.labId, name: l.labName, tier: l.tier, group: !!l.groupJid,
    desks: DESKS_FOR.LAB.map((desk) => { const s = stateOf(desk, "LAB", l.labId); return { desk, state: s?.state ?? "OFF", since: s?.updatedAt ?? null, liveSince: s?.liveSince ?? null, shadowActions7d: shadowByScope(desk, "LAB", l.labId) }; }),
  }));
  const stores = [...dir.stores.values()].sort((a, b) => (a.storeName ?? "").localeCompare(b.storeName ?? "")).map((s) => ({
    scopeKind: "STORE", scopeId: s.storeId, name: s.storeName, tier: null, group: !!s.groupJid,
    desks: DESKS_FOR.STORE.map((desk) => { const r = stateOf(desk, "STORE", s.storeId); return { desk, state: r?.state ?? "OFF", since: r?.updatedAt ?? null, liveSince: r?.liveSince ?? null, shadowActions7d: shadowByScope(desk, "STORE", s.storeId), liveIntents: r?.liveIntents ?? [], readiness: r?.readiness ?? null, readinessAt: r?.readinessAt ?? null }; }),
  }));
  return NextResponse.json({ labs, stores, executed7d: Object.fromEntries(executed.map((e) => [e.desk, e._count._all])), requestId });
});

export const PUT = agentsRoute("desks", async (request, { user, requestId }) => {
  const body = await request.json().catch(() => ({})) as { desk?: string; scopeKind?: string; scopeId?: number; state?: string; force?: boolean; liveIntents?: string[] };
  if (!body.desk || !body.scopeKind || !Number.isInteger(body.scopeId)) return bad(requestId, "Expected { desk, scopeKind, scopeId, state | liveIntents }");
  const where = { desk_scopeKind_scopeId: { desk: body.desk, scopeKind: body.scopeKind, scopeId: body.scopeId! } };
  // The kinds of store question the desk answers itself; the rest are handed to a person in the group.
  if (Array.isArray(body.liveIntents)) {
    const liveIntents = body.liveIntents.filter((i): i is string => typeof i === "string" && (STORE_INTENTS as readonly string[]).includes(i));
    const row = await prisma.agentDeskState.upsert({ where, update: { liveIntents, setBy: user.id }, create: { desk: body.desk, scopeKind: body.scopeKind, scopeId: body.scopeId!, state: "OFF", liveIntents, setBy: user.id } });
    return NextResponse.json({ ok: true, row, requestId });
  }
  if (!["OFF", "SHADOW", "LIVE"].includes(body.state ?? "")) return bad(requestId, "Expected { desk, scopeKind, scopeId, state }");
  const current = await prisma.agentDeskState.findUnique({ where });
  if (body.state === "LIVE" && !body.force) {
    const shadowSince = current?.state === "SHADOW" ? current.updatedAt : null;
    if (!shadowSince || Date.now() - shadowSince.getTime() < 7 * 86_400_000) {
      return NextResponse.json({ error: "Going live needs 7 days in shadow for this lab or store. Pass force to override.", code: "GATE", requestId, shadowSince }, { status: 409 });
    }
  }
  const row = await prisma.agentDeskState.upsert({
    where, update: { state: body.state!, setBy: user.id, liveSince: body.state === "LIVE" ? current?.liveSince ?? new Date() : null },
    create: { desk: body.desk, scopeKind: body.scopeKind, scopeId: body.scopeId!, state: body.state!, setBy: user.id, liveSince: body.state === "LIVE" ? new Date() : null },
  });
  return NextResponse.json({ ok: true, row, requestId });
}, { headOnly: true });

/** POST { action: "evaluate", storeId } — grade a store's desk now (the last 3 days) instead of waiting for tonight. */
export const POST = agentsRoute("desks", async (request, { requestId }) => {
  const body = await request.json().catch(() => ({})) as { action?: string; storeId?: number };
  if (body.action !== "evaluate" || !Number.isInteger(body.storeId)) return bad(requestId, "Expected { action: \"evaluate\", storeId }");
  const r = await runReadiness(new Date(), { storeId: body.storeId, hours: 72 });
  return NextResponse.json({ ok: true, ...r, requestId });
}, { headOnly: true });
