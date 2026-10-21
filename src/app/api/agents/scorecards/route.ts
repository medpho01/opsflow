/** GET /api/agents/scorecards?days=7 — per desk, lab and store (FR-13.4): autonomy, on-time, promises kept, overrides, repeat asks, cost. */
import { NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { agentsRoute } from "@/lib/agents/api";
import { loadDirectory } from "@/lib/agents/directory";
import { computeMetrics } from "@/lib/agents/brain/nightly";

export const GET = agentsRoute("scorecards", async (request, { requestId }) => {
  const days = Math.min(30, Math.max(1, Number(request.nextUrl.searchParams.get("days") ?? 7)));
  const since = new Date(Date.now() - days * 86_400_000);
  const dir = await loadDirectory();
  const [journeys, promises, reviews, actions, cost] = await Promise.all([
    prisma.agentJourney.findMany({ where: { openedAt: { gte: since } }, select: { orderId: true, labId: true, storeId: true, attempts: true, checkpoints: { select: { name: true, status: true, dueAt: true, metAt: true } } } }),
    prisma.agentPromise.groupBy({ by: ["labId", "status"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.agentReviewItem.findMany({ where: { decidedAt: { gte: since } }, select: { labId: true, storeId: true, desk: true, decision: true } }),
    prisma.agentAction.groupBy({ by: ["desk", "outcome"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.agentAction.groupBy({ by: ["journeyId"], where: { createdAt: { gte: since }, costPaise: { not: null } }, _sum: { costPaise: true } }),
  ]);
  const costByJourney = new Map(cost.map((c) => [c.journeyId, c._sum.costPaise ?? 0]));
  const byLab = new Map<number, typeof journeys>();
  for (const j of journeys) if (j.labId != null) byLab.set(j.labId, [...(byLab.get(j.labId) ?? []), j]);
  const pct = (n: number, d: number) => (d ? n / d : null);
  const onTime = (list: typeof journeys, name: string, graceMin = 0) => {
    const cps = list.map((j) => j.checkpoints.find((c) => c.name === name)).filter((c): c is NonNullable<typeof c> => !!c && (c.status === "MET" || c.status === "BREACHED"));
    return pct(cps.filter((c) => c.status === "MET" && c.metAt && c.metAt.getTime() <= c.dueAt.getTime() + graceMin * 60_000).length, cps.length);
  };
  const labs = [...byLab].map(([labId, list]) => {
    const kept = promises.filter((p) => p.labId === labId && p.status === "KEPT").reduce((n, p) => n + p._count._all, 0);
    const broken = promises.filter((p) => p.labId === labId && p.status === "BROKEN").reduce((n, p) => n + p._count._all, 0);
    const rev = reviews.filter((r) => r.labId === labId && r.desk !== "STORE");
    return {
      labId, labName: dir.labs.get(labId)?.labName ?? String(labId), tier: dir.labs.get(labId)?.tier ?? "C", orders: list.length,
      onTimeCollection: onTime(list, "sample_collected"), onTimeReports: onTime(list, "report_delivered", 240),
      promisesKept: pct(kept, kept + broken), overrideRate: pct(rev.filter((r) => r.decision !== "APPROVED").length, rev.length),
      repeatAsks: list.reduce((n, j) => n + Object.values((j.attempts ?? {}) as Record<string, { n?: number }>).filter((a) => (a?.n ?? 0) > 5).length, 0),
      costPaisePerOrder: list.length ? Math.round([...costByJourney.values()].reduce((a, b) => a + b, 0) / Math.max(1, journeys.length)) : null,
    };
  }).sort((a, b) => b.orders - a.orders);
  const byStore = new Map<number, typeof journeys>();
  for (const j of journeys) if (j.storeId != null) byStore.set(j.storeId, [...(byStore.get(j.storeId) ?? []), j]);
  const stores = [...byStore].map(([storeId, list]) => {
    const rev = reviews.filter((r) => r.storeId === storeId && r.desk === "STORE");
    return { storeId, storeName: dir.stores.get(storeId)?.storeName ?? String(storeId), orders: list.length, onTimeCollection: onTime(list, "sample_collected"), overrideRate: pct(rev.filter((r) => r.decision !== "APPROVED").length, rev.length) };
  }).sort((a, b) => b.orders - a.orders);
  const desks = ["LAB", "STORE", "INTAKE"].map((desk) => ({ desk, executed: actions.find((a) => a.desk === desk && a.outcome === "EXECUTED")?._count._all ?? 0, recorded: actions.find((a) => a.desk === desk && a.outcome === "RECORDED")?._count._all ?? 0, review: actions.find((a) => a.desk === desk && a.outcome === "REVIEW")?._count._all ?? 0, blocked: actions.find((a) => a.desk === desk && a.outcome === "BLOCKED")?._count._all ?? 0 }));
  const yesterday = await computeMetrics(new Date(Date.now() - 86_400_000)).catch(() => null);
  return NextResponse.json({ days, labs, stores, desks, yesterday, requestId });
});
