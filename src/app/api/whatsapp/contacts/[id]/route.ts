import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

// DELETE /api/whatsapp/contacts/:id — remove a team member from the roster
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const { id } = await params;
  await prisma.waContact.delete({ where: { id } }).catch(() => {});
  return NextResponse.json({ ok: true });
}

// PATCH /api/whatsapp/contacts/:id — { coach?: boolean } (may coach the agent from WhatsApp)
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as { coach?: unknown };
  if (typeof body.coach !== "boolean") return NextResponse.json({ error: "coach must be a boolean" }, { status: 400 });
  const contact = await prisma.waContact.update({ where: { id }, data: { coach: body.coach } }).catch(() => null);
  if (!contact) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true, contact });
}

