/**
 * Names for the "@157140018823280"-style mentions in WhatsApp text.
 *
 * A mention carries the WhatsApp id the sender's app used: a phone number or a
 * LID (an anonymous number that is not the phone). The gateway records which
 * LID belongs to which phone, and display names, in wa_identities (from
 * incoming messages and from group member lists). A mention is named from, in
 * order:
 *   1. the team roster, matched on the phone (the id itself, or the phone a LID
 *      belongs to);
 *   2. the person's WhatsApp display name;
 *   3. the name they used when they last wrote under either id;
 *   4. their phone number, when that is all we know.
 * Anything else stays as the bare number.
 */
import prisma from "@/lib/db/client";
import { loadTeam, type TeamContact } from "@/lib/wa/team";

const MENTION_RE = /@(\d{5,})/g;
const last10 = (s: string | null | undefined) => (s || "").replace(/\D/g, "").slice(-10);

function formatPhone(digits: string): string {
  if (digits.length === 12 && digits.startsWith("91")) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  return `+${digits}`;
}

/** The ids mentioned in these texts. */
export function mentionIds(texts: Array<string | null | undefined>): string[] {
  const ids = new Set<string>();
  for (const text of texts) for (const m of (text || "").matchAll(MENTION_RE)) ids.add(m[1]);
  return [...ids];
}

/** Mention id → display name, for every id in `texts` we can name. */
export async function resolveMentionNames(
  texts: Array<string | null | undefined>,
  options: { team?: TeamContact[] } = {},
): Promise<Record<string, string>> {
  const ids = mentionIds(texts);
  if (ids.length === 0) return {};
  const team = options.team ?? (await loadTeam());
  const rosterByPhone = new Map(team.filter((t) => t.phone).map((t) => [last10(t.phone), t.name]));

  const known = await prisma.waIdentity.findMany({ where: { localpart: { in: ids } } });
  const counterparts = known.map((row) => row.counterpart).filter((cp): cp is string => !!cp);
  const others = counterparts.length ? await prisma.waIdentity.findMany({ where: { localpart: { in: counterparts } } }) : [];
  const identity = new Map([...known, ...others].map((row) => [row.localpart, row]));

  const everyId = [...new Set([...ids, ...counterparts])];
  const speakers = await prisma.$queryRaw<Array<{ lp: string; sender: string }>>`
    SELECT DISTINCT ON (split_part("senderJid", '@', 1)) split_part("senderJid", '@', 1) AS lp, sender
      FROM wa_messages
     WHERE "senderJid" IS NOT NULL AND sender <> '' AND "fromMe" = false
       AND split_part(split_part("senderJid", '@', 1), ':', 1) = ANY(${everyId})
     ORDER BY split_part("senderJid", '@', 1), ts DESC`.catch(() => []);
  const spokeAs = new Map(speakers.map((row) => [row.lp.split(":")[0], row.sender]));

  const names: Record<string, string> = {};
  for (const id of ids) {
    const row = identity.get(id);
    const other = row?.counterpart ? identity.get(row.counterpart) : undefined;
    // The phone behind this id, if we know it.
    const phone = row?.kind === "PN" ? id : other?.kind === "PN" ? other.localpart : row?.kind === "LID" ? row.counterpart : null;
    const name =
      rosterByPhone.get(last10(phone ?? id))
      ?? row?.name ?? other?.name
      ?? spokeAs.get(id) ?? (row?.counterpart ? spokeAs.get(row.counterpart) : undefined)
      ?? (phone ? formatPhone(phone) : undefined);
    if (name) names[id] = name;
  }
  return names;
}
