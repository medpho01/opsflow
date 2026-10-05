import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

// GET /api/whatsapp/groups — the linked number's groups for the Settings
// classification table. Archived groups (a previously linked number's) are
// excluded; groups the number has left come back with isMember=false.
export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT))
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const groups = await prisma.waGroup.findMany({ where: { archivedAt: null }, orderBy: { subject: "asc" } });
  return NextResponse.json({ groups });
}
