/**
 * Who in a lab's WhatsApp group the bot should @mention.
 *
 * No configuration needed: the lab's coordinator is whoever on the LAB side
 * writes most in its group over the last 30 days (LabStack's own team excluded
 * — roster match or "Labstack" in the name). Lab Config can name people
 * instead; then those are used.
 */
import prisma from "@/lib/db/client";
import { loadTeam, makeTeamMatcher } from "./team";

export type Coordinator = { jid: string; name: string };
export type GroupMember = Coordinator & { messages: number; lastAt: Date | null; team: boolean };

const WINDOW_DAYS = 30;

/** Everyone who wrote in the group, lab people first and busiest first. */
export async function groupMembers(groupJid: string, now = new Date()): Promise<GroupMember[]> {
  const group = await prisma.waGroup.findUnique({ where: { jid: groupJid }, select: { id: true } });
  if (!group) return [];
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const rows = await prisma.waMessage.groupBy({
    by: ["senderJid"],
    where: { groupId: group.id, fromMe: false, senderJid: { not: null }, ts: { gte: since } },
    _count: { _all: true },
    _max: { ts: true },
  });
  if (rows.length === 0) return [];
  const names = await prisma.waMessage.findMany({
    where: { groupId: group.id, fromMe: false, senderJid: { in: rows.map((r) => r.senderJid!) }, sender: { not: "" } },
    distinct: ["senderJid"],
    orderBy: { ts: "desc" },
    select: { senderJid: true, sender: true },
  });
  const nameOf = new Map(names.map((n) => [n.senderJid, n.sender]));
  const matchTeam = makeTeamMatcher(await loadTeam());
  return rows.map((r) => {
    const name = nameOf.get(r.senderJid) ?? r.senderJid!.split("@")[0];
    return { jid: r.senderJid!, name, messages: r._count._all, lastAt: r._max.ts, team: !!matchTeam(name, r.senderJid) || /labstack/i.test(name) };
  }).sort((a, b) => Number(a.team) - Number(b.team) || b.messages - a.messages);
}

const cache = new Map<string, { at: number; pick: Coordinator | null }>();
const CACHE_MS = 10 * 60_000;

/** The most active lab-side writer in the group, or null when none has written. */
export async function autoCoordinator(groupJid: string | null | undefined, now = new Date()): Promise<Coordinator | null> {
  if (!groupJid) return null;
  const hit = cache.get(groupJid);
  if (hit && now.getTime() - hit.at < CACHE_MS) return hit.pick;
  const top = (await groupMembers(groupJid, now)).find((member) => !member.team) ?? null;
  const pick = top ? { jid: top.jid, name: top.name } : null;
  cache.set(groupJid, { at: now.getTime(), pick });
  return pick;
}

/** The people to @mention for a lab: the ones named on Lab Config, else the automatic pick. */
export async function coordinatorsFor(config: { coordinators: unknown; waGroupJid: string | null }, now = new Date()): Promise<Coordinator[]> {
  const named = (Array.isArray(config.coordinators) ? config.coordinators : [])
    .filter((c): c is Coordinator => typeof c?.jid === "string" && c.jid.includes("@"));
  if (named.length) return named;
  const auto = await autoCoordinator(config.waGroupJid, now);
  return auto ? [auto] : [];
}
