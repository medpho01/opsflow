/**
 * Where a re-collection (or any store → lab → store) request stopped (30 Oct 2026). Per order, in
 * time order: the store's messages, the agent's decisions, what went to the lab, every message in
 * the lab's group after our ask (quoted or not), the facts read from them and how they were tied to
 * the order, and what reached the store. Read-only.
 *
 *   docker compose -f docker-compose.yml -f docker-compose.wa.yml exec -T app npx tsx scripts/recollect-trace.ts 95123
 */
import prisma from "@/lib/db/client";

const TZ = process.env.TIMEZONE || "Asia/Kolkata";
const t = (d: Date) => d.toLocaleString("en-IN", { timeZone: TZ, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const short = (s: string | null | undefined, n = 140) => (s ?? "").replace(/\s+/g, " ").slice(0, n);

async function trace(orderId: number) {
  const since = new Date(Date.now() - 3 * 86_400_000);
  const rows: Array<{ at: Date; line: string }> = [];
  const add = (at: Date, line: string) => rows.push({ at, line });

  const mentions = await prisma.waMessage.findMany({ where: { orderIds: { has: orderId }, ts: { gte: since } }, include: { group: { select: { role: true, subject: true } } }, orderBy: { ts: "asc" } });
  for (const m of mentions) add(m.ts, `${m.group.role === "PROVIDER" ? "LAB grp" : "STORE grp"} ${m.fromMe ? "[us]" : m.sender} (${m.intent ?? "—"}) "${short(m.text)}"`);

  const actions = await prisma.agentAction.findMany({ where: { orderId, createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
  for (const a of actions) {
    const p = a.params as Record<string, unknown>;
    add(a.createdAt, `action ${a.desk} ${a.action}${p.intent ? `/${p.intent}` : ""}${p.template ? `/${p.template}` : ""} → ${a.outcome}${a.blockedBy ? ` (${short(a.blockedBy, 80)})` : ""} — ${short(a.reason, 100)}`);
  }

  const outbox = await prisma.agentOutboxItem.findMany({ where: { orderId, createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
  for (const o of outbox) add(o.createdAt, `outbox ${o.ask} to ${o.counterparty} → ${o.status}`);

  const batches = (await prisma.$queryRawUnsafe<Array<{ id: string; labId: number; intent: string; createdAt: Date; outboundId: string | null; text: string }>>(
    `SELECT id, "labId", intent, "createdAt", "outboundId", text FROM provider_batches WHERE "createdAt" >= $1 AND shadow = false AND items @> $2::jsonb ORDER BY "createdAt"`, since, JSON.stringify([{ orderId }])));
  for (const b of batches) {
    const out = b.outboundId ? await prisma.waOutbound.findUnique({ where: { id: b.outboundId }, select: { status: true, sentWaMsgId: true, groupId: true, error: true } }) : null;
    add(b.createdAt, `SENT TO LAB ${b.labId} ${b.intent} (${out?.status ?? "no outbound"}${out?.error ? ` ${short(out.error, 60)}` : ""}) "${short(b.text, 120)}"`);
    // Everything the lab group said in the 12 h after our ask: did they quote it, name the order, or neither?
    if (out?.groupId) {
      const after = await prisma.waMessage.findMany({ where: { groupId: out.groupId, ts: { gt: b.createdAt, lte: new Date(b.createdAt.getTime() + 12 * 3_600_000) }, fromMe: false }, orderBy: { ts: "asc" }, take: 40 });
      for (const m of after) {
        const quotes = m.replyToWaId && m.replyToWaId === out.sentWaMsgId ? "QUOTES our ask" : m.replyToWaId ? "quotes other msg" : "no quote";
        const names = m.orderIds.includes(orderId) ? "names order" : m.refIds.length ? `refs ${m.refIds.join(",")}` : "no id";
        add(m.ts, `  lab grp ${m.sender} [${quotes} · ${names}${m.mediaType ? ` · ${m.mediaType}` : ""}] "${short(m.text)}"`);
      }
    }
  }

  const facts = await prisma.providerOrderFact.findMany({ where: { orderId, createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
  for (const f of facts) add(f.createdAt, `fact ${f.kind}="${short(f.value, 80)}" via ${f.attributedBy ?? "—"} (${f.extractor}, ${f.confidence})`);

  const journey = await prisma.agentJourney.findUnique({ where: { orderId }, select: { id: true } });
  if (journey) {
    const evs = await prisma.agentJourneyEvent.findMany({ where: { journeyId: journey.id, at: { gte: since }, kind: { in: ["fact", "promise"] } }, orderBy: { at: "asc" } });
    for (const e of evs) {
      const p = e.payload as Record<string, unknown>;
      add(e.at, `journey ${e.kind} ${p.kind ?? ""} applied=${e.applied} context="${short(p.context as string, 70)}"`);
    }
  }

  console.log(`\n#${orderId}`);
  for (const r of rows.sort((a, b) => a.at.getTime() - b.at.getTime())) console.log(`  ${t(r.at)}  ${r.line}`);
}

async function main() {
  const ids = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) { console.log("usage: scripts/recollect-trace.ts <orderId> [orderId …]"); return; }
  for (const id of ids) await trace(id);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
