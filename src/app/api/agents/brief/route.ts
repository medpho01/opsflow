/** GET /api/agents/brief — the Brain's latest brief, metrics, monitor findings and what waits for the SOP owners (FR-15.1). */
import { NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { agentsRoute } from "@/lib/agents/api";
import { computeMetrics, renderBrief } from "@/lib/agents/brain/nightly";
import { monitorFindings } from "@/lib/agents/brain/monitor";

export const GET = agentsRoute("brief", async (request, { requestId }) => {
  const live = request.nextUrl.searchParams.get("live") === "1";
  const [nightly, monitor, proposals, promotions, review] = await Promise.all([
    prisma.agentBrainRun.findFirst({ where: { kind: "nightly", finishedAt: { not: null } }, orderBy: { startedAt: "desc" } }),
    prisma.agentBrainRun.findFirst({ where: { kind: "monitor", finishedAt: { not: null } }, orderBy: { startedAt: "desc" } }),
    prisma.agentSopProposal.findMany({ where: { decision: null }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, sopId: true, rationale: true, inBounds: true, replay: true, createdAt: true, sop: { select: { desk: true } } } }),
    prisma.agentAutonomy.findMany({ where: { agreementRate: { gte: 0.98 }, sampleSize: { gte: 200 }, level: { not: "ACT" } } }),
    prisma.agentReviewItem.count({ where: { decision: null } }),
  ]);
  let metrics = (nightly?.inputs as object | null) ?? null;
  let brief = nightly?.brief ?? null;
  if (live || !metrics) {
    try { const m = await computeMetrics(new Date(Date.now() - 86_400_000)); metrics = m; brief = renderBrief(m, new Date()); } catch { /* keep what we have */ }
  }
  const findings = live ? await monitorFindings().catch(() => []) : ((monitor?.findings as unknown[]) ?? []);
  return NextResponse.json({ brief, metrics, briefAt: nightly?.finishedAt ?? null, findings, findingsAt: monitor?.finishedAt ?? null, waiting: { proposals, promotions, review }, requestId });
});
