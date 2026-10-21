/**
 * GET  /api/agents/sops/[desk] — the SOP as a document: live body, every version, pending proposals with replay.
 * POST /api/agents/sops/[desk] — OPS_HEAD:
 *   { action: "approve" | "reject", proposalId, note? }  — a Brain proposal (FR-4.7, FR-13.3)
 *   { action: "rollback", versionId }                     — one-click rollback (FR-5.3)
 *   { action: "edit", body, summary }                     — a person's own change (validated)
 */
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/db/client";
import { agentsRoute, bad } from "@/lib/agents/api";
import { parseSop, changedPaths } from "@/lib/agents/sop/schema";
import { invalidateSopCache } from "@/lib/agents/sop/load";

export const GET = agentsRoute("sop", async (_request, { requestId, params }) => {
  const sop = await prisma.agentSop.findUnique({ where: { desk: params.desk.toUpperCase() }, include: { versions: { orderBy: { version: "desc" } }, proposals: { orderBy: { createdAt: "desc" }, take: 30 } } });
  if (!sop) return bad(requestId, "No SOP for this desk", 404);
  const live = sop.versions.find((v) => v.id === sop.currentVersionId) ?? null;
  return NextResponse.json({ desk: sop.desk, live, versions: sop.versions.map((v) => ({ ...v, changedFromPrevious: (() => { const prev = sop.versions.find((p) => p.version === v.version - 1); return prev ? changedPaths(prev.body, v.body) : []; })() })), proposals: sop.proposals, requestId });
});

async function publish(sopId: string, body: unknown, author: string, summary: string, approvedBy: number | null) {
  const parsed = parseSop(body);
  const last = await prisma.agentSopVersion.findFirst({ where: { sopId }, orderBy: { version: "desc" }, select: { version: true } });
  const version = await prisma.agentSopVersion.create({ data: { sopId, version: (last?.version ?? 0) + 1, body: parsed as object, author, summary, status: "LIVE", approvedBy, approvedAt: new Date() } });
  await prisma.agentSopVersion.updateMany({ where: { sopId, status: "LIVE", id: { not: version.id } }, data: { status: "RETIRED" } });
  await prisma.agentSop.update({ where: { id: sopId }, data: { currentVersionId: version.id } });
  invalidateSopCache();
  return version;
}

export const POST = agentsRoute("sop", async (request, { user, requestId, params }) => {
  const sop = await prisma.agentSop.findUnique({ where: { desk: params.desk.toUpperCase() } });
  if (!sop) return bad(requestId, "No SOP for this desk", 404);
  const body = await request.json().catch(() => ({})) as { action?: string; proposalId?: string; versionId?: string; body?: unknown; summary?: string; note?: string };
  if (body.action === "approve" || body.action === "reject") {
    const proposal = body.proposalId ? await prisma.agentSopProposal.findUnique({ where: { id: body.proposalId } }) : null;
    if (!proposal || proposal.sopId !== sop.id) return bad(requestId, "Proposal not found", 404);
    if (proposal.decision) return bad(requestId, `Already ${proposal.decision.toLowerCase()}`, 409);
    if (body.action === "reject") {
      await prisma.agentSopProposal.update({ where: { id: proposal.id }, data: { decision: "REJECTED", decidedBy: user.id, decidedAt: new Date(), evidence: { ...(proposal.evidence as object), rejectNote: body.note ?? null } as Prisma.InputJsonValue } });
      return NextResponse.json({ ok: true, decision: "REJECTED", requestId });
    }
    const version = await publish(sop.id, proposal.body, "BRAIN", proposal.rationale, user.id);
    await prisma.agentSopProposal.update({ where: { id: proposal.id }, data: { decision: "APPROVED", decidedBy: user.id, decidedAt: new Date(), appliedVersionId: version.id } });
    return NextResponse.json({ ok: true, decision: "APPROVED", version: version.version, requestId });
  }
  if (body.action === "rollback") {
    const target = body.versionId ? await prisma.agentSopVersion.findUnique({ where: { id: body.versionId } }) : null;
    if (!target || target.sopId !== sop.id) return bad(requestId, "Version not found", 404);
    const version = await publish(sop.id, target.body, `USER:${user.id}`, `Rollback to v${target.version}`, user.id);
    return NextResponse.json({ ok: true, version: version.version, requestId });
  }
  if (body.action === "edit") {
    try {
      const version = await publish(sop.id, body.body, `USER:${user.id}`, body.summary ?? `Edited by ${user.name}`, user.id);
      return NextResponse.json({ ok: true, version: version.version, requestId });
    } catch (error) {
      return bad(requestId, `The SOP does not validate: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
    }
  }
  return bad(requestId, "action must be approve, reject, rollback or edit");
}, { headOnly: true });
