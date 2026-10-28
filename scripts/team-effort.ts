/**
 * How much of the team's time goes into the WhatsApp groups, and on what —
 * for a management view, not for the product. Read-only; writes ONE file of
 * aggregates (counts, times, kinds, team members by name) with no message
 * text, patient names or phone numbers, so it can be shared.
 *
 *   docker compose exec -T app npx tsx scripts/team-effort.ts            # last 30 days
 *   docker compose exec -T app npx tsx scripts/team-effort.ts 60         # last 60 days
 *   docker compose exec -T app npx tsx scripts/team-effort.ts 30 Aryan,Veena,Jarod,Shushma,Deepali
 *
 * Output: exports/team-effort-<date>.json (download it) and a summary on screen.
 *
 * Definitions
 *   counterpart   a message from the lab or store side (not the team, not the bot, not automated)
 *   question      a counterpart message that asks for something (not thanks/ok/emoji)
 *   first reply   the team's first message in that group after the question, within 4 h
 *   active time   5-minute buckets in which the person wrote at least once (a floor), plus
 *                 a per-message allowance of 1 min for reading and finding the order
 */
import { mkdirSync, writeFileSync } from "node:fs";
import prisma from "@/lib/db/client";
import { isAutomated, loadTeam, makeTeamMatcher } from "@/lib/wa/team";

const TZ = process.env.TIMEZONE || "Asia/Kolkata";
const MIN = 60_000;
const DAY = 86_400_000;

const KINDS: Array<[string, RegExp]> = [
  ["status", /\b(status|update|collected|collection|done\?|phlebo|reached|visit|arriv|eta|on the way|rnr|not reachable|no show|noshow)\b/i],
  ["report", /\b(report|result|pdf|soft ?copy|hard ?copy|parameter|value|missing)\b/i],
  ["reschedule", /\b(reschedul|postpone|prepone|change (the )?(time|slot|date)|new (slot|time)|shift)\b/i],
  ["cancel", /\b(cancel|refund)\b/i],
  ["slot", /\b(slot|availab|timing|what time|which time|earliest)\b/i],
  ["confirm", /\b(confirm|accept|acknowledg|please take|new order|order placed|booking)\b/i],
  ["payment", /\b(invoice|payment|paid|amount|price|cost|bill|scanner|upi|gst)\b/i],
  ["sample", /\b(sample|urine|stool|serum|fasting|tube|vial|re-?collect)\b/i],
  ["complaint", /\b(complain|escalat|rude|late|delay|issue|problem|wrong|mistake|unhappy|angry|frustrat)\b/i],
  ["address", /\b(address|location|pincode|pin code|landmark|map|area|serviceab)\b/i],
];
const ACK = /^\s*(ok(ay)?|okk+|k|thanks?( you)?|thank u|tq|ty|noted|sure|done|fine|great|good|👍|🙏|✅|yes|no|hmm|alright|got it|received|will do)\s*[.!]*\s*$/i;

function kindOf(text: string): string {
  const t = text.replace(/@\d{6,}/g, " ");
  for (const [k, re] of KINDS) if (re.test(t)) return k;
  return "other";
}
const isQuestion = (text: string) => {
  const t = text.replace(/@\d{6,}/g, "").trim();
  return t.length > 2 && !ACK.test(t) && !/^\d{5,7}$/.test(t);
};
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)]); };
const p90 = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length * 0.9)]); };
const hourOf = (d: Date) => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: TZ }).format(d)) % 24;
const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
const weekend = (d: Date) => ["Sat", "Sun"].includes(new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: TZ }).format(d));
const inc = (m: Record<string, number>, k: string, by = 1) => { m[k] = (m[k] ?? 0) + by; };

type Msg = { id: string; waMsgId: string; groupId: string; ts: Date; fromMe: boolean; sender: string; senderJid: string | null; text: string; intent: string | null; replyToWaId: string | null; mediaType: string | null };

