/**
 * How well the agent works each lab (2 Nov 2026): where it succeeds and where it fails, over the
 * last N days of visits (default 7). Read-only; prints order ids and counts, never patient data.
 *
 * Per lab:
 *   outcome     visits collected on time (≤ 60 min after the slot), late, missed, stuck (no
 *               collection 2 h after the slot and not cancelled), cancelled or moved
 *   asks        what the agent sent the lab, and whether the lab answered — a fact read from its
 *               group, a quoted reply, or (API labs) the console moving — with the median reply
 *   coverage    of the late, missed and stuck orders: how many the agent asked about before or
 *               near the slot, late, or never
 *   by hand     orders our team chased in the lab group themselves: with no agent ask before
 *               (the agent missed it) or after an agent ask went unanswered (the lab ignored it)
 *   store loop  store requests on the lab's orders: answered by the agent, by a person, or nobody
 *
 *   docker compose -f docker-compose.yml -f docker-compose.wa.yml exec -T app npx tsx scripts/lab-effectiveness.ts      # 7 days
 *   … scripts/lab-effectiveness.ts 3            # 3 days
 *   … scripts/lab-effectiveness.ts 7 14         # one lab, with its order lists
 */
import prisma from "@/lib/db/client";
import { loadDirectory } from "@/lib/agents/directory";
import { isAutomated, loadTeam, makeTeamMatcher } from "@/lib/wa/team";

const TZ = process.env.TIMEZONE || "Asia/Kolkata";
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const ON_TIME_MIN = 60;
const STUCK_AFTER_MIN = 120;

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");
const mins = (v: number | null) => (v == null ? "—" : v < 90 ? `${Math.round(v)} min` : `${(v / 60).toFixed(1)} h`);
const ids = (xs: number[], n = 12) => (xs.length ? xs.slice(0, n).map((x) => `#${x}`).join(" ") + (xs.length > n ? ` … +${xs.length - n}` : "") : "");

type Outcome = "on_time" | "late" | "missed" | "stuck" | "cancelled" | "moved" | "upcoming" | "unknown";

