/**
 * Connect a WhatsApp group to a lab or a store (lib/wa/connect.ts).
 *
 *   GET  ?q=…   what the group is connected to now, and the labs and stores it
 *               most likely belongs to — by name match with the group's
 *               subject, or by the search text / id when given.
 *   POST        { kind: "LAB", id } | { kind: "STORE", id } | { kind: "INTERNAL" } | { kind: "NONE" }
 */
import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { labstackWorkerQuery } from "@/lib/db/labstack";
import { loadSourceLabs } from "@/lib/non-api-labs/lab-catalog";
import { scoreMatch } from "@/lib/non-api-labs/group-match";
import { connectGroup } from "@/lib/wa/connect";

type Option = { id: number; name: string; detail: string | null; score: number };

let storeCache: { at: number; stores: Array<{ id: number; name: string; city: string | null }> } | null = null;
async function loadStores() {
  if (storeCache && Date.now() - storeCache.at < 5 * 60_000) return storeCache.stores;
  const stores = await labstackWorkerQuery<{ id: number; name: string; city: string | null }>(
    `SELECT id, btrim("storeName") AS name, city FROM public."Store" WHERE COALESCE(active, true) ORDER BY id`,
  );
  storeCache = { at: Date.now(), stores };
  return stores;
}

function rank<T extends { id: number; name: string }>(items: T[], subject: string, q: string, detail: (item: T) => string | null): Option[] {
  const query = q.trim().toLowerCase();
  const scored = items.map((item) => ({
    id: item.id, name: item.name, detail: detail(item),
    score: query
      ? (String(item.id) === query ? 2 : item.name.toLowerCase().includes(query) ? 1 : 0)
      : scoreMatch(item.name, subject),
  }));
  return scored.filter((o) => o.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 8);
}

async function authorize(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  return user && user.role === UserRole.OPS_HEAD ? user : null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await authorize(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const group = await prisma.waGroup.findUnique({ where: { id: (await params).id } });
  if (!group) return NextResponse.json({ error: "group not found" }, { status: 404 });
  const q = request.nextUrl.searchParams.get("q") ?? "";
  const [labs, stores] = await Promise.all([loadSourceLabs().catch(() => []), loadStores().catch(() => [])]);
  const labOptions = rank(labs.map((l) => ({ ...l, name: (l.labName ?? "").trim() })), group.subject, q, (l) => l.city);
  const storeOptions = rank(stores, group.subject, q, (s) => s.city);
  const current = group.role === "PROVIDER" && group.labId
    ? { kind: "LAB", id: group.labId, name: labs.find((l) => l.id === group.labId)?.labName?.trim() ?? `Lab #${group.labId}` }
    : group.role === "SUPPORT" && group.storeId
      ? { kind: "STORE", id: group.storeId, name: stores.find((s) => s.id === group.storeId)?.name ?? `Store #${group.storeId}` }
      : group.role === "INTERNAL" ? { kind: "INTERNAL" } : group.role === "IGNORE" ? { kind: "NONE" } : null;
  return NextResponse.json({ current, labs: labOptions, stores: storeOptions });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await authorize(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const id = Number(body?.id);
  const target = body?.kind === "LAB" && Number.isInteger(id) && id > 0 ? { kind: "LAB" as const, labId: id }
    : body?.kind === "STORE" && Number.isInteger(id) && id > 0 ? { kind: "STORE" as const, storeId: id }
    : body?.kind === "INTERNAL" ? { kind: "INTERNAL" as const }
    : body?.kind === "NONE" ? { kind: "NONE" as const } : null;
  if (!target) return NextResponse.json({ error: "kind must be LAB or STORE with an id, or NONE" }, { status: 400 });
  try {
    const result = await connectGroup((await params).id, target, user.id);
    return NextResponse.json({ ok: true, group: result.group, labConfigured: !!result.labConfig });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "could not connect" }, { status: 400 });
  }
}
