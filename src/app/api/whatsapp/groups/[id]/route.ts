import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole, WaGroupRole } from "@prisma/client";

// PATCH /api/whatsapp/groups/:id — classify a group (role, mapping, toggles)
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const data: Record<string, unknown> = {};
  if (body.role !== undefined) {
    if (!Object.values(WaGroupRole).includes(body.role))
      return NextResponse.json({ error: "invalid role" }, { status: 400 });
    data.role = body.role;
  }
  if (body.storeId !== undefined) data.storeId = body.storeId === null ? null : Number(body.storeId);
  if (body.labId !== undefined) data.labId = body.labId === null ? null : Number(body.labId);
  if (body.active !== undefined) data.active = !!body.active;
  if (body.sendEnabled !== undefined) data.sendEnabled = !!body.sendEnabled;
  if (body.autoAskIdOnMissing !== undefined) data.autoAskIdOnMissing = !!body.autoAskIdOnMissing;

  if (Object.keys(data).length === 0)
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });

  try {
    const group = await prisma.waGroup.update({ where: { id }, data });
    return NextResponse.json({ group });
  } catch {
    return NextResponse.json({ error: "group not found" }, { status: 404 });
  }
}
