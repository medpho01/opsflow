/**
 * The agent's coaching from WhatsApp (28 Oct 2026): what the head of ops told it, and what it
 * made of each. Read-only unless asked to retire.
 *
 *   npx tsx scripts/coaching.ts            the ACTIVE lessons and today's commands
 *   npx tsx scripts/coaching.ts all        including retired
 *   npx tsx scripts/coaching.ts retire <id-suffix>
 */
import prisma from "@/lib/db/client";

async function main() {
  const [mode, arg] = process.argv.slice(2);
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
    if (l?.done) console.log(`    did:   ${l.done.note}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