async function main() {
  const days = Number(process.argv[2] ?? 30);
  const focus = (process.argv[3] ?? "Aryan,Veena,Jarod,Shushma,Deepali").split(",").map((s) => s.trim()).filter(Boolean);
  const now = new Date(); const since = new Date(now.getTime() - days * DAY);

  const groups = await prisma.waGroup.findMany({ select: { id: true, subject: true, role: true, labId: true, storeId: true, archivedAt: true } });
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const team = await loadTeam();
  const isTeam = makeTeamMatcher(team);
  // A person is one of the focus names when the roster says so or their push name carries the name.
  const personOf = (m: Msg): string | null => {
    const c = isTeam(m.sender, m.senderJid);
    if (c) return c.name;
    const hit = focus.find((n) => m.sender?.toLowerCase().includes(n.toLowerCase()));
    return hit ?? null;
  };
  // Bot sends: our own outbound rows; the gateway marks what it sent as AUTOMATED or fromMe without a person.
  const botWaIds = new Set((await prisma.waOutbound.findMany({ where: { createdAt: { gte: since }, sentWaMsgId: { not: null } }, select: { sentWaMsgId: true } })).map((o) => o.sentWaMsgId!));

  const msgs = (await prisma.waMessage.findMany({ where: { ts: { gte: since } }, orderBy: { ts: "asc" }, select: { id: true, waMsgId: true, groupId: true, ts: true, fromMe: true, sender: true, senderJid: true, text: true, intent: true, replyToWaId: true, mediaType: true } })) as Msg[];
  const side = (m: Msg): "bot" | "team" | "counterpart" => (botWaIds.has(m.waMsgId) || isAutomated(m) ? "bot" : (m.fromMe || personOf(m)) ? "team" : "counterpart");

  // ── per group ──
  type G = { subject: string; role: string; messages: number; team: number; bot: number; counterpart: number; questions: number; answered: number; answeredIn15: number; unanswered: number; replyMin: number[]; kinds: Record<string, number>; teamKinds: Record<string, number>; people: Record<string, number>; hours: Record<string, number>; days: Set<string>; weekendTeam: number; nightTeam: number; media: number };
  const byGroup = new Map<string, G>();
  const g = (id: string) => byGroup.get(id) ?? byGroup.set(id, { subject: groupById.get(id)?.subject ?? id, role: groupById.get(id)?.role ?? "?", messages: 0, team: 0, bot: 0, counterpart: 0, questions: 0, answered: 0, answeredIn15: 0, unanswered: 0, replyMin: [], kinds: {}, teamKinds: {}, people: {}, hours: {}, days: new Set(), weekendTeam: 0, nightTeam: 0, media: 0 }).get(id)!;
  // ── per person ──
  type P = { messages: number; groups: Set<string>; firstReplies: number; replyMin: number[]; kinds: Record<string, number>; hours: Record<string, number>; days: Set<string>; weekend: number; night: number; buckets: Set<string>; chases: number; answers: number; roles: Record<string, number> };
  const byPerson = new Map<string, P>();
  const p = (n: string) => byPerson.get(n) ?? byPerson.set(n, { messages: 0, groups: new Set(), firstReplies: 0, replyMin: [], kinds: {}, hours: {}, days: new Set(), weekend: 0, night: 0, buckets: new Set(), chases: 0, answers: 0, roles: {} }).get(n)!;

  const perGroup = new Map<string, Msg[]>();
  for (const m of msgs) perGroup.set(m.groupId, [...(perGroup.get(m.groupId) ?? []), m]);

  for (const [groupId, list] of perGroup) {
    const G = g(groupId);
    const role = G.role;
    for (let i = 0; i < list.length; i += 1) {
      const m = list[i]; const s = side(m);
      G.messages += 1; G[s] += 1; G.days.add(dayKey(m.ts)); if (m.mediaType) G.media += 1;
      if (s === "team") {
        const who = personOf(m) ?? "(unnamed team)";
        inc(G.people, who); inc(G.hours, String(hourOf(m.ts)));
        if (weekend(m.ts)) G.weekendTeam += 1; if (hourOf(m.ts) >= 21 || hourOf(m.ts) < 8) G.nightTeam += 1;
        const k = kindOf(m.text); inc(G.teamKinds, k);
        const P = p(who); P.messages += 1; P.groups.add(groupId); P.days.add(dayKey(m.ts)); inc(P.hours, String(hourOf(m.ts))); inc(P.kinds, k); inc(P.roles, role);
        if (weekend(m.ts)) P.weekend += 1; if (hourOf(m.ts) >= 21 || hourOf(m.ts) < 8) P.night += 1;
        P.buckets.add(`${dayKey(m.ts)}:${Math.floor(m.ts.getTime() / (5 * MIN))}`);
        if (role === "PROVIDER") P.chases += 1; else P.answers += 1;
      }
      if (s === "counterpart" && isQuestion(m.text)) {
        G.questions += 1; inc(G.kinds, kindOf(m.text));
        // the team's first message after it in this group, within 4 h (a bot reply counts as answered, not as a team reply)
        let answeredBy: Msg | null = null; let botAnswered = false;
        for (let j = i + 1; j < list.length && list[j].ts.getTime() - m.ts.getTime() <= 4 * 60 * MIN; j += 1) {
          const sj = side(list[j]);
          if (sj === "bot" && !botAnswered && (list[j].replyToWaId === m.waMsgId || list[j].ts.getTime() - m.ts.getTime() <= 10 * MIN)) botAnswered = true;
          if (sj === "team") { answeredBy = list[j]; break; }
        }
        if (answeredBy) {
          const mins = (answeredBy.ts.getTime() - m.ts.getTime()) / MIN;
          G.answered += 1; G.replyMin.push(mins); if (mins <= 15) G.answeredIn15 += 1;
          const who = personOf(answeredBy) ?? "(unnamed team)"; const P = p(who); P.firstReplies += 1; P.replyMin.push(mins);
        } else if (botAnswered) G.answered += 1;
        else G.unanswered += 1;
      }
    }
  }

  const groupsOut = [...byGroup.values()].filter((x) => x.messages > 0).sort((a, b) => b.team - a.team).map((x) => ({
    group: x.subject, role: x.role, days: x.days.size, messages: x.messages, team: x.team, bot: x.bot, counterpart: x.counterpart,
    teamPerDay: Math.round((x.team / Math.max(1, days)) * 10) / 10, questions: x.questions, answeredByTeam: x.replyMin.length, answeredByBot: x.answered - x.replyMin.length, unanswered: x.unanswered,
    answeredIn15: x.answeredIn15, medianReplyMin: median(x.replyMin), p90ReplyMin: p90(x.replyMin), kinds: x.kinds, teamKinds: x.teamKinds, people: x.people, hours: x.hours, weekendTeam: x.weekendTeam, nightTeam: x.nightTeam, media: x.media,
  }));
  const peopleOut = [...byPerson.entries()].sort((a, b) => b[1].messages - a[1].messages).map(([name, P]) => ({
    name, focus: focus.some((n) => name.toLowerCase().includes(n.toLowerCase())), messages: P.messages, perDay: Math.round((P.messages / days) * 10) / 10, activeDays: P.days.size, groups: P.groups.size,
    firstReplies: P.firstReplies, medianReplyMin: median(P.replyMin), p90ReplyMin: p90(P.replyMin), repliesIn15: P.replyMin.filter((x) => x <= 15).length,
    labChases: P.chases, storeAnswers: P.answers, kinds: P.kinds, hours: P.hours, weekend: P.weekend, night: P.night,
    activeMinutesFloor: P.buckets.size * 5, estimatedMinutes: P.buckets.size * 5 + P.messages, estimatedHoursPerDay: Math.round(((P.buckets.size * 5 + P.messages) / 60 / Math.max(1, P.days.size)) * 10) / 10,
  }));
  const totals = { days, since: since.toISOString(), groups: groupsOut.length, messages: msgs.length, team: groupsOut.reduce((s, x) => s + x.team, 0), bot: groupsOut.reduce((s, x) => s + x.bot, 0), counterpart: groupsOut.reduce((s, x) => s + x.counterpart, 0), questions: groupsOut.reduce((s, x) => s + x.questions, 0), unanswered: groupsOut.reduce((s, x) => s + x.unanswered, 0), teamEstimatedHours: Math.round(peopleOut.reduce((s, x) => s + x.estimatedMinutes, 0) / 60) };

  mkdirSync("exports", { recursive: true });
  const file = `exports/team-effort-${dayKey(now)}.json`;
  writeFileSync(file, JSON.stringify({ generatedAt: now.toISOString(), timeZone: TZ, totals, people: peopleOut, groups: groupsOut }, null, 2));

  console.log(`Team effort in WhatsApp groups · last ${days} days · ${totals.groups} groups · ${totals.messages} messages (team ${totals.team}, bot ${totals.bot}, labs/stores ${totals.counterpart})`);
  console.log(`Questions from labs/stores: ${totals.questions} · unanswered within 4 h: ${totals.unanswered} · team time (estimate): ~${totals.teamEstimatedHours} h\n`);
  console.log("People (focus first):");
  for (const x of peopleOut.filter((x) => x.focus || x.messages >= 20).sort((a, b) => Number(b.focus) - Number(a.focus) || b.messages - a.messages)) {
    console.log(`  ${x.name.padEnd(22)} ${String(x.messages).padStart(5)} msgs  ${String(x.perDay).padStart(5)}/day  ${String(x.activeDays).padStart(2)} days  ${String(x.groups).padStart(3)} groups  first replies ${String(x.firstReplies).padStart(4)}  median ${x.medianReplyMin ?? "—"} min  ≤15 min ${x.repliesIn15}  labs ${x.labChases}/stores ${x.storeAnswers}  ~${x.estimatedHoursPerDay} h/day  night ${x.night} wknd ${x.weekend}`);
  }
  console.log("\nGroups by team load (top 20):");
  for (const x of groupsOut.slice(0, 20)) console.log(`  ${x.group.slice(0, 36).padEnd(36)} ${x.role.padEnd(8)} team ${String(x.team).padStart(5)} (${x.teamPerDay}/d)  bot ${String(x.bot).padStart(4)}  them ${String(x.counterpart).padStart(5)}  questions ${String(x.questions).padStart(4)}  team-answered ${String(x.answeredByTeam).padStart(4)}  bot ${String(x.answeredByBot).padStart(3)}  unanswered ${String(x.unanswered).padStart(3)}  median ${x.medianReplyMin ?? "—"} min  top: ${Object.entries(x.kinds).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`\nWritten: ${file}  (aggregates only — no message text, names of patients or phone numbers)`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