async function main() {
  const days = Number(process.argv[2] ?? 7);
  const only = process.argv[3] ? Number(process.argv[3]) : null;
  const now = new Date();
  const start = new Date(now.getTime() - days * DAY);
  const dir = await loadDirectory(true);
  const isTeam = makeTeamMatcher(await loadTeam());

  const journeys = await prisma.agentJourney.findMany({
    where: { labId: only ?? { not: null }, consoleSnapshot: { path: ["appointmentTime"], gte: start.toISOString() } },
    select: { id: true, orderId: true, labId: true, storeId: true, consoleSnapshot: true, checkpoints: { select: { name: true, status: true, metAt: true } }, events: { where: { kind: { in: ["console_change", "store_message"] } }, select: { kind: true, at: true, payload: true } } },
  });
  const visitOf = (s: unknown) => { const v = (s as { appointmentTime?: string | null } | null)?.appointmentTime; return v ? new Date(v) : null; };
  const rows = journeys.filter((j) => { const v = visitOf(j.consoleSnapshot); return v && v >= start && v <= now; });
  const orderIds = rows.map((j) => j.orderId);
  console.log(`Lab effectiveness — visits ${start.toLocaleDateString("en-IN", { timeZone: TZ, day: "numeric", month: "short" })} to now (${days} d): ${rows.length} orders across ${new Set(rows.map((r) => r.labId)).size} labs\n`);
  if (!rows.length) return;

  const [items, facts, groupMsgs] = await Promise.all([
    prisma.agentOutboxItem.findMany({ where: { orderId: { in: orderIds }, createdAt: { gte: new Date(start.getTime() - DAY) } }, select: { orderId: true, counterparty: true, ask: true, status: true, sentAt: true, createdAt: true, outboundId: true, payload: true } }),
    prisma.providerOrderFact.findMany({ where: { orderId: { in: orderIds }, createdAt: { gte: new Date(start.getTime() - DAY) } }, select: { orderId: true, kind: true, createdAt: true } }),
    prisma.waMessage.findMany({ where: { ts: { gte: new Date(start.getTime() - DAY) }, OR: [{ orderIds: { hasSome: orderIds } }] }, select: { ts: true, fromMe: true, sender: true, senderJid: true, intent: true, orderIds: true, replyToWaId: true, group: { select: { role: true, labId: true } } } }),
  ]);
  const outbounds = await prisma.waOutbound.findMany({ where: { id: { in: items.map((i) => i.outboundId).filter((x): x is string => !!x) } }, select: { id: true, sentWaMsgId: true } });
  const sentWa = new Map(outbounds.map((o) => [o.id, o.sentWaMsgId]));
  const quotedReplies = await prisma.waMessage.findMany({ where: { replyToWaId: { in: outbounds.map((o) => o.sentWaMsgId).filter((x): x is string => !!x) }, fromMe: false }, select: { replyToWaId: true, ts: true } });
  const firstQuoted = new Map<string, Date>();
  for (const q of quotedReplies.sort((a, b) => a.ts.getTime() - b.ts.getTime())) if (q.replyToWaId && !firstQuoted.has(q.replyToWaId)) firstQuoted.set(q.replyToWaId, q.ts);

  const by = <T extends { orderId: number }>(xs: T[]) => { const m = new Map<number, T[]>(); for (const x of xs) m.set(x.orderId, [...(m.get(x.orderId) ?? []), x]); return m; };
  const itemsBy = by(items); const factsBy = by(facts);
  const msgsBy = new Map<number, typeof groupMsgs>();
  for (const m of groupMsgs) for (const id of m.orderIds) msgsBy.set(id, [...(msgsBy.get(id) ?? []), m]);
  const person = (m: (typeof groupMsgs)[number]) => (m.fromMe ? !isAutomated(m) && m.intent !== "CONSOLE" : !!isTeam(m.sender, m.senderJid));

  type Lab = {
    orders: number; outcome: Record<Outcome, number[]>;
    asks: number; answered: number; within30: number; replyMins: number[]; unanswered: number[]; dropped: number; byAsk: Map<string, { sent: number; answered: number }>; answeredBy: Record<string, number>;
    problem: number; askedEarly: number[]; askedLate: number[]; neverAsked: number[];
    handNoAsk: number[]; handAfterAsk: number[];
    storeAsks: number; storeByAgent: number; storeByPerson: number; storeNobody: number[];
  };
  const labs = new Map<number, Lab>();
  const lab = (id: number) => labs.get(id) ?? labs.set(id, { orders: 0, outcome: { on_time: [], late: [], missed: [], stuck: [], cancelled: [], moved: [], upcoming: [], unknown: [] }, asks: 0, answered: 0, within30: 0, replyMins: [], unanswered: [], dropped: 0, byAsk: new Map(), answeredBy: { lab: 0, quote: 0, console: 0 }, problem: 0, askedEarly: [], askedLate: [], neverAsked: [], handNoAsk: [], handAfterAsk: [], storeAsks: 0, storeByAgent: 0, storeByPerson: 0, storeNobody: [] }).get(id)!;

  for (const j of rows) {
    const L = lab(j.labId!); L.orders += 1;
    const visit = visitOf(j.consoleSnapshot)!;
    const status = String((j.consoleSnapshot as { orderStatus?: string }).orderStatus ?? "");
    const cp = (n: string) => j.checkpoints.find((c) => c.name === n);
    const collected = [cp("sample_collected"), cp("patient_visited")].find((c) => c?.status === "MET")?.metAt ?? null;
    const missed = status === "PATIENT_MISSED" || j.events.some((e) => e.kind === "console_change" && (e.payload as { to?: { status?: string } })?.to?.status === "PATIENT_MISSED");
    let o: Outcome;
    if (collected) o = collected.getTime() - visit.getTime() <= ON_TIME_MIN * MIN ? "on_time" : "late";
    else if (["CANCELED", "CANCELLED"].includes(status)) o = "cancelled";
    else if (missed) o = "missed";
    else if (status === "RESCHEDULED") o = "moved";
    else if (["REPORT_DELIVERED", "SAMPLE_COLLECTED", "SAMPLE_RECEIVED", "REPORT_GENERATED", "PARTIAL_REPORT_DELIVERED"].includes(status)) o = "on_time"; // collected, but the checkpoint was not stamped
    else if (now.getTime() - visit.getTime() < STUCK_AFTER_MIN * MIN) o = "upcoming";
    else o = "stuck";
    L.outcome[o].push(j.orderId);

    // What the agent asked the lab about this order, and whether it was answered.
    const mine = (itemsBy.get(j.orderId) ?? []).filter((i) => i.counterparty === `LAB:${j.labId}`);
    const sent = mine.filter((i) => i.status === "SENT" && i.sentAt).sort((a, b) => a.sentAt!.getTime() - b.sentAt!.getTime());
    L.dropped += mine.filter((i) => i.status === "DROPPED" || i.status === "WITHDRAWN").length;
    const consoleMoves = j.events.filter((e) => e.kind === "console_change").map((e) => e.at);
    for (const i of sent) {
      const at = i.sentAt!;
      const fact = (factsBy.get(j.orderId) ?? []).map((f) => f.createdAt).filter((t) => t > at && t.getTime() - at.getTime() <= DAY).sort((a, b) => a.getTime() - b.getTime())[0];
      const qw = i.outboundId ? sentWa.get(i.outboundId) : null;
      const quote = qw ? firstQuoted.get(qw) : undefined;
      const moved = consoleMoves.filter((t) => t > at && t.getTime() - at.getTime() <= 6 * H).sort((a, b) => a.getTime() - b.getTime())[0];
      const cands: Array<[string, Date]> = [["lab", fact], ["quote", quote], ["console", moved]].filter((x): x is [string, Date] => !!x[1] && (x[1] as Date) > at);
      cands.sort((a, b) => a[1].getTime() - b[1].getTime());
      const a = L.byAsk.get(i.ask) ?? L.byAsk.set(i.ask, { sent: 0, answered: 0 }).get(i.ask)!;
      L.asks += 1; a.sent += 1;
      if (cands.length) {
        const m = (cands[0][1].getTime() - at.getTime()) / MIN;
        L.answered += 1; a.answered += 1; L.replyMins.push(m); if (m <= 30) L.within30 += 1; L.answeredBy[cands[0][0]] += 1;
      } else if (now.getTime() - at.getTime() > 2 * H) L.unanswered.push(j.orderId);
    }

    // Did the agent see the trouble coming? Late, missed and stuck orders.
    if (o === "late" || o === "missed" || o === "stuck") {
      L.problem += 1;
      const first = sent[0]?.sentAt;
      if (!first) L.neverAsked.push(j.orderId);
      else if (first.getTime() - visit.getTime() <= 60 * MIN) L.askedEarly.push(j.orderId);
      else L.askedLate.push(j.orderId);
    }

    // Our team chasing the lab by hand.
    const hand = (msgsBy.get(j.orderId) ?? []).filter((m) => m.group.role === "PROVIDER" && person(m) && m.ts >= new Date(visit.getTime() - 12 * H)).sort((a, b) => a.ts.getTime() - b.ts.getTime())[0];
    if (hand) {
      const before = sent.filter((i) => i.sentAt! < hand.ts);
      if (!before.length) L.handNoAsk.push(j.orderId); else L.handAfterAsk.push(j.orderId);
    }

    // The store's requests on this order.
    const storeAsks = j.events.filter((e) => e.kind === "store_message" && !["thanks", "ack", "other"].includes(String((e.payload as { intent?: string }).intent ?? "other")));
    for (const e of storeAsks) {
      L.storeAsks += 1;
      const until = new Date(e.at.getTime() + 2 * H);
      const agent = (itemsBy.get(j.orderId) ?? []).some((i) => i.counterparty.startsWith("STORE:") && i.status === "SENT" && i.sentAt && i.sentAt >= e.at && i.sentAt <= until);
      const human = (msgsBy.get(j.orderId) ?? []).some((m) => m.group.role !== "PROVIDER" && person(m) && m.ts > e.at && m.ts <= until);
      if (agent) L.storeByAgent += 1; else if (human) L.storeByPerson += 1; else if (now.getTime() - e.at.getTime() > 30 * MIN) L.storeNobody.push(j.orderId);
    }
  }

  // ── The table ──
  const sorted = [...labs].sort((a, b) => b[1].orders - a[1].orders);
  console.log("Lab                          tier  orders  on-time  late  missed  stuck | asks  answered  ≤30m  median | problems: early/late/never | by hand: no-ask/after-ask | store: agent/person/nobody");
  for (const [id, L] of sorted) {
    const l = dir.labs.get(id);
    const done = L.orders - L.outcome.upcoming.length - L.outcome.cancelled.length - L.outcome.moved.length;
    console.log(`${(l?.labName ?? `lab ${id}`).slice(0, 28).padEnd(28)} ${(l?.tier ?? "?").padEnd(4)} ${String(L.orders).padStart(6)}  ${pct(L.outcome.on_time.length, done).padStart(7)}  ${String(L.outcome.late.length).padStart(4)}  ${String(L.outcome.missed.length).padStart(6)}  ${String(L.outcome.stuck.length).padStart(5)} | ${String(L.asks).padStart(4)}  ${pct(L.answered, L.asks).padStart(8)}  ${pct(L.within30, L.asks).padStart(4)}  ${mins(median(L.replyMins)).padStart(6)} | ${String(L.problem).padStart(3)}: ${L.askedEarly.length}/${L.askedLate.length}/${L.neverAsked.length} | ${L.handNoAsk.length}/${L.handAfterAsk.length} | ${L.storeAsks}: ${L.storeByAgent}/${L.storeByPerson}/${L.storeNobody.length}`);
  }

  // ── Per lab, in words ──
  for (const [id, L] of sorted) {
    if (L.orders < 3 && !only) continue;
    const l = dir.labs.get(id);
    const done = L.orders - L.outcome.upcoming.length - L.outcome.cancelled.length - L.outcome.moved.length;
    const works: string[] = []; const fails: string[] = [];
    if (done >= 5 && L.outcome.on_time.length / done >= 0.85) works.push(`${pct(L.outcome.on_time.length, done)} of visits collected on time`);
    if (L.asks >= 5 && L.answered / L.asks >= 0.8) works.push(`the lab answers ${pct(L.answered, L.asks)} of our asks (median ${mins(median(L.replyMins))})`);
    if (L.problem >= 3 && L.askedEarly.length / L.problem >= 0.7) works.push(`the agent asked early on ${L.askedEarly.length} of ${L.problem} problem orders`);
    if (L.storeAsks >= 3 && L.storeByAgent / L.storeAsks >= 0.7) works.push(`the agent answered ${L.storeByAgent} of ${L.storeAsks} store requests`);
    if (L.outcome.stuck.length) fails.push(`${L.outcome.stuck.length} stuck past the slot with no collection: ${ids(L.outcome.stuck)}`);
    if (L.neverAsked.length) fails.push(`${L.neverAsked.length} late/missed/stuck orders the agent never asked about: ${ids(L.neverAsked)}`);
    if (L.askedLate.length) fails.push(`${L.askedLate.length} asked more than an hour after the slot: ${ids(L.askedLate)}`);
    if (L.unanswered.length) fails.push(`${L.unanswered.length} asks the lab never answered (orders ${ids([...new Set(L.unanswered)])})`);
    if (L.handNoAsk.length) fails.push(`our team chased ${L.handNoAsk.length} orders by hand before the agent asked: ${ids(L.handNoAsk)}`);
    if (L.handAfterAsk.length) fails.push(`our team re-chased ${L.handAfterAsk.length} orders after an agent ask: ${ids(L.handAfterAsk)}`);
    if (L.storeNobody.length) fails.push(`${L.storeNobody.length} store requests got no reply within 2 h: ${ids(L.storeNobody)}`);
    if (L.storeByPerson) fails.push(`${L.storeByPerson} store requests answered by a person, not the agent`);
    console.log(`\n── ${l?.labName ?? `lab ${id}`} (lab ${id}, tier ${l?.tier ?? "?"}${l?.groupJid ? "" : ", no WhatsApp group"}) · ${L.orders} orders`);
    console.log(`   outcome: ${L.outcome.on_time.length} on time · ${L.outcome.late.length} late · ${L.outcome.missed.length} missed · ${L.outcome.stuck.length} stuck · ${L.outcome.cancelled.length} cancelled · ${L.outcome.moved.length} moved · ${L.outcome.upcoming.length} within 2 h of the slot`);
    if (L.asks) console.log(`   asks: ${[...L.byAsk].map(([k, v]) => `${k} ${v.answered}/${v.sent}`).join(", ")} answered · answered via lab message ${L.answeredBy.lab}, quoted reply ${L.answeredBy.quote}, console ${L.answeredBy.console} · ${L.dropped} dropped before sending`);
    for (const w of works) console.log(`   ✓ ${w}`);
    for (const f of fails) console.log(`   ✗ ${f}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
