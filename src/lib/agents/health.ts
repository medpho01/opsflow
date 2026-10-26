/**
 * Self-diagnosis and self-healing (26 Oct 2026). Every 5 minutes the worker
 * checks the invariants each of this week's incidents broke, fixes what is
 * safe to fix, and tells a person only about what it could not fix — once,
 * after it has failed two checks in a row, and again when it recovers.
 *
 *   wake_backlog     orders waiting to be woken pile up         → alert
 *   stale_journeys   the agent's view lags LabStack > 10 min    → wake them now
 *   stuck_outbox     asks past their window, never sent          → drop stale, flush the rest
 *   gateway          WhatsApp not connected / not sending        → alert
 *   no_sends         nothing sent in 3 daytime hours, asks due   → flush, then alert
 *   failed_actions   ≥ 5 failed actions in an hour               → alert with the commonest error
 *   brain            nightly brief missing / monitor stopped     → run the brief now
 *   store_silence    a store question with an order id unanswered → alert with the ids
 *
 * Results are kept as Brain runs of kind "health" (Agents › Brief shows them);
 * alerts go to AGENT_BRIEF_JIDS on WhatsApp.
 */
import prisma from "@/lib/db/client";
import { fetchActiveWindow } from "./journey/window";
import { fingerprint } from "./journey/step";
import { wakeJourney } from "./journey/run";
import { flushOutbox, sendWhatsApp } from "./executors/dispatcher";
import { runNightly } from "./brain/nightly";
import { loadGuardState } from "./guard/guard";

export type Check = { key: string; ok: boolean; detail: string; healed?: string };

const TZ = () => process.env.TIMEZONE || "Asia/Kolkata";
const hourNow = (now: Date) => Number(now.toLocaleString("en-GB", { timeZone: TZ(), hour: "2-digit", hour12: false }));
const MIN = 60_000;

