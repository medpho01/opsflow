/**
 * Is a store's desk ready to go LIVE? Replays the store desk's SHADOW record
 * against what the team actually did in the store's group. Read-only.
 *
 * For every store message (questions, not acks) in the last N days:
 *   what the bot would have said, and how soon · what the team said, and how soon
 *   → both / team only (the bot missed it) / bot only / neither
 * Then: proactive alerts the bot would have sent, actions held for review or
 * blocked (and why), and any action on an order that is not this store's.
 *
 * The detail names orders and quotes chats — read it on the VM, don't paste
 * it. The SUMMARY at the end has counts only and is safe to share.
 *
 *   docker compose exec -T app npx tsx scripts/store-desk-readiness.ts 6        # store 6, last 3 days
 *   docker compose exec -T app npx tsx scripts/store-desk-readiness.ts 6 7      # last 7 days
 *   docker compose exec -T app npx tsx scripts/store-desk-readiness.ts 6 3 --summary   # counts only
 */
import prisma from "@/lib/db/client";
import { fetchOrderSnapshots } from "@/lib/agents/journey/window";
import { renderStoreText } from "@/lib/agents/executors/storeReply";
import { isAutomated, loadTeam, makeTeamMatcher } from "@/lib/wa/team";
import type { ProposedAction } from "@/lib/agents/journey/step";

