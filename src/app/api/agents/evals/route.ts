/**
 * GET  /api/agents/evals — the latest run per suite and case counts.
 * POST /api/agents/evals — { action: "run" | "seed" } (OPS_HEAD).
 */
import { NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { agentsRoute, bad } from "@/lib/agents/api";
import { GATES, runAllSuites, seedFromHistory } from "@/lib/agents/evals/run";

export const GET = agentsRoute("evals", async (_request, { requestId }) => {
  const [runs, counts] = await Promise.all([
    prisma.agentEvalRun.findMany({ orderBy: { ranAt: "desc" }, take: 40 }),
    prisma.agentEvalCase.groupBy({ by: ["suite"], _count: { _all: true } }),
  ]);
  const latest = Object.keys(GATES).map((suite) => ({ suite, gate: GATES[suite], cases: counts.find((c) => c.suite === suite)?._count._all ?? 0, last: runs.find((r) => r.suite === suite) ?? null }));
  return NextResponse.json({ suites: latest, requestId });
});

export const POST = agentsRoute("evals", async (request, { requestId }) => {
  const body = await request.json().catch(() => ({})) as { action?: string };
  if (body.action === "seed") return NextResponse.json({ ok: true, seeded: await seedFromHistory(), requestId });
  if (body.action === "run") return NextResponse.json({ ok: true, results: await runAllSuites(), requestId });
  return bad(requestId, "action must be run or seed");
}, { headOnly: true });
