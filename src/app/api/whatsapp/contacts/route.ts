import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

export const dynamic = "force-dynamic";

// GET /api/whatsapp/contacts — the LS team roster
export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const contacts = await prisma.waContact.findMany({ orderBy: { name: "asc" } });
  return NextResponse.json({ contacts });
}

// POST /api/whatsapp/contacts — bulk upsert.
// body: { text } with "Name, Phone[, Team]" lines, OR { contacts: [{name, phone, team}] }
export async function POST(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  let items: { name: string; phone: string | null; team: string | null }[] = [];

  if (typeof body.text === "string") {
    items = body.text.split(/\r?\n/).map((line: string) => {
      const parts = line.split(/[,\t]/).map((s) => s.trim());
      const name = parts[0] || "";
      const phone = (parts[1] || "").replace(/\D/g, "") || null;
      const team = parts[2] || null;
      return { name, phone, team };
    }).filter((x: { name: string }) => x.name.length > 1);
  } else if (Array.isArray(body.contacts)) {
    items = body.contacts.map((c: { name?: string; phone?: string; team?: string }) => ({
      name: String(c.name || "").trim(),
      phone: String(c.phone || "").replace(/\D/g, "") || null,
      team: c.team ? String(c.team) : null,
    })).filter((x: { name: string }) => x.name.length > 1);
  } else {
    return NextResponse.json({ error: "provide text or contacts" }, { status: 400 });
  }

  let created = 0, updated = 0;
  for (const it of items) {
    // upsert by phone when present, else by exact name
    const existing = it.phone
      ? await prisma.waContact.findFirst({ where: { phone: it.phone } })
      : await prisma.waContact.findFirst({ where: { name: it.name } });
    if (existing) {
      await prisma.waContact.update({ where: { id: existing.id }, data: { name: it.name, phone: it.phone ?? existing.phone, team: it.team ?? existing.team, active: true } });
      updated++;
    } else {
      await prisma.waContact.create({ data: { name: it.name, phone: it.phone, team: it.team } });
      created++;
    }
  }
  return NextResponse.json({ ok: true, created, updated, total: created + updated });
}
