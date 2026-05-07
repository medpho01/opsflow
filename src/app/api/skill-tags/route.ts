/**
 * GET  /api/skill-tags — list all skill tags
 * POST /api/skill-tags — create a new skill tag (OPS_HEAD only)
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tags = await prisma.skillTag.findMany({ orderBy: { label: "asc" } });
  return NextResponse.json({ tags });
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { name, label } = await request.json();
  if (!name || !label) return NextResponse.json({ error: "name and label required" }, { status: 400 });

  const slug = name.trim().toLowerCase().replace(/\s+/g, "_");
  const existing = await prisma.skillTag.findUnique({ where: { name: slug } });
  if (existing) return NextResponse.json({ error: "Skill tag already exists" }, { status: 409 });

  const tag = await prisma.skillTag.create({ data: { name: slug, label: label.trim() } });
  return NextResponse.json({ tag }, { status: 201 });
}
