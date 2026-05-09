/**
 * GET    /api/team/:id/stores             — list assigned store IDs
 * POST   /api/team/:id/stores             — add one store  { storeId }
 * PUT    /api/team/:id/stores             — bulk replace   { storeIds: number[] }
 *                                           Atomically replaces ALL assignments in one DB transaction.
 *                                           Pass an empty array to remove all stores.
 * DELETE /api/team/:id/stores             — remove one store { storeId }
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

// ── Shared helper ─────────────────────────────────────────────────────────────
async function resolveMember(userId: number) {
  return prisma.teamMember.findFirst({ where: { userId } });
}

// ── GET ───────────────────────────────────────────────────────────────────────
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const member = await prisma.teamMember.findFirst({
    where: { userId: parseInt(id, 10) },
    include: { storeAssignments: true },
  });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  return NextResponse.json({ storeIds: member.storeAssignments.map((a) => a.storeId) });
}

// ── POST — add a single store ─────────────────────────────────────────────────
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const { storeId } = await request.json();
  if (!storeId) return NextResponse.json({ error: "storeId required" }, { status: 400 });

  const member = await resolveMember(parseInt(id, 10));
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  const assignment = await prisma.storeAssignment.upsert({
    where: { teamMemberId_storeId: { teamMemberId: member.id, storeId: Number(storeId) } },
    create: { teamMemberId: member.id, storeId: Number(storeId) },
    update: {},
  });

  return NextResponse.json({ assignment }, { status: 201 });
}

// ── PUT — bulk replace all store assignments in one transaction ───────────────
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await request.json();

  if (!Array.isArray(body.storeIds)) {
    return NextResponse.json({ error: "storeIds must be an array" }, { status: 400 });
  }

  const storeIds: number[] = body.storeIds.map(Number).filter((n: number) => !isNaN(n));

  const member = await resolveMember(parseInt(id, 10));
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  // Single transaction: delete all existing → insert new set
  await prisma.$transaction([
    prisma.storeAssignment.deleteMany({ where: { teamMemberId: member.id } }),
    ...(storeIds.length > 0
      ? [prisma.storeAssignment.createMany({
          data: storeIds.map((storeId) => ({ teamMemberId: member.id, storeId })),
          skipDuplicates: true,
        })]
      : []),
  ]);

  return NextResponse.json({ assigned: storeIds.length });
}

// ── DELETE — remove a single store ───────────────────────────────────────────
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const { storeId } = await request.json();
  if (!storeId) return NextResponse.json({ error: "storeId required" }, { status: 400 });

  const member = await resolveMember(parseInt(id, 10));
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  await prisma.storeAssignment.deleteMany({
    where: { teamMemberId: member.id, storeId: Number(storeId) },
  });

  return NextResponse.json({ success: true });
}
