/**
 * Why did (or didn't) the agent ask a lab about these orders? Takes order ids
 * or lab references (BLR6352861, VL336FC5, 19463571) and prints, per order:
 * what LabStack says, the journey's next checkpoint and when it is due, the
 * desk state, what the agent decided and queued, and the rule holding an ask.
 * Read-only.
 *
 *   docker compose exec -T app npx tsx scripts/why-not-asked.ts BLR6352861 19463571 19417838
 */
import prisma from "@/lib/db/client";
import { labstackWorkerQuery } from "@/lib/db/labstack";
import { loadDirectory, tierOf } from "@/lib/agents/directory";
import { loadGuardState } from "@/lib/agents/guard/guard";
import { consoleIsLive } from "@/lib/agents/journey/step";
import { fetchOrderSnapshots } from "@/lib/agents/journey/window";
import { isSlotOpen, nextSlot } from "@/lib/provider-rules/batching";

const TZ = process.env.TIMEZONE || "Asia/Kolkata";
const t = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleString("en-IN", { timeZone: TZ, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—");

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) { console.log("usage: npx tsx scripts/why-not-asked.ts <orderId | lab reference> ..."); return; }
  const nums = args.filter((a) => /^\d{5,6}$/.test(a)).map(Number);
  const refs = args.filter((a) => !/^\d{5,6}$/.test(a)).map((a) => a.toUpperCase());
  const byRef = refs.length ? await labstackWorkerQuery<{ id: number; ref: string }>(`SELECT id, upper("labOrderId") AS ref FROM public."Order" WHERE upper("labOrderId") = ANY($1::text[])`, [refs]) : [];
  for (const r of refs) if (!byRef.some((x) => x.ref === r)) console.log(`\n${r}: no order in LabStack with that lab reference`);
  const ids = [...nums, ...byRef.map((r) => r.id)];
  const [snaps, dir, state] = await Promise.all([fetchOrderSnapshots(ids), loadDirectory(), loadGuardState()]);
  const now = new Date();

  for (const id of ids) {
    const o = snaps.get(id);
    console.log(`\n━━━ #${id}${o?.labRef ? ` · ${o.labRef}` : ""} · ${o?.labName ?? "?"}`);
    if (!o) { console.log("   not in the active window (closed, cancelled or older than a week)"); continue; }
    const tier = tierOf(dir, o.labId);
    const desk = state.desks.get(`LAB:LAB:${o.labId}`) ?? "OFF";
    console.log(`   LabStack: ${o.orderStatus} (updated ${t(o.statusUpdatedAt)}) · visit ${t(o.appointmentTime)} · lab tier ${tier} · lab desk ${desk}`);
    const j = await prisma.agentJourney.findUnique({ where: { orderId: id }, include: { checkpoints: { orderBy: { dueAt: "asc" } } } });
    if (!j) { console.log("   no journey yet — the sweep has not opened it"); continue; }
    if (j.closedAt) { console.log(`   journey closed: ${j.closeReason}`); continue; }
    const next = j.checkpoints.find((c) => c.status === "PENDING" || c.status === "BREACHED");
    console.log(`   journey: ${j.stage} · health ${j.health}${next ? ` · next: ${next.name} due ${t(next.dueAt)} (${next.status})` : " · nothing open"}`);
    const actions = await prisma.agentAction.findMany({ where: { orderId: id, createdAt: { gte: new Date(now.getTime() - 36 * 3_600_000) } }, orderBy: { createdAt: "desc" }, take: 5, select: { createdAt: true, desk: true, action: true, outcome: true, blockedBy: true, reason: true } });
    for (const a of actions) console.log(`   ${t(a.createdAt)}  ${a.desk} ${a.action} → ${a.outcome}${a.blockedBy ? ` (${a.blockedBy})` : ""} — ${a.reason.slice(0, 90)}`);
    const queued = await prisma.agentOutboxItem.findMany({ where: { orderId: id, createdAt: { gte: new Date(now.getTime() - 36 * 3_600_000) } }, orderBy: { createdAt: "desc" }, take: 5, select: { ask: true, status: true, windowFrom: true, sentAt: true, urgent: true } });
    for (const q of queued) console.log(`   outbox: ${q.ask} ${q.status}${q.sentAt ? ` at ${t(q.sentAt)}` : ` · window opens ${t(q.windowFrom)}`}${q.urgent ? " · urgent" : ""}`);

    // The rule holding an ask, most specific first.
    const why: string[] = [];
    if (desk === "OFF") why.push("the lab's desk is OFF — the agent does not act for this lab");
    if (desk === "SHADOW") why.push("the lab's desk is in SHADOW — asks are recorded, not sent");
    if (consoleIsLive(o, tier, now)) why.push(`LabStack updated this order at ${t(o.statusUpdatedAt)}, around the visit — for an API lab the console is the answer, no WhatsApp ask`);
    const h = Number(now.toLocaleString("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }));
    if (h < 7 || h >= 21) why.push("night hold: nothing is sent between 21:00 and 07:00");
    if (next && next.dueAt.getTime() > now.getTime()) why.push(`the next checkpoint (${next.name}) is not due until ${t(next.dueAt)}`);
    const pending = queued.find((q) => q.status === "QUEUED");
    if (pending && !pending.urgent && !isSlotOpen(pending.ask, now, TZ)) why.push(`a ${pending.ask} ask is queued for its next slot, ${t(nextSlot(pending.ask, now, TZ))}`);
    const g = dir.labs.get(o.labId ?? -1)?.groupId;
    if (g) {
      const said = await prisma.waMessage.findFirst({ where: { groupId: g, ts: { gte: new Date(now.getTime() - 2 * 3_600_000) }, OR: [{ orderIds: { has: id } }, ...(o.labRef ? [{ text: { contains: o.labRef } }] : [])] }, orderBy: { ts: "desc" }, select: { ts: true, sender: true } });
      if (said) why.push(`${said.sender} wrote about it in the lab's group at ${t(said.ts)} — not asked again for 2 h`);
    }
    if (!actions.length && !queued.length && !why.length) why.push("no rule fired: nothing is late yet by the SOP's timings");
    console.log(`   → ${why.join("\n   → ")}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
