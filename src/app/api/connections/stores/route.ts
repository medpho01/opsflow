/**
 * GET /api/connections/stores?q=&filter=&page=&pageSize= — every LabStack store
 * with its WhatsApp group (connected, or the best match by name to connect),
 * busiest first by orders in the last 30 days. Read-only on LabStack.
 *   filter: ALL | CONNECTED | NOT_CONNECTED
 * PATCH /api/connections/stores { storeId, summaries } — the store gets the daily summaries
 *   (09:00, 12:00, 16:00) whatever the agent's state for it.
 */
import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { labstackWorkerQuery } from "@/lib/db/labstack";
import { suggestGroup } from "@/lib/non-api-labs/group-match";

type StoreRow = { id: number; name: string; city: string | null; active: boolean | null; orders30d: number };
let cache: { at: number; stores: StoreRow[] } | null = null;

async function loadStores(fresh: boolean) {
  if (!fresh && cache && Date.now() - cache.at < 5 * 60_000) return cache.stores;
  const stores = await labstackWorkerQuery<StoreRow>(`
    SELECT s.id, btrim(s."storeName") AS name, s.city, s.active,
           COUNT(o.id) FILTER (WHERE o."createdAt" >= (now() AT TIME ZONE 'UTC') - interval '30 days')::int AS "orders30d"
      FROM public."Store" s
      LEFT JOIN public."Order" o ON o."storeId" = s.id
     GROUP BY s.id, s."storeName", s.city, s.active`);
  cache = { at: Date.now(), stores };
  return stores;
}

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const params = request.nextUrl.searchParams;
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const filter = params.get("filter") ?? "ALL";
  const pageSize = Math.min(100, Math.max(10, Number(params.get("pageSize")) || 25));

  const [stores, groups, settings] = await Promise.all([
    loadStores(params.get("refresh") === "1"),
    prisma.waGroup.findMany({ where: { archivedAt: null, isMember: true }, select: { id: true, jid: true, subject: true, role: true, storeId: true, labId: true, autoAskIdOnMissing: true } }),
    prisma.agentSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } }),
  ]);
  const summaries = new Set(settings.digestStoreIds);
  const byStore = new Map(groups.filter((g) => g.role === "SUPPORT" && g.storeId != null).map((g) => [g.storeId!, g]));
  // Only groups not yet connected to anything are worth suggesting.
  const free = groups.filter((g) => !(g.role === "SUPPORT" && g.storeId != null) && !(g.role === "PROVIDER" && g.labId != null) && g.role !== "INTERNAL" && g.role !== "IGNORE");

  const rows = stores
    .filter((s) => !q || s.name.toLowerCase().includes(q) || String(s.id) === q || (s.city ?? "").toLowerCase().includes(q))
    .map((s) => {
      const group = byStore.get(s.id) ?? null;
      const suggestion = group ? null : suggestGroup(s.name, free);
      return {
        id: s.id, name: s.name, city: s.city, active: s.active !== false, orders30d: s.orders30d, summaries: summaries.has(s.id),
        group: group ? { id: group.id, subject: group.subject, autoAskIdOnMissing: group.autoAskIdOnMissing } : null,
        suggested: suggestion ? { id: suggestion.group.id, subject: suggestion.group.subject } : null,
      };
    })
    .filter((r) => filter === "ALL" || (filter === "CONNECTED" ? !!r.group : !r.group))
    .sort((a, b) => b.orders30d - a.orders30d || a.name.localeCompare(b.name));

  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Number(params.get("page")) || 1), pageCount);
  return NextResponse.json({
    stores: rows.slice((page - 1) * pageSize, page * pageSize), total, page, pageCount,
    connected: stores.filter((s) => byStore.has(s.id)).length,
  });
}

export async function PATCH(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { storeId?: number; summaries?: boolean };
  const storeId = Number(body.storeId);
  if (!Number.isInteger(storeId) || typeof body.summaries !== "boolean") return NextResponse.json({ error: "storeId and summaries are required" }, { status: 400 });
  const settings = await prisma.agentSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
  const next = body.summaries ? [...new Set([...settings.digestStoreIds, storeId])] : settings.digestStoreIds.filter((id) => id !== storeId);
  await prisma.agentSettings.update({ where: { id: "default" }, data: { digestStoreIds: next } });
  return NextResponse.json({ ok: true, summaries: body.summaries });
}
