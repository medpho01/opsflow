/**
 * When the store desk should NOT speak (28 Oct 2026, Plum's first live afternoon).
 *
 * The desk's facts were right that day; its judgement of when to answer was not.
 * It answered messages addressed to a named person ("@Abhishek as discussed…"),
 * answered complaints with a status line ("doctor consultation was not done" →
 * "report delivered on 16 Oct"), and stood in for the team on orders with labs
 * the bot cannot work with ("checking with Suburban Diagnostics" — a lab with no
 * WhatsApp group and no API). These helpers name those cases:
 *
 *   complaintSignal(text)         a grievance, whatever else the message looks like
 *   addressedToPerson(text, …)    the message is for a named team member, not for us
 *   labOnBot({ api, group, live }) a lab the desk can stand in for
 */
import prisma from "@/lib/db/client";
import { labstackWorkerQuery } from "@/lib/db/labstack";
import { resolveMentionNames } from "@/lib/wa/mentionNames";
import { makeTeamMatcher, type TeamContact } from "@/lib/wa/team";

/**
 * A grievance about what happened, not a question about where things stand: the store already
 * knows the status and is unhappy with it. Answered with a status line it reads as a brush-off.
 */
export const COMPLAINT_SIGNAL_RE = /\b(not done|wasn'?t done|was not done|dummy order|collected but|but (got |was |were |it was |they )?cancell?ed|last time also|again and again|no ?one (is |was |has been )?(assigned|attended|came)|never (came|turned up|collected|happened)|still not (collected|done|uploaded|shared|received)|not (shared|uploaded|collected|done) on time|same (user|issue|problem) (again|as)|what is happening|this is not acceptable)\b/i;

/** A reply that only says we are on it: worth nothing if a person already said so, or if we said it before. */
export const STORE_ACK_RE = /checking with .+will update here|noted, we'll confirm|is with .+we'll confirm here/i;

export function complaintSignal(text: string): boolean {
  return COMPLAINT_SIGNAL_RE.test(text);
}

/** "As discussed", "as per our call": the message continues a conversation with a person. */
export const ADDRESSED_RE = /\bas (discussed|per (our|the) (call|discussion|conversation)|we spoke|spoken)\b|\bwe spoke\b/i;

const MENTION_RE = /@(\d{5,})/g;

/**
 * Who a store message is for, when it names a team member: the @mentioned ids that resolve to
 * someone on the roster (names come from the identity table the gateway keeps), or "as discussed"
 * with no name. Null when the message is for whoever answers — which may be us.
 */
export function addressedToPerson(text: string, mentionNames: Record<string, string>, isTeam: (sender: string, jid: string | null) => unknown, botNumber: string | null = null): { ids: string[]; names: string[] } | null {
  const ids: string[] = []; const names: string[] = [];
  const bot = (botNumber ?? "").replace(/\D/g, "").slice(-10);
  for (const m of text.matchAll(MENTION_RE)) {
    // Tagging our own number ("@Labstack Operations") is asking us, not a person.
    if (bot && m[1].slice(-10) === bot) continue;
    const name = mentionNames[m[1]] ?? mentionNames[m[1].slice(-10)];
    if (!name || /labstack operations/i.test(name)) continue;
    if (isTeam(name, null) && !ids.includes(m[1])) { ids.push(m[1]); names.push(name); }
  }
  if (ids.length) return { ids, names };
  if (ADDRESSED_RE.test(text)) return { ids: [], names: [] };
  return null;
}

/** The same, resolving the mentions through the database. */
export async function addressedTeamMember(text: string, team: TeamContact[]): Promise<{ ids: string[]; names: string[] } | null> {
  if (!/@\d{5,}/.test(text) && !ADDRESSED_RE.test(text)) return null;
  const [names, gateway] = await Promise.all([
    resolveMentionNames([text], { team }).catch(() => ({} as Record<string, string>)),
    prisma.waGateway.findUnique({ where: { id: "default" }, select: { connectedNumber: true } }).catch(() => null),
  ]);
  return addressedToPerson(text, names, makeTeamMatcher(team), gateway?.connectedNumber ?? null);
}

/** The WhatsApp jid to @mention for an id a store wrote: a phone number or a LID. */
export function mentionJid(id: string): string {
  return id.length <= 13 ? `${id}@s.whatsapp.net` : `${id}@lid`;
}

/**
 * A lab the desk can stand in for: LabStack hears from it through an API (the console knows the
 * status), or the lab's own WhatsApp group is connected and its desk is LIVE (we can chase it).
 * Anything else — a lab we reach by phone or email — is the team's, order by order.
 */
export function labOnBot(lab: { api: boolean; group: boolean; live: boolean }): boolean {
  return lab.api || (lab.group && lab.live);
}

export type LabScope = (labId: number) => Promise<boolean>;

/** labId → on the bot, looked up once per lab and remembered for the run. */
export function makeLabScope(desks: Map<string, string>): LabScope {
  const cache = new Map<number, Promise<boolean>>();
  return (labId: number) => {
    let p = cache.get(labId);
    if (!p) {
      p = (async () => {
        const [rows, group] = await Promise.all([
          labstackWorkerQuery<{ api: boolean }>(`SELECT (COALESCE("isApiHomeSample", false) OR COALESCE("isApiCenterVisit", false) OR COALESCE("isApiPpmc", false)) AS api FROM public."Lab" WHERE id = $1`, [labId]).catch(() => []),
          prisma.waGroup.findFirst({ where: { labId, role: "PROVIDER", active: true, archivedAt: null }, select: { id: true } }).catch(() => null),
        ]);
        return labOnBot({ api: rows[0]?.api === true, group: !!group, live: desks.get(`LAB:LAB:${labId}`) === "LIVE" });
      })();
      cache.set(labId, p);
    }
    return p;
  };
}
