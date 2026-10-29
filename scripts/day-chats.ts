/**
 * Today's store and lab group chats, as WhatsApp exports read (29 Oct 2026): one block per group,
 * every message with its time, who wrote it, and what it replied to. Agent messages are marked
 * [agent], the team's [team]. Read from what the gateway already stored — no WhatsApp clicking.
 * Prints to stdout; patient details stay in the file you write, never in the repo.
 *
 *   docker compose -f docker-compose.yml -f docker-compose.wa.yml exec -T app npx tsx scripts/day-chats.ts > ~/chats.txt
 *   (then SSH-in-browser › DOWNLOAD FILE › chats.txt)
 *
 * Optional: a start hour (default 7) — "scripts/day-chats.ts 13" for 1 pm onwards.
 */
import prisma from "@/lib/db/client";
import { isAutomated, loadTeam, makeTeamMatcher } from "@/lib/wa/team";

const TZ = process.env.TIMEZONE || "Asia/Kolkata";
const hhmm = (d: Date) => d.toLocaleTimeString("en-IN", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

async function main() {
  const fromHour = Number(process.argv[2] ?? 7);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const since = new Date(`${today}T${String(fromHour).padStart(2, "0")}:00:00+05:30`);
  const groups = await prisma.waGroup.findMany({ where: { active: true, archivedAt: null, role: { in: ["SUPPORT", "PROVIDER"] } }, select: { id: true, subject: true, role: true } });
  const team = await loadTeam();
  const isTeam = makeTeamMatcher(team);
  let total = 0;
  for (const g of groups.sort((a, b) => a.role.localeCompare(b.role) || a.subject.localeCompare(b.subject))) {
    const msgs = await prisma.waMessage.findMany({ where: { groupId: g.id, ts: { gte: since } }, orderBy: { ts: "asc" }, select: { waMsgId: true, ts: true, sender: true, senderJid: true, text: true, fromMe: true, direction: true, intent: true, replyToWaId: true, mediaType: true } });
    if (!msgs.length) continue;
    total += msgs.length;
    const byId = new Map(msgs.map((m) => [m.waMsgId, m]));
    console.log(`\n=== ${g.subject} · ${g.role === "SUPPORT" ? "store group" : "lab group"} · ${msgs.length} messages since ${fromHour}:00 ===`);
    for (const m of msgs) {
      const who = isAutomated(m) ? "Labstack Operations [agent]" : m.fromMe ? "Labstack Operations [team, typed]" : isTeam(m.sender, m.senderJid) ? `${m.sender} [team]` : m.sender;
      let quoted = "";
      if (m.replyToWaId) {
        const q = byId.get(m.replyToWaId) ?? (await prisma.waMessage.findUnique({ where: { waMsgId: m.replyToWaId }, select: { text: true, sender: true } }).catch(() => null));
        quoted = q ? `  ↪ replying to ${q.sender}: "${(q.text ?? "").replace(/\s+/g, " ").slice(0, 80)}"\n` : "  ↪ replying to an earlier message\n";
      }
      const body = (m.text ?? "").trim() || (m.mediaType ? `<${m.mediaType}>` : "<empty>");
      console.log(`[${hhmm(m.ts)}] ${who}:\n${quoted}  ${body.replace(/\n/g, "\n  ")}`);
    }
  }
  console.log(`\n${total} messages in ${groups.length} groups checked.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
