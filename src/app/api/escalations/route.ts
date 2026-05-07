/**
 * GET  /api/escalations — list all escalation chains with levels
 * POST /api/escalations — create a new chain
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const chains = await prisma.escalationChain.findMany({
    include: {
      levels: {
        include: { notifyUser: { select: { id: true, name: true, role: true } } },
        orderBy: { levelNumber: "asc" },
      },
      _count: { select: { rules: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ chains });
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { name } = await request.json();
  if (!name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });

  const existing = await prisma.escalationChain.findUnique({ where: { name: name.trim() } });
  if (existing) return NextResponse.json({ error: "Chain name already exists" }, { status: 409 });

  const chain = await prisma.escalationChain.create({
    data: { name: name.trim() },
    include: { levels: true, _count: { select: { rules: true } } },
  });

  return NextResponse.json({ chain }, { status: 201 });
}
