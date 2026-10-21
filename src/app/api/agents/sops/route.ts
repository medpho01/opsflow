/** GET /api/agents/sops — every desk's SOP: live version, version count, pending proposals (FR-13.3). */
import { NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { agentsRoute } from "@/lib/agents/api";
import { ensureBaselineSops } from "@/lib/agents/sop/baseline";

export const GET = agentsRoute("sops", async (_request, { requestId }) => {
  await ensureBaselineSops();
  const sops = await prisma.agentSop.findMany({ include: { versions: { orderBy: { version: "desc" }, select: { id: true, version: true, status: true, author: true, summary: true, approvedAt: true, createdAt: true } }, proposals: { where: { decision: null }, select: { id: true, rationale: true, inBounds: true, createdAt: true } } } });
  return NextResponse.json({
    sops: sops.map((s) => ({ desk: s.desk, currentVersionId: s.currentVersionId, live: s.versions.find((v) => v.id === s.currentVersionId) ?? null, versions: s.versions, pending: s.proposals })),
    requestId,
  });
});
