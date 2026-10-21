/**
 * GET  /api/agents/portals — sessions per lab, adapter presets, whether the vault can store.
 * POST /api/agents/portals — OPS_HEAD:
 *   { action: "set_login", labId, username, password, adapter, config? }  write-only; the page never shows it back
 *   { action: "signin", labId }                                            ask the portal worker to sign in now
 */
import { NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { agentsRoute, bad } from "@/lib/agents/api";
import { storePortalLogin, vaultCanStore } from "@/lib/agents/portal/vault";
import { ADAPTER_PRESETS } from "@/lib/agents/portal/adapters";
import { enqueuePortalSignin } from "@/lib/agents/queue";
import { loadDirectory } from "@/lib/agents/directory";

export const GET = agentsRoute("portals", async (_request, { requestId }) => {
  const dir = await loadDirectory();
  const [sessions, secrets, reads] = await Promise.all([
    prisma.agentPortalSession.findMany(),
    prisma.agentSecret.findMany({ where: { kind: "PORTAL_LOGIN", active: true }, select: { labId: true, setAt: true, setBy: true, config: true } }),
    prisma.agentPortalRead.groupBy({ by: ["labId"], where: { at: { gte: new Date(Date.now() - 86_400_000) } }, _count: { _all: true } }),
  ]);
  const labs = [...dir.labs.values()].filter((l) => l.hasPortal).map((l) => {
    const s = sessions.find((x) => x.labId === l.labId); const sec = secrets.find((x) => x.labId === l.labId);
    return { labId: l.labId, labName: l.labName, tier: l.tier, status: s?.status ?? "NOT_SET", lastOkAt: s?.lastOkAt ?? null, lastError: s?.lastError ?? null, readsToday: s?.readsToday ?? 0, reads24h: reads.find((r) => r.labId === l.labId)?._count._all ?? 0, loginSetAt: sec?.setAt ?? null, adapter: (sec?.config as { adapter?: string } | null)?.adapter ?? null };
  });
  return NextResponse.json({ labs, presets: Object.entries(ADAPTER_PRESETS).map(([key, p]) => ({ key, name: p.name })), canStore: vaultCanStore(), requestId });
});

export const POST = agentsRoute("portals", async (request, { user, requestId }) => {
  const body = await request.json().catch(() => ({})) as { action?: string; labId?: number; username?: string; password?: string; adapter?: string; config?: Record<string, unknown> };
  if (!Number.isInteger(body.labId)) return bad(requestId, "labId required");
  if (body.action === "set_login") {
    if (!body.username || !body.password) return bad(requestId, "username and password required");
    if (!vaultCanStore()) return bad(requestId, "The vault's public key (AGENT_VAULT_PUBLIC_KEY) is not set on this server", 503);
    const adapter = body.adapter && ADAPTER_PRESETS[body.adapter] ? body.adapter : "generic";
    await storePortalLogin(body.labId!, { username: body.username, password: body.password }, user.id, { adapter, ...(body.config ?? {}) });
    await prisma.agentPortalSession.upsert({ where: { labId: body.labId! }, update: { adapter, status: "LOGGED_OUT", lastError: null }, create: { labId: body.labId!, adapter, status: "LOGGED_OUT" } });
    const queued = await enqueuePortalSignin(body.labId!);
    return NextResponse.json({ ok: true, queuedSignin: queued, requestId });
  }
  if (body.action === "signin") return NextResponse.json({ ok: true, queued: await enqueuePortalSignin(body.labId!), requestId });
  return bad(requestId, "action must be set_login or signin");
}, { headOnly: true });
