/**
 * The agent's coaching from WhatsApp (28 Oct 2026): what the head of ops told it, and what it
 * made of each. Read-only unless asked to retire.
 *
 *   npx tsx scripts/coaching.ts            the ACTIVE lessons and today's commands
 *   npx tsx scripts/coaching.ts all        including retired
 *   npx tsx scripts/coaching.ts retire <id-suffix>
 *   npx tsx scripts/coaching.ts why        who may coach, and why the last hour's messages were or were not taken
 */
import prisma from "@/lib/db/client";

/** `why`: who may coach, and what happened to the last hour's messages from them. */
async function why() {
  const { coachMatcher, coachPrefixRe } = await import("@/lib/agents/brain/coach");
  const coaches = await prisma.waContact.findMany({ where: { coach: true }, select: { name: true, phone: true, active: true } });
  console.log(`coaches on the roster: ${coaches.length ? coaches.map((c) => `${c.name} (${c.phone ? "…" + c.phone.slice(-4) : "no phone"}${c.active ? "" : ", inactive"})`).join(", ") : "NONE — tick 'coach' on Connections › Team"}`);
  const settings = await prisma.agentSettings.findUnique({ where: { id: "default" }, select: { agentName: true, coachWatermark: true } });
  console.log(`agent name: ${settings?.agentName ?? "(not set)"} · coach reader last read up to: ${settings?.coachWatermark?.toISOString() ?? "never (first run reads the last 30 min)"}`);
  const isCoach = await coachMatcher();
  const prefix = coachPrefixRe(settings?.agentName ?? null);
  const groups = await prisma.waGroup.findMany({ where: { active: true, archivedAt: null, OR: [{ role: { in: ["SUPPORT", "PROVIDER", "INTERNAL"] } }, { role: "IGNORE", subject: { startsWith: "Coaching · " } }] }, select: { id: true, jid: true, role: true, subject: true } });
  const direct = groups.filter((g) => !g.jid.endsWith("@g.us"));
  console.log(`direct coaching chats the gateway has opened: ${direct.length ? direct.map((g) => g.subject).join(", ") : "none yet — a coach's first direct message to the ops number opens one"}`);
  const msgs = await prisma.waMessage.findMany({ where: { groupId: { in: groups.map((g) => g.id) }, direction: "IN", ts: { gte: new Date(Date.now() - 3_600_000) } }, orderBy: { ts: "desc" }, take: 300, select: { ts: true, sender: true, senderJid: true, text: true, replyToWaId: true, groupId: true } });
  const byGroup = new Map(groups.map((g) => [g.id, g]));
  const phones = new Set(coaches.map((c) => (c.phone ?? "").slice(-10)).filter(Boolean));
  const mine = msgs.filter((m) => isCoach(m.sender, m.senderJid) || phones.has((m.senderJid ?? "").split("@")[0].split(":")[0].slice(-10)) || coaches.some((c) => m.sender.toLowerCase().includes(c.name.toLowerCase().split(" ")[0])));
  if (!mine.length) { console.log("no messages in the last hour from anyone who looks like a coach (by phone, LID or name)"); return; }
  console.log(`\nlast hour, messages from coaches (newest first):`);
  for (const m of mine.slice(0, 15)) {
    const g = byGroup.get(m.groupId)!;
    const matched = !!isCoach(m.sender, m.senderJid);
    const ours = m.replyToWaId ? await prisma.waOutbound.findFirst({ where: { sentWaMsgId: m.replyToWaId }, select: { id: true } }) : null;
    const prefixed = (g.role === "INTERNAL" && prefix.test(m.text ?? "")) || !g.jid.endsWith("@g.us");
    const verdict = !matched ? `NOT MATCHED as a coach — sender jid ${m.senderJid ?? "?"} (a LID the identity table cannot map to the roster phone; add the LID digits as an alias, or write from the phone number)`
      : ours ? "taken: reply to an agent message" : prefixed ? (g.jid.endsWith("@g.us") ? "taken: prefixed, in the internal group" : "taken: direct message to the ops number")
      : g.role === "INTERNAL" ? `ignored: in the internal group but no "bot:" / "${settings?.agentName ?? "name"}:" prefix and not a reply to an agent message`
      : "ignored: not a reply to one of the agent's messages (replying to a person's message or writing fresh in a store/lab group is not coaching)";
    console.log(`  ${m.ts.toLocaleTimeString("en-IN", { timeZone: process.env.TIMEZONE || "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} ${g.subject.slice(0, 24).padEnd(24)} ${m.sender.slice(0, 18).padEnd(18)} | ${(m.text ?? "").replace(/\s+/g, " ").slice(0, 60)}\n      → ${verdict}`);
  }
}

async function main() {
  const [mode, arg] = process.argv.slice(2);
  if (mode === "why") return why();
  if (mode === "retire" && arg) {
    const row = await prisma.agentCoaching.findFirst({ where: { status: "ACTIVE", id: { endsWith: arg } }, select: { id: true, text: true } });
    if (!row) { console.log("no active lesson ending in", arg); return; }
    await prisma.agentCoaching.update({ where: { id: row.id }, data: { status: "RETIRED", retiredAt: new Date() } });
    console.log("retired:", row.text.slice(0, 100)); return;
  }
  const rows = await prisma.agentCoaching.findMany({ where: mode === "all" ? {} : { OR: [{ status: "ACTIVE" }, { status: "COMMAND", createdAt: { gte: new Date(Date.now() - 86_400_000) } }] }, orderBy: { createdAt: "desc" }, take: 100 });
  if (!rows.length) { console.log("no coaching yet — tick 'coach' on a team member on Connections › Team, then reply to one of the agent's messages or write 'bot: …' in the internal group"); return; }
  for (const r of rows) {
    const l = r.lesson as { kind?: string; rule?: string; command?: unknown; done?: { note?: string } } | null;
    console.log(`${r.createdAt.toLocaleString("en-IN", { timeZone: process.env.TIMEZONE || "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}  ${r.status.padEnd(7)} ${r.scope.padEnd(10)} #${r.id.slice(-6)}  ${r.contactName}`);
    console.log(`    said:  ${r.text.slice(0, 160)}`);
    if (l?.rule) console.log(`    rule:  [${l.kind}] ${l.rule}`);
    const mute = (l as { mute?: { template?: string | null; intent?: string | null } } | null)?.mute;
    if (mute?.template || mute?.intent) console.log(`    muted: ${mute.template ?? mute.intent} in ${r.scope} is handed to a person until this lesson is retired`);
    if (l?.done) console.log(`    did:   ${l.done.note}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