async function wakeBacklog(): Promise<Check> {
  const schema = process.env.PGBOSS_SCHEMA || "pgboss";
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "${schema}".job WHERE name = 'journey.wake' AND state IN ('created','retry')`).catch(() => [{ n: BigInt(-1) }]);
  const n = Number(rows[0]?.n ?? -1);
  return { key: "wake_backlog", ok: n >= 0 && n < 300, detail: n < 0 ? "could not read the job queue" : `${n} order checks waiting` };
}

async function staleJourneys(now: Date): Promise<Check> {
  const orders = await fetchActiveWindow().catch(() => null);
  if (!orders) return { key: "stale_journeys", ok: false, detail: "could not read LabStack (replica)" };
  const open = await prisma.agentJourney.findMany({ where: { closedAt: null }, select: { orderId: true, consoleFingerprint: true } });
  const fp = new Map(open.map((j) => [j.orderId, j.consoleFingerprint]));
  const lagging = orders.filter((o) => fp.has(o.id) && fp.get(o.id) !== fingerprint(o) && o.statusUpdatedAt && o.statusUpdatedAt.getTime() < now.getTime() - 10 * MIN);
  if (!lagging.length) return { key: "stale_journeys", ok: true, detail: "the agent's view matches LabStack" };
  let fixed = 0;
  for (const o of lagging.slice(0, 60)) { try { await wakeJourney(o.id, "console_change", { now, order: o }); fixed += 1; } catch { /* reported below */ } }
  return { key: "stale_journeys", ok: fixed === lagging.length, detail: `${lagging.length} order(s) where the agent lagged LabStack by over 10 min`, healed: `woke ${fixed} now` };
}

async function stuckOutbox(now: Date): Promise<Check> {
  const h = hourNow(now);
  const where = { status: "QUEUED", windowFrom: { lt: new Date(now.getTime() - 90 * MIN) }, windowTo: { gt: now } };
  const before = await prisma.agentOutboxItem.count({ where });
  if (!before || h < 7 || h >= 21) return { key: "stuck_outbox", ok: true, detail: before ? `${before} queued (night hold)` : "nothing stuck" };
  await flushOutbox(now).catch(() => undefined);
  const after = await prisma.agentOutboxItem.count({ where });
  return { key: "stuck_outbox", ok: after < 20, detail: `${after} ask(s) open for over 90 min and not sent`, healed: before !== after ? `flushed: ${before} → ${after}` : undefined };
}

async function gateway(now: Date): Promise<Check> {
  const g = await prisma.waGateway.findUnique({ where: { id: "default" }, select: { status: true, lastSeenAt: true } });
  const pending = await prisma.waOutbound.count({ where: { status: "QUEUED", createdAt: { lt: new Date(now.getTime() - 5 * MIN) } } });
  const failed = await prisma.waOutbound.count({ where: { status: "FAILED", createdAt: { gte: new Date(now.getTime() - 60 * MIN) } } });
  const seen = g?.lastSeenAt ? Math.round((now.getTime() - g.lastSeenAt.getTime()) / MIN) : null;
  const ok = g?.status === "CONNECTED" && (seen == null || seen < 10) && pending < 10 && failed < 5;
  return { key: "gateway", ok, detail: `WhatsApp ${g?.status ?? "unknown"}${seen != null ? `, seen ${seen} min ago` : ""}; ${pending} message(s) waiting over 5 min, ${failed} failed in the last hour` };
}

async function noSends(now: Date): Promise<Check> {
  const h = hourNow(now);
  if (h < 9 || h >= 20) return { key: "no_sends", ok: true, detail: "outside the daytime window" };
  const sent = await prisma.providerBatch.count({ where: { shadow: false, createdAt: { gte: new Date(now.getTime() - 3 * 60 * MIN) } } });
  const due = await prisma.agentOutboxItem.count({ where: { status: "QUEUED", windowFrom: { lte: now }, windowTo: { gt: now }, counterparty: { startsWith: "LAB:" } } });
  if (sent || !due) return { key: "no_sends", ok: true, detail: `${sent} message(s) to labs in 3 h` };
  const f = await flushOutbox(now).catch(() => null);
  return { key: "no_sends", ok: !!f && f.messages > 0, detail: `nothing sent to any lab in 3 h with ${due} ask(s) due`, healed: f ? `flush sent ${f.messages}` : "flush failed" };
}

async function failedActions(now: Date): Promise<Check> {
  const rows = await prisma.agentAction.findMany({ where: { outcome: "FAILED", createdAt: { gte: new Date(now.getTime() - 60 * MIN) } }, select: { action: true, blockedBy: true }, take: 200 });
  if (rows.length < 5) return { key: "failed_actions", ok: true, detail: `${rows.length} failed in the last hour` };
  const top = [...rows.reduce((m, r) => m.set(`${r.action}: ${(r.blockedBy ?? "").split("\n").find((l) => l.trim()) ?? "?"}`, (m.get(`${r.action}: ${(r.blockedBy ?? "").split("\n").find((l) => l.trim()) ?? "?"}`) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0];
  return { key: "failed_actions", ok: false, detail: `${rows.length} actions failed in the last hour; most: ${top[0].slice(0, 120)} (${top[1]})` };
}

async function brain(now: Date): Promise<Check> {
  const h = hourNow(now);
  const lastMonitor = await prisma.agentBrainRun.findFirst({ where: { kind: "monitor" }, orderBy: { startedAt: "desc" }, select: { startedAt: true } });
  const monitorLate = h >= 7 && h < 21 && (!lastMonitor || now.getTime() - lastMonitor.startedAt.getTime() > 75 * MIN);
  if (h === 22 || h === 23) {
    const nightly = await prisma.agentBrainRun.findFirst({ where: { kind: "nightly", startedAt: { gte: new Date(now.getTime() - 3 * 60 * MIN) } }, select: { id: true } });
    if (!nightly) {
      const r = await runNightly(now).then(() => "ran the brief now").catch((e) => `brief failed: ${e instanceof Error ? e.message : e}`);
      return { key: "brain", ok: r === "ran the brief now", detail: "tonight's 21:30 brief did not run", healed: r };
    }
  }
  return { key: "brain", ok: !monitorLate, detail: monitorLate ? `the Brain monitor has not run for ${lastMonitor ? Math.round((now.getTime() - lastMonitor.startedAt.getTime()) / MIN) : "?"} min` : "running" };
}

async function storeSilence(now: Date): Promise<Check> {
  const state = await loadGuardState();
  const live = [...state.desks].filter(([k, v]) => k.startsWith("STORE:STORE:") && v === "LIVE").map(([k]) => Number(k.split(":")[2]));
  if (!live.length) return { key: "store_silence", ok: true, detail: "no store desk live" };
  const groups = await prisma.waGroup.findMany({ where: { role: "SUPPORT", storeId: { in: live } }, select: { id: true } });
  const msgs = await prisma.waMessage.findMany({
    where: { groupId: { in: groups.map((g) => g.id) }, direction: "IN", fromMe: false, ts: { gte: new Date(now.getTime() - 2 * 60 * MIN), lte: new Date(now.getTime() - 15 * MIN) }, intent: { startsWith: "STORE_" }, NOT: { intent: "STORE_NOISE" } },
    select: { id: true, waMsgId: true, text: true }, take: 100,
  });
  const silent: string[] = [];
  for (const m of msgs) {
    if (!/\b\d{5,6}\b/.test(m.text)) continue;
    const acted = await prisma.agentAction.findFirst({ where: { OR: [{ idemKey: { contains: m.id } }, { idemKey: { contains: m.waMsgId } }] }, select: { id: true } });
    if (!acted) silent.push(m.text.match(/\b\d{5,6}\b/)![0]);
  }
  return { key: "store_silence", ok: silent.length === 0, detail: silent.length ? `${silent.length} store question(s) with an order id got no response: ${[...new Set(silent)].slice(0, 8).join(", ")}` : "every store question was handled" };
}

/** Run every check, heal, record, and alert on what stays broken. */
export async function runHealth(now = new Date(), opts: { alert?: boolean } = { alert: true }): Promise<{ checks: Check[]; problems: number }> {
  const checks: Check[] = [];
  for (const fn of [wakeBacklog, () => staleJourneys(now), () => stuckOutbox(now), () => gateway(now), () => noSends(now), () => failedActions(now), () => brain(now), () => storeSilence(now)]) {
    try { checks.push(await fn()); } catch (error) { checks.push({ key: fn.name || "check", ok: false, detail: `check failed: ${error instanceof Error ? error.message.slice(0, 120) : error}` }); }
  }
  const problems = checks.filter((c) => !c.ok);
  await prisma.agentBrainRun.create({ data: { kind: "health", startedAt: now, finishedAt: new Date(), findings: checks as unknown as object } });
  if (opts.alert === false) return { checks, problems: problems.length };

  // Alert on a problem only when the previous check also failed it (10 min), at most every 2 h per
  // problem; say so when one that was alerted recovers.
  const prev = await prisma.agentBrainRun.findMany({ where: { kind: "health", startedAt: { lt: now, gte: new Date(now.getTime() - 2 * 60 * MIN) } }, orderBy: { startedAt: "desc" }, take: 24, select: { findings: true, plan: true, startedAt: true } });
  const last = (prev[0]?.findings as Check[] | undefined) ?? [];
  const alertedRecently = new Set(prev.flatMap((p) => ((p.plan as { alerted?: string[] } | null)?.alerted ?? [])));
  const toAlert = problems.filter((c) => last.some((l) => l.key === c.key && !l.ok) && !alertedRecently.has(c.key));
  const recovered = checks.filter((c) => c.ok && alertedRecently.has(c.key) && last.some((l) => l.key === c.key && !l.ok));
  const jids = (process.env.AGENT_BRIEF_JIDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if ((toAlert.length || recovered.length) && jids.length) {
    const text = [
      toAlert.length ? `⚠️ *OpsFlow health* — needs a look:\n${toAlert.map((c) => `• ${c.detail}${c.healed ? ` (tried: ${c.healed})` : ""}`).join("\n")}` : "",
      recovered.length ? `✅ Recovered: ${recovered.map((c) => c.key.replace(/_/g, " ")).join(", ")}` : "",
    ].filter(Boolean).join("\n\n");
    for (const jid of jids) await sendWhatsApp({ targetJid: jid, groupId: null, text, now }).catch(() => undefined);
  }
  if (toAlert.length) {
    const latest = await prisma.agentBrainRun.findFirst({ where: { kind: "health", startedAt: now }, select: { id: true } });
    if (latest) await prisma.agentBrainRun.update({ where: { id: latest.id }, data: { plan: { alerted: toAlert.map((c) => c.key) } } });
  }
  return { checks, problems: problems.length };
}
