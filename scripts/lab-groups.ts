/**
 * Which WhatsApp group each lab is chased in, and whether the agent can chase it there
 * (29 Oct 2026). Read-only.
 *
 *   npx tsx scripts/lab-groups.ts            every lab with a group, plus labs with open orders and none
 *   npx tsx scripts/lab-groups.ts orange     labs whose name contains "orange"
 */
import prisma from "@/lib/db/client";
import { labstackWorkerQuery } from "@/lib/db/labstack";
import { loadGuardState } from "@/lib/agents/guard/guard";
import { loadDirectory, tierOf } from "@/lib/agents/directory";

async function main() {
  const filter = (process.argv[2] ?? "").toLowerCase();
  const [configs, groups, state, dir] = await Promise.all([
    prisma.nonApiLabConfig.findMany({ select: { labId: true, labName: true, waGroupJid: true, isActive: true } }),
    prisma.waGroup.findMany({ where: { archivedAt: null }, select: { jid: true, subject: true, role: true, active: true, labId: true } }),
    loadGuardState(),
    loadDirectory(),
  ]);
  const byJid = new Map(groups.map((g) => [g.jid, g]));
  const open = await labstackWorkerQuery<{ labId: number; labName: string; n: number }>(
    `SELECT o."labId", l."labName", count(*)::int AS n FROM public."Order" o JOIN public."Lab" l ON l.id = o."labId"
      WHERE o."appointmentTime" >= NOW() - interval '2 days' AND o."appointmentTime" < NOW() + interval '1 day'
        AND o."orderStatus"::text NOT IN ('CANCELED','CANCELLED','REPORT_DELIVERED') GROUP BY 1, 2`, []).catch(() => []);
  const openBy = new Map(open.map((r) => [r.labId, r]));
  const labs = new Map<number, string>();
  for (const c of configs) labs.set(c.labId, c.labName);
  for (const r of open) if (!labs.has(r.labId)) labs.set(r.labId, r.labName);
  const rows = [...labs].filter(([, name]) => !filter || name.toLowerCase().includes(filter)).sort((a, b) => (openBy.get(b[0])?.n ?? 0) - (openBy.get(a[0])?.n ?? 0));
  console.log("lab (id)                                   tier  desk    open  group                                        chaseable");
  for (const [labId, name] of rows) {
    const c = configs.find((x) => x.labId === labId);
    const g = c?.waGroupJid ? byJid.get(c.waGroupJid) : undefined;
    const desk = state.desks.get(`LAB:LAB:${labId}`) ?? "OFF";
    const groupText = !c?.waGroupJid ? "— none" : !g ? "configured, but the group is not known to the gateway" : `${g.subject}${g.role !== "PROVIDER" ? ` (role ${g.role}!)` : ""}${g.active ? "" : " (not listening!)"}`;
    const chaseable = !!g && g.role === "PROVIDER" && g.active && desk === "LIVE";
    console.log(`${`${name.slice(0, 34)} (${labId})`.padEnd(43)}${String(tierOf(dir, labId) ?? "?").padEnd(6)}${desk.padEnd(8)}${String(openBy.get(labId)?.n ?? 0).padStart(4)}  ${groupText.slice(0, 44).padEnd(45)}${chaseable ? "yes" : "NO"}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
