import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

// GET /api/whatsapp/groups — all groups for the Settings classification table
export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const groups = await prisma.waGroup.findMany({ orderBy: { subject: "asc" } });
  return NextResponse.json({ groups });
}
