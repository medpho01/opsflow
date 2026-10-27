/**
 * What the lab desks did, and did not do, in the last N hours (default 24).
 * Per lab: messages sent, items still queued, items dropped or withdrawn; the
 * guard's decisions by action and outcome with the top block reasons; and the
 * orders that are late at a checkpoint with NO ask in the window — each with
 * the reason the step most likely held it. Read-only, no patient data.
 *
 *   docker compose exec -T app npx tsx scripts/lab-activity.ts        # 24 h
 *   docker compose exec -T app npx tsx scripts/lab-activity.ts 6      # 6 h
 */
import prisma from "@/lib/db/client";
import { loadDirectory, tierOf } from "@/lib/agents/directory";
import { loadGuardState } from "@/lib/agents/guard/guard";
import { consoleIsLive } from "@/lib/agents/journey/step";
import { fetchOrderSnapshots } from "@/lib/agents/journey/window";
import { loadLiveSops, paramsFor } from "@/lib/agents/sop/load";

const TZ = process.env.TIMEZONE || "Asia/Kolkata";
const H = 3_600_000;
const t = (d: Date | null | undefined) => (d ? d.toLocaleString("en-IN", { timeZone: TZ, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—");
const count = <K extends string>(rows: Array<Record<K, string>>, key: K) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r[key], (m.get(r[key]) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};

async function main() {
  const hours = Number(process.argv[2] ?? 24);
  const now = new Date();
  const since = new Date(now.getTime() - hours * H);
  const dir = await loadDirectory(true);
  const state = await loadGuardState();
  const sops = await loadLiveSops();
  const labName = (id: number | null) => (id == null ? "(no lab)" : dir.labs.get(id)?.labName ?? `lab ${id}`);
  const desk = (id: number) => state.desks.get(`LAB:LAB:${id}`) ?? "OFF";

  console.log(`Lab desks — last ${hours} h (since ${t(since)}), now ${t(now)}${state.settings.pausedAll ? "  ⚠️ PAUSED ALL" : ""}${state.settings.pausedDesks.length ? `  ⚠️ paused desks: ${state.settings.pausedDesks.join(", ")}` : ""}`);

  // ── 1. What went out, per lab ──
  const items = await prisma.agentOutboxItem.findMany({ where: { counterparty: { startsWith: "LAB:" }, OR: [{ sentAt: { gte: since } }, { createdAt: { gte: since } }, { status: "QUEUED" }] }, select: { counterparty: true, ask: true, status: true, urgent: true, windowTo: true, sentAt: true, createdAt: true, batchId: true, orderId: true } });
  const batches = await prisma.providerBatch.findMany({ where: { createdAt: { gte: since }, shadow: false }, select: { labId: true, intent: true, recipient: true, itemCount: true, createdAt: true } });
  const ruleBatches = batches.filter((b) => b.intent.startsWith("RULE:") || b.intent === "NEW_ORDER");
  const byLab = new Map<number, { sent: Map<string, number>; msgs: number; queued: number; queuedOverdue: number; dropped: number; withdrawn: number; newOrders: number }>();
  const slot = (id: number) => byLab.get(id) ?? byLab.set(id, { sent: new Map(), msgs: 0, queued: 0, queuedOverdue: 0, dropped: 0, withdrawn: 0, newOrders: 0 }).get(id)!;
  for (const i of items) {
    const id = Number(i.counterparty.split(":")[1]); const s = slot(id);
    if (i.status === "SENT" && i.sentAt && i.sentAt >= since) s.sent.set(i.ask, (s.sent.get(i.ask) ?? 0) + 1);
    else if (i.status === "QUEUED") { s.queued += 1; if (i.windowTo < now) s.queuedOverdue += 1; }
    else if (i.status === "DROPPED" && i.createdAt >= since) s.dropped += 1;
    else if (i.status === "WITHDRAWN" && i.createdAt >= since) s.withdrawn += 1;
  }
  for (const b of batches) { const s = slot(b.labId); if (b.intent.startsWith("RULE:") || b.intent === "NEW_ORDER") s.newOrders += b.itemCount; else s.msgs += 1; }
  const summaries = await prisma.providerMessageLedger.count({ where: { entityType: "LAB_SUMMARY", outcome: "SENT", createdAt: { gte: since } } });
  const openByLab = new Map<number, { open: number; late: number }>();
  for (const r of await prisma.agentJourney.groupBy({ by: ["labId", "health"], where: { closedAt: null, labId: { not: null } }, _count: { _all: true } })) {
    const o = openByLab.get(r.labId!) ?? openByLab.set(r.labId!, { open: 0, late: 0 }).get(r.labId!)!;
    o.open += r._count._all; if (r.health === "BREACHED") o.late += r._count._all;
  }

  console.log(`\n1. Per lab — open orders (late), messages sent (combined asks), items sent by intent, queued now, dropped/withdrawn\n   (${batches.length - ruleBatches.length} combined ask messages, ${ruleBatches.length} new-order messages, ${summaries} evening lists in the window)`);
  const labs = [...dir.labs.values()].filter((l) => l.groupJid).sort((a, b) => a.labName.localeCompare(b.labName));
  for (const l of labs) {
    const s = byLab.get(l.labId);
    const sent = s ? [...s.sent].map(([k, v]) => `${k} ${v}`).join(", ") : "";
    const flags = [s?.queuedOverdue ? `${s.queuedOverdue} past window` : "", s?.dropped ? `${s.dropped} dropped` : "", s?.withdrawn ? `${s.withdrawn} withdrawn` : ""].filter(Boolean).join(", ");
    const o = openByLab.get(l.labId);
    console.log(`   ${l.labName.padEnd(38).slice(0, 38)} ${tierOf(dir, l.labId)} ${desk(l.labId).padEnd(6)} open ${String(o?.open ?? 0).padStart(3)} (${String(o?.late ?? 0).padStart(2)} late)  msgs ${String(s?.msgs ?? 0).padStart(2)}  new ${String(s?.newOrders ?? 0).padStart(2)}  queued ${String(s?.queued ?? 0).padStart(2)}  ${sent}${flags ? `  [${flags}]` : ""}`);
  }

  // ── 2. The guard's decisions ──
  const actions = await prisma.agentAction.findMany({ where: { desk: "LAB", createdAt: { gte: since } }, select: { action: true, outcome: true, blockedBy: true, level: true } });
  console.log(`\n2. Lab-desk decisions in the window: ${actions.length}`);
  const byAction = new Map<string, Map<string, number>>();
  for (const a of actions) { const m = byAction.get(a.action) ?? byAction.set(a.action, new Map()).get(a.action)!; m.set(a.outcome, (m.get(a.outcome) ?? 0) + 1); }
  for (const [action, m] of byAction) console.log(`   ${action.padEnd(18)} ${[...m].map(([o, n]) => `${o} ${n}`).join("  ")}`);
  const blocked = count(actions.filter((a) => a.outcome === "BLOCKED" && a.blockedBy).map((a) => ({ why: a.blockedBy!.replace(/\d+/g, "#") })), "why");
  if (blocked.length) console.log(`   blocked because: ${blocked.slice(0, 6).map(([w, n]) => `${w} (${n})`).join("; ")}`);
  const recorded = actions.filter((a) => a.outcome === "RECORDED");
  if (recorded.length) console.log(`   recorded only (shadow): ${recorded.length} — ${count(recorded.map((a) => ({ a: a.action })), "a").map(([a, n]) => `${a} ${n}`).join(", ")}`);

  // ── 3. Late orders with no ask ──
  const journeys = await prisma.agentJourney.findMany({
    where: { closedAt: null, labId: { not: null }, checkpoints: { some: { status: "BREACHED" } } },
    select: { id: true, orderId: true, labId: true, stage: true, attempts: true, pausedUntil: true, ownerUserId: true, checkpoints: { where: { status: "BREACHED" }, orderBy: { dueAt: "asc" }, take: 1, select: { name: true, dueAt: true } } },
    take: 2000,
  });
  const askedOrders = new Set(items.filter((i) => i.status === "SENT" && i.sentAt && i.sentAt >= since).map((i) => i.orderId));
  const queuedOrders = new Set(items.filter((i) => i.status === "QUEUED").map((i) => i.orderId));
  const silent = journeys.filter((j) => !askedOrders.has(j.orderId) && !queuedOrders.has(j.orderId));
  console.log(`\n3. Orders late at a checkpoint: ${journeys.length}; asked or queued in the window: ${journeys.length - silent.length}; SILENT: ${silent.length}`);
  if (silent.length) {
    const snaps = await fetchOrderSnapshots(silent.slice(0, 400).map((j) => j.orderId)).catch(() => new Map());
    const reasons = new Map<string, number>();
    const examples: Array<{ rank: number; line: string }> = [];
    for (const j of silent) {
      const o = snaps.get(j.orderId);
      const tier = tierOf(dir, j.labId);
      const sop = paramsFor(sops.get("LAB"), { labTier: tier, labId: j.labId, storeId: null, orderType: null });
      const cp = j.checkpoints[0];
      const attempts = (j.attempts as Record<string, { n?: number; at?: string }>)[cp?.name ?? ""];
      let why = "no reason found — run why-not-asked";
      const noGroup = !dir.labs.get(j.labId!)?.groupJid;
      const stale = cp && cp.dueAt.getTime() < now.getTime() - 14 * 24 * H;
      if (noGroup) why = `lab has no WhatsApp group (${labName(j.labId).slice(0, 20)})`;
      else if (desk(j.labId!) !== "LIVE") why = `desk ${desk(j.labId!)}`;
      else if (state.settings.pausedLabIds.includes(j.labId!)) why = "lab paused";
      else if (j.ownerUserId && j.pausedUntil && j.pausedUntil > now) why = "a person owns it";
      else if (!o) why = stale ? "stale: due over 14 d ago and out of the open-orders window — journey should close" : "not in the open-orders window (visit too old or already closed in LabStack)";
      else if (["CANCELED", "CANCELLED", "REPORT_DELIVERED"].includes(o.orderStatus)) why = `console shows ${o.orderStatus} — journey should close`;
      else if (sop && consoleIsLive(o, tier, now, sop.consoleQuietMin)) why = `console live (updated ${t(o.statusUpdatedAt)})`;
      else if (attempts?.n != null && attempts.n >= 99) why = `visit long past; task made; daily re-ask due ${attempts.at ? t(new Date(Date.parse(attempts.at) + (sop?.reaskEveryMin ?? 1440) * 60_000)) : "next slot"}`;
      else if (attempts?.n != null && sop && attempts.n >= sop.ladder.length) why = `ladder exhausted (${attempts.n}); daily re-ask due ${attempts.at ? t(new Date(Date.parse(attempts.at) + sop.reaskEveryMin * 60_000)) : "next slot"}`;
      else if (cp && !sop?.asks[cp.name]) why = `checkpoint ${cp.name} has no ask in the SOP`;
      else if (cp && ["confirmed", "visit_confirmed", "sample_at_lab", "samples_received"].includes(cp.name) && tier !== "C") why = `API lab: ${cp.name} is not asked`;
      else if (cp && attempts?.at && Date.parse(attempts.at) > now.getTime() - (sop?.rungGapMin ?? 30) * 60_000) why = `asked ${t(new Date(attempts.at))}, waiting for the rung gap`;
      else if (cp && attempts?.at) why = `asked ${t(new Date(attempts.at))} (${attempts.n} asks) — waiting for the next slot`;
      const key = why.replace(/\d+:\d+ (am|pm)|\d+ \w{3}/g, "…");
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
      const rank = why.startsWith("no reason") ? 0 : noGroup || why.startsWith("desk ") || why.startsWith("stale") ? 2 : 1;
      examples.push({ rank, line: `   #${j.orderId}  ${labName(j.labId).slice(0, 24).padEnd(24)} ${(cp?.name ?? "?").padEnd(16)} due ${t(cp?.dueAt)}  console ${o?.orderStatus ?? j.stage}  → ${why}` });
    }
    console.log("   why, by count:");
    for (const [w, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(4)}  ${w}`);
    console.log("   examples (unexplained first; labs without a group and stale journeys last):");
    for (const e of examples.sort((a, b) => a.rank - b.rank).slice(0, 20)) console.log(e.line);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
