/**
 * GET /api/non-api-labs/:labId/batches — the lab's recent combined messages
 * (sent, or recorded only while the lab is in preview), newest first.
 */
import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";

export async function GET(request: NextRequest, { params }: { params: Promise<{ labId: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_ADMIN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  const labId = Number((await params).labId);
  if (!Number.isInteger(labId) || labId <= 0) return NextResponse.json({ error: "Invalid lab id" }, { status: 400 });
  const batches = await prisma.providerBatch.findMany({
    where: { labId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, intent: true, shadow: true, slotAt: true, itemCount: true, text: true, createdAt: true },
  });
  return NextResponse.json({ batches });
}
