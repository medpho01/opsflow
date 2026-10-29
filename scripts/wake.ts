/**
 * Check orders now instead of at their next scheduled check (29 Oct 2026): after a fix, to see it
 * act on a known order without waiting up to an hour. Does exactly what the worker's check does —
 * the same rules, guard and caps; queued messages go out with the next flush.
 *
 *   docker compose -f docker-compose.yml -f docker-compose.wa.yml exec -T app npx tsx scripts/wake.ts 92602 91771
 */
import prisma from "@/lib/db/client";
import { wakeJourney } from "@/lib/agents/journey/run";

async function main() {
  const ids = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) { console.log("usage: scripts/wake.ts <orderId> [orderId …]"); return; }
  for (const id of ids) {
    const r = await wakeJourney(id, "person").catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    console.log(`#${id}`, JSON.stringify(r));
    const since = new Date(Date.now() - 2 * 60_000);
    const fresh = await prisma.agentAction.findMany({ where: { orderId: id, createdAt: { gte: since } }, orderBy: { createdAt: "asc" }, select: { desk: true, action: true, outcome: true, blockedBy: true, reason: true } });
    for (const a of fresh) console.log(`   ${a.desk} ${a.action} → ${a.outcome}${a.blockedBy ? ` (${a.blockedBy.slice(0, 80)})` : ""} — ${a.reason.slice(0, 120)}`);
    // An ask revived from "withdrawn" keeps its first row; its outbox item shows it is queued again.
    const queued = await prisma.agentOutboxItem.findMany({ where: { orderId: id, status: "QUEUED" }, select: { counterparty: true, ask: true, windowFrom: true, windowTo: true } });
    for (const q of queued) console.log(`   queued: ${q.ask} to ${q.counterparty} · window ${q.windowFrom.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} – ${q.windowTo.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`);
    if (!fresh.length && !queued.length) console.log("   nothing to do on this check");
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
