/**
 * GET /api/task-types — list all task types (for manual task creation UI)
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const types = await prisma.taskType.findMany({
    orderBy: { label: "asc" },
    select: { id: true, name: true, label: true, description: true },
  });

  return NextResponse.json({ types });
}
