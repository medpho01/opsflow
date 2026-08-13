import prisma from "@/lib/db/client";

export type TeamContact = { id: string; name: string; phone: string | null; aliases: string[]; team: string | null };

const last10 = (s: string | null | undefined) => (s || "").replace(/\D/g, "").slice(-10);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

export async function loadTeam(): Promise<TeamContact[]> {
  return prisma.waContact.findMany({ where: { active: true }, select: { id: true, name: true, phone: true, aliases: true, team: true } });
}

/**
 * Returns a matcher(sender, senderJid) → the LS team member, or null.
 * Match precedence: phone (from an @s.whatsapp.net jid) → name/alias.
 */
export function makeTeamMatcher(team: TeamContact[]) {
  const byPhone = new Map<string, TeamContact>();
  for (const c of team) { const p = last10(c.phone); if (p.length >= 10) byPhone.set(p, c); }
  const named = team.map((c) => ({ c, n: norm(c.name), aliases: (c.aliases || []).map(norm) }));

  return (sender: string, senderJid: string | null): TeamContact | null => {
    if (senderJid && senderJid.includes("@s.whatsapp.net")) {
      const p = last10(senderJid);
      if (p.length >= 10 && byPhone.has(p)) return byPhone.get(p)!;
    }
    const s = norm(sender || "");
    if (!s) return null;
    for (const { c, n, aliases } of named) {
      if (n && n.length >= 3 && (s === n || s.includes(n) || n.includes(s))) return c;
      if (aliases.includes(s)) return c;
    }
    return null;
  };
}