const TZ = process.env.TIMEZONE || "Asia/Kolkata";
const t = (d: Date) => d.toLocaleString("en-IN", { timeZone: TZ, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const MIN = 60_000;
const STORE_ACTIONS = ["store_reply", "store_alert", "store_warning", "ack", "create_task"];
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const one = (s: string, n = 140) => s.replace(/\s+/g, " ").trim().slice(0, n);

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const summaryOnly = process.argv.includes("--summary");
  const storeId = Number(args[0]);
  const days = Number(args[1] ?? 3);
  if (!storeId) { console.log("usage: npx tsx scripts/store-desk-readiness.ts <storeId> [days] [--summary]"); return; }
  const now = new Date(); const since = new Date(now.getTime() - days * 24 * 60 * MIN);
  const say = (s: string) => { if (!summaryOnly) console.log(s); };

  const groups = await prisma.waGroup.findMany({ where: { role: "SUPPORT", storeId }, select: { id: true, subject: true } });
  if (!groups.length) { console.log(`store ${storeId}: no connected store group`); return; }
  const desk = await prisma.agentDeskState.findUnique({ where: { desk_scopeKind_scopeId: { desk: "STORE", scopeKind: "STORE", scopeId: storeId } } }).catch(() => null);
  const isTeam = makeTeamMatcher(await loadTeam());

  const msgs = await prisma.waMessage.findMany({
    where: { groupId: { in: groups.map((g) => g.id) }, ts: { gte: since } },
    orderBy: { ts: "asc" },
    select: { id: true, waMsgId: true, ts: true, fromMe: true, sender: true, senderJid: true, text: true, intent: true, orderIds: true },
  });
  const team = msgs.filter((m) => !isAutomated(m) && (m.fromMe || !!isTeam(m.sender, m.senderJid)) && m.text?.trim());
  const questions = msgs.filter((m) => !m.fromMe && !isTeam(m.sender, m.senderJid) && !isAutomated(m) && m.intent?.startsWith("STORE_") && !["STORE_NOISE"].includes(m.intent) && m.text?.trim());

  const actions = await prisma.agentAction.findMany({
    where: { desk: "STORE", action: { in: STORE_ACTIONS }, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { id: true, orderId: true, action: true, params: true, reason: true, level: true, outcome: true, blockedBy: true, createdAt: true, idemKey: true },
  });
  const mine = actions.filter((a) => (a.params as { storeId?: number })?.storeId === storeId || (a.params as { storeId?: number })?.storeId == null);
  const orderIds = [...new Set([...mine.map((a) => a.orderId).filter((x): x is number => x != null), ...questions.flatMap((q) => q.orderIds)])];
  const snaps = await fetchOrderSnapshots(orderIds);
  const askedForId = new Set((await prisma.agentOutboxItem.findMany({ where: { counterparty: `STORE:${storeId}`, idemKey: { startsWith: "askid:" }, createdAt: { gte: since } }, select: { idemKey: true } })).map((o) => o.idemKey.slice(6)));

  const text = async (a: (typeof mine)[number]) => {
    const o = a.orderId != null ? snaps.get(a.orderId) : undefined;
    if (a.action === "create_task") return `[task] ${one(String((a.params as { action?: string }).action ?? a.reason))}`;
    return one(await renderStoreText({ desk: "STORE", action: a.action, params: a.params as Record<string, unknown>, reason: a.reason, idemKey: a.idemKey ?? "" } as unknown as ProposedAction, { orderId: a.orderId ?? 0, labName: o?.labName ?? null, appointmentTime: o?.appointmentTime ?? null, patientName: o?.patientName ?? null }).catch(() => a.reason), 200);
  };

  // ── 1. Store questions: bot vs team ──
  say(`\n━━━ ${groups[0].subject ?? `store ${storeId}`} · desk ${desk?.state ?? "OFF"} · last ${days} day(s) ━━━`);
  say(`\n1. STORE QUESTIONS — what the bot would have said vs what the team said\n`);
  const tally = { both: 0, teamOnly: 0, botOnly: 0, neither: 0, botFaster: 0 };
  const teamLatency: number[] = []; const botLatency: number[] = [];
  const missed: string[] = [];
  const usedActions = new Set<string>();
  for (const q of questions) {
    const ids = q.orderIds;
    const bot = mine.filter((a) => a.action !== "create_task" && a.createdAt >= new Date(q.ts.getTime() - MIN) && a.createdAt <= new Date(q.ts.getTime() + 20 * MIN)
      && ((a.orderId != null && ids.includes(a.orderId)) || (a.idemKey ?? "").includes(q.waMsgId)));
    bot.forEach((a) => usedActions.add(a.id));
    const askedId = askedForId.has(q.id);
    const reply = team.find((m) => m.ts > q.ts && m.ts.getTime() - q.ts.getTime() <= 60 * MIN && (!ids.length || m.orderIds.some((x) => ids.includes(x)) || m.ts.getTime() - q.ts.getTime() <= 15 * MIN));
    const botAt = bot[0]?.createdAt ?? null;
    const botSaid = bot.length > 0 || askedId;
    if (reply) teamLatency.push((reply.ts.getTime() - q.ts.getTime()) / MIN);
    if (botAt) botLatency.push(Math.max(0, (botAt.getTime() - q.ts.getTime()) / MIN));
    const kind = botSaid && reply ? "both" : reply ? "teamOnly" : botSaid ? "botOnly" : "neither";
    tally[kind] += 1;
    if (botAt && reply && botAt < reply.ts) tally.botFaster += 1;
    if (kind === "teamOnly") missed.push(`${t(q.ts)} ${ids.length ? `#${ids.join(",#")}` : "(no order id)"} [${q.intent}]`);
    const label = { both: "both answered", teamOnly: "BOT MISSED — team answered", botOnly: "bot only — team silent", neither: "NOBODY answered" }[kind];
    say(`${t(q.ts)}  ${ids.length ? `#${ids.join(",#")}` : "(no id)"}  [${(q.intent ?? "").replace("STORE_", "").toLowerCase()}]  ${label}`);
    say(`   store: ${one(q.text)}`);
    for (const a of bot) say(`   bot (${Math.round((a.createdAt.getTime() - q.ts.getTime()) / MIN)} min, ${a.outcome}${a.blockedBy ? ` — ${one(a.blockedBy, 60)}` : ""}): ${await text(a)}`);
    if (askedId && !bot.length) say(`   bot: asks for the order id`);
    if (reply) say(`   team (${Math.round((reply.ts.getTime() - q.ts.getTime()) / MIN)} min): ${one(reply.text)}`);
    say("");
  }

  // ── 2. Proactive: alerts the bot would have sent without being asked ──
  const proactive = mine.filter((a) => !usedActions.has(a.id) && ["store_alert", "store_warning"].includes(a.action));
  say(`\n2. PROACTIVE — told the store before it asked (${proactive.length})\n`);
  let teamAlsoTold = 0;
  for (const a of proactive) {
    const teamSaid = team.find((m) => a.orderId != null && m.orderIds.includes(a.orderId) && Math.abs(m.ts.getTime() - a.createdAt.getTime()) <= 2 * 60 * MIN);
    const storeAsked = questions.find((q) => a.orderId != null && q.orderIds.includes(a.orderId) && q.ts > a.createdAt && q.ts.getTime() - a.createdAt.getTime() <= 3 * 60 * MIN);
    if (teamSaid) teamAlsoTold += 1;
    say(`${t(a.createdAt)}  #${a.orderId}  ${a.action} ${a.outcome}${a.blockedBy ? ` (${one(a.blockedBy, 60)})` : ""}`);
    say(`   bot: ${await text(a)}`);
    if (teamSaid) say(`   team also (${Math.round((teamSaid.ts.getTime() - a.createdAt.getTime()) / MIN)} min): ${one(teamSaid.text)}`);
    if (storeAsked) say(`   store asked later (${Math.round((storeAsked.ts.getTime() - a.createdAt.getTime()) / MIN)} min) — the alert would have answered it first`);
  }

  // ── 3. Held or blocked, and why ──
  const held = mine.filter((a) => a.outcome === "REVIEW" || a.outcome === "BLOCKED" || a.outcome === "FAILED");
  const reasons = new Map<string, number>();
  for (const a of held) { const k = `${a.action} ${a.outcome}: ${one(a.blockedBy ?? "—", 70)}`; reasons.set(k, (reasons.get(k) ?? 0) + 1); }

  // ── 4. Wrong store ──
  const wrong = mine.filter((a) => a.orderId != null && snaps.get(a.orderId) && snaps.get(a.orderId)!.storeId !== storeId);
  if (wrong.length) { say(`\n4. ORDERS NOT THIS STORE'S (${wrong.length}) — would have gone to the wrong group`); for (const a of wrong) say(`   #${a.orderId} ${a.action} ${t(a.createdAt)}`); }

  // ── Summary (counts only — safe to share) ──
  const n = questions.length;
  const pct = (x: number) => (n ? `${Math.round((100 * x) / n)}%` : "—");
  const tm = median(teamLatency); const bm = median(botLatency);
  console.log(`\n━━━ SUMMARY · store ${storeId} · desk ${desk?.state ?? "OFF"} · last ${days} day(s) ━━━`);
  console.log(`Store questions:            ${n}`);
  console.log(`  bot and team both:        ${tally.both} (${pct(tally.both)})`);
  console.log(`  team only — bot MISSED:   ${tally.teamOnly} (${pct(tally.teamOnly)})`);
  console.log(`  bot only — team silent:   ${tally.botOnly} (${pct(tally.botOnly)})`);
  console.log(`  neither answered:         ${tally.neither} (${pct(tally.neither)})`);
  console.log(`  bot first, where both:    ${tally.botFaster} of ${tally.both}`);
  console.log(`Median reply time:          bot ${bm == null ? "—" : `${Math.round(bm)} min`} · team ${tm == null ? "—" : `${Math.round(tm)} min`}`);
  console.log(`Proactive alerts:           ${proactive.length} (team also told the store about ${teamAlsoTold})`);
  console.log(`Held for review / blocked:  ${held.length}`);
  for (const [k, v] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${String(v).padStart(3)}  ${k}`);
  console.log(`Wrong-store actions:        ${wrong.length}`);
  if (missed.length) { console.log(`Missed (team answered, bot would not):`); for (const m of missed.slice(0, 15)) console.log(`  ${m}`); }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
