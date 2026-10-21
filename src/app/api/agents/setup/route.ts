/**
 * GET  /api/agents/setup — the eight setup steps with their status (DESIGN.md §3).
 * POST /api/agents/setup — { action: "pilot_shadow" } puts the pilot's desks in shadow (OPS_HEAD).
 */
import { NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { labstackWorkerQuery } from "@/lib/db/labstack";
import { agentsRoute, bad } from "@/lib/agents/api";
import { loadDirectory, PILOT_LABS, PILOT_STORES } from "@/lib/agents/directory";
import { LAB_OFFSETS } from "@/lib/agents/journey/policy";
import { consoleClient } from "@/lib/agents/console/client";

export const GET = agentsRoute("setup", async (_request, { requestId }) => {
  const dir = await loadDirectory(true);
  const [replica, gateway, portals, sops, evals, desks, autonomy, settings] = await Promise.all([
    labstackWorkerQuery<{ ok: number }>("SELECT 1 AS ok").then(() => "OK").catch((e) => `ERROR: ${e instanceof Error ? e.message.slice(0, 80) : e}`),
    prisma.waGateway.findUnique({ where: { id: "default" } }),
    prisma.agentPortalSession.findMany(),
    prisma.agentSop.findMany({ include: { versions: { where: { status: "LIVE" }, select: { version: true, author: true, approvedBy: true } } } }),
    prisma.agentEvalRun.findMany({ orderBy: { ranAt: "desc" }, take: 20 }),
    prisma.agentDeskState.findMany(),
    prisma.agentAutonomy.count(),
    prisma.agentSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } }),
  ]);
  const pilotLabs = [...dir.labs.values()].filter((l) => PILOT_LABS.some((re) => re.test(l.labName)));
  const pilotStores = [...dir.stores.values()].filter((s) => PILOT_STORES.some((re) => re.test(s.storeName ?? "")));
  const groupsOk = pilotLabs.filter((l) => l.groupJid).length;
  const latestEval = new Map<string, (typeof evals)[number]>();
  for (const e of evals) if (!latestEval.has(e.suite)) latestEval.set(e.suite, e);
  const shadowCells = desks.filter((d) => d.state !== "OFF").length;
  const anyLive = desks.some((d) => d.state === "LIVE");
  const steps = [
    { n: 1, key: "connections", name: "Connections", status: replica === "OK" && gateway?.status === "CONNECTED" ? "done" : "in_progress", detail: { replica, gateway: gateway?.status ?? "NOT_CONFIGURED", gatewayNumber: gateway?.connectedNumber ?? null, consoleApi: consoleClient() ? "configured" : "not yet — status writes become tasks", portals: portals.map((p) => ({ labId: p.labId, status: p.status, lastOkAt: p.lastOkAt })), modelKey: !!process.env.ANTHROPIC_API_KEY, exotel: !!process.env.EXOTEL_API_KEY || !!process.env.EXOTEL_SID } },
    { n: 2, key: "directory", name: "Directory", status: pilotLabs.length >= 5 && pilotStores.length >= 2 && groupsOk === pilotLabs.length ? "done" : "in_progress", detail: { labs: pilotLabs.map((l) => ({ labId: l.labId, labName: l.labName, tier: l.tier, group: !!l.groupJid, manager: !!l.managerWhatsapp })), stores: pilotStores.map((s) => ({ storeId: s.storeId, storeName: s.storeName, group: !!s.groupJid, weight: s.weight })) } },
    { n: 3, key: "sla", name: "SLA timings", status: "done", detail: { offsets: Object.entries(LAB_OFFSETS).map(([labId, o]) => ({ labId: Number(labId), labName: dir.labs.get(Number(labId))?.labName ?? labId, ...o })), note: "Defaults per order type; the Brain proposes per-lab timings from history at each review." } },
    { n: 4, key: "sops", name: "Baseline SOPs", status: sops.length >= 3 && sops.every((s) => s.versions.length) ? (sops.every((s) => s.versions[0]?.approvedBy != null) ? "done" : "needs_approval") : "in_progress", detail: { sops: sops.map((s) => ({ desk: s.desk, version: s.versions[0]?.version ?? null, author: s.versions[0]?.author ?? null, approvedBy: s.versions[0]?.approvedBy ?? null })) } },
    { n: 5, key: "evals", name: "Accuracy tests", status: latestEval.size === 0 ? "not_started" : [...latestEval.values()].every((e) => e.passedGate) ? "done" : "failing", detail: { suites: [...latestEval.values()].map((e) => ({ suite: e.suite, cases: e.cases, score: e.score, gate: e.gate, passed: e.passedGate, ranAt: e.ranAt })) } },
    { n: 6, key: "shadow", name: "Pilot in shadow", status: shadowCells >= pilotLabs.length + pilotStores.length ? "done" : shadowCells > 0 ? "in_progress" : "not_started", detail: { cells: shadowCells, needed: pilotLabs.length * 2 + pilotStores.length } },
    { n: 7, key: "autonomy", name: "Autonomy", status: autonomy > 0 ? "done" : "defaults", detail: { rows: autonomy, note: "Defaults apply until a row is set: asks act; store answers act and notify; status writes, warnings and case choices suggest." } },
    { n: 8, key: "live", name: "Go live", status: anyLive ? "in_progress" : "locked", detail: { live: desks.filter((d) => d.state === "LIVE").map((d) => ({ desk: d.desk, scopeKind: d.scopeKind, scopeId: d.scopeId, liveSince: d.liveSince })), pausedAll: settings.pausedAll } },
  ];
  return NextResponse.json({ steps, pilot: { labs: pilotLabs.map((l) => l.labName), stores: pilotStores.map((s) => s.storeName) }, requestId });
});

export const POST = agentsRoute("setup", async (request, { user, requestId }) => {
  const body = await request.json().catch(() => ({})) as { action?: string };
  if (body.action !== "pilot_shadow") return bad(requestId, "action must be pilot_shadow");
  const dir = await loadDirectory(true);
  let cells = 0;
  for (const l of [...dir.labs.values()].filter((l) => PILOT_LABS.some((re) => re.test(l.labName)))) {
    for (const desk of ["LAB", "INTAKE"]) {
      const where = { desk_scopeKind_scopeId: { desk, scopeKind: "LAB", scopeId: l.labId } };
      const cur = await prisma.agentDeskState.findUnique({ where });
      if (cur?.state === "LIVE") continue;
      await prisma.agentDeskState.upsert({ where, update: { state: "SHADOW", setBy: user.id }, create: { desk, scopeKind: "LAB", scopeId: l.labId, state: "SHADOW", setBy: user.id } });
      cells += 1;
    }
  }
  for (const s of [...dir.stores.values()].filter((s) => PILOT_STORES.some((re) => re.test(s.storeName ?? "")))) {
    const where = { desk_scopeKind_scopeId: { desk: "STORE", scopeKind: "STORE", scopeId: s.storeId } };
    const cur = await prisma.agentDeskState.findUnique({ where });
    if (cur?.state === "LIVE") continue;
    await prisma.agentDeskState.upsert({ where, update: { state: "SHADOW", setBy: user.id }, create: { desk: "STORE", scopeKind: "STORE", scopeId: s.storeId, state: "SHADOW", setBy: user.id } });
    cells += 1;
  }
  return NextResponse.json({ ok: true, cells, requestId });
}, { headOnly: true });
