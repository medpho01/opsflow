/**
 * The Brain's nightly run (FR-4.5, FR-4.6, FR-15.1): yesterday's numbers,
 * the misses with a cause each, what got worse, what waits for the SOP
 * owners, and tomorrow's plan — as a brief in the lead console and, when
 * AGENT_BRIEF_JIDS is set, on WhatsApp. The numbers are deterministic; the
 * model (when a key is set) only turns findings into the brief's prose.
 */
import prisma from "@/lib/db/client";
import { TaskStatus } from "@prisma/client";
import { AGENT_RULE_ID } from "../executors/tasks";
import { loadDirectory } from "../directory";
import { sendWhatsApp } from "../executors/dispatcher";
import { auditSample } from "./audit";
import { isAutomated, loadTeam, makeTeamMatcher } from "@/lib/wa/team";
import { scoreOutcomes } from "./outcomes";
import { computeEfficiency, renderEfficiency } from "./efficiency";
import { lessonsSince } from "./learn";
import { styleBriefLine } from "./style";

const H = 3_600_000;
const tz = () => process.env.TIMEZONE || "Asia/Kolkata";

export type Metrics = {
  day: string; orders: number; autonomous: number; autonomyRate: number | null;
  onTimeCollection: number | null; onTimeApi: number | null; onTimeManual: number | null; onTimeReports: number | null;
  teamMessagesPerOrder: number | null; storeReplyP90Min: number | null; statusLagP90Min: number | null;
  overrideRate: number | null; repeatAsks: number; advanceWarning: number | null;
  misses: Array<{ orderId: number; checkpoint: string; labName: string | null; cause: string }>;
  causes: Array<{ cause: string; count: number }>;
  worse: string[]; waiting: { proposals: number; promotions: number; review: number };
  tomorrow: { orders: number; atRisk: number; high: number };
};

function localDay(at: Date): string { return at.toLocaleDateString("en-CA", { timeZone: tz() }); }

/** Why a checkpoint was missed, from the journey's own trail. */
function causeOf(events: Array<{ kind: string; payload: unknown }>, actions: Array<{ action: string; outcome: string; blockedBy: string | null }>, checkpoint: string, labTier: string | null): string {
  if (events.some((e) => e.kind === "console_change" && ((e.payload as { changes?: string[] }).changes ?? []).includes("RESCHEDULED"))) return "rescheduled by the lab or LabStack";
  if (events.some((e) => e.kind === "promise_broken")) return "lab promise broken";
  const asks = actions.filter((a) => a.action === "ask" || a.action === "reminder");
  if (asks.length === 0) return checkpoint === "phlebo_assigned" && labTier === "C" ? "phlebo ask never sent (desk off or shadow)" : "no ask sent";
  if (asks.some((a) => a.outcome === "BLOCKED" && a.blockedBy?.includes("desk"))) return "desk off or shadow: ask not sent";
  if (actions.some((a) => a.action === "create_task")) return "escalated to a person";
  if (events.some((e) => e.kind === "fact")) return "lab answered but did not act";
  return "lab did not answer";
}

export async function computeMetrics(day: Date): Promise<Metrics> {
  const dayKey = localDay(day);
  const start = new Date(`${dayKey}T00:00:00+05:30`);
  const end = new Date(start.getTime() + 24 * H);
  const dir = await loadDirectory();
  const journeys = await prisma.agentJourney.findMany({
    where: { OR: [{ consoleSnapshot: { path: ["appointmentTime"], gte: start.toISOString() } }], openedAt: { lt: end } },
    include: { checkpoints: true, events: { select: { kind: true, payload: true, at: true } }, actions: { select: { action: true, outcome: true, blockedBy: true, createdAt: true } } },
  }).catch(() => []);
  const todays = journeys.filter((j) => { const t = (j.consoleSnapshot as { appointmentTime?: string } | null)?.appointmentTime; return t && localDay(new Date(t)) === dayKey; });

  // Team messages per order and autonomy: a LabStack team message in any group naming the order.
  const orderIds = todays.map((j) => j.orderId);
  const teamMsgs = orderIds.length ? await prisma.waMessage.findMany({ where: { ts: { gte: start, lt: end }, fromMe: false, orderIds: { hasSome: orderIds } }, select: { orderIds: true, senderJid: true, sender: true, intent: true } }) : [];
  const isTeam = makeTeamMatcher(await loadTeam());
  const touched = new Set<number>();
  let teamCount = 0;
  for (const m of teamMsgs) { if (!isAutomated(m) && isTeam(m.sender, m.senderJid)) { teamCount += 1; for (const id of m.orderIds) touched.add(id); } }
  const autonomous = todays.filter((j) => !touched.has(j.orderId)).length;

  const collected = todays.map((j) => ({ j, cp: j.checkpoints.find((c) => c.name === "sample_collected" || c.name === "patient_visited") })).filter((x) => x.cp);
  const onTime = (list: typeof collected) => list.length ? list.filter((x) => x.cp!.status === "MET" && x.cp!.metAt && x.cp!.metAt.getTime() <= x.cp!.dueAt.getTime()).length / list.length : null;
  const api = collected.filter((x) => dir.labs.get(x.j.labId ?? -1)?.tier === "A");
  const manual = collected.filter((x) => dir.labs.get(x.j.labId ?? -1)?.tier === "C");
  const reports = todays.map((j) => j.checkpoints.find((c) => c.name === "report_delivered")).filter((c): c is NonNullable<typeof c> => !!c && (c.status === "MET" || c.dueAt < end));
  const onTimeReports = reports.length ? reports.filter((c) => c.status === "MET" && c.metAt && c.metAt.getTime() <= c.dueAt.getTime() + 4 * H).length / reports.length : null;

  const misses = todays.flatMap((j) => j.checkpoints.filter((c) => c.status === "BREACHED" || (c.status === "MET" && c.metAt && c.metAt.getTime() > c.dueAt.getTime() + 30 * 60_000)).map((c) => ({
    orderId: j.orderId, checkpoint: c.name, labName: (j.consoleSnapshot as { labName?: string } | null)?.labName ?? null,
    cause: causeOf(j.events, j.actions, c.name, dir.labs.get(j.labId ?? -1)?.tier ?? null),
  })));
  const causeCounts = new Map<string, number>();
  for (const m of misses) causeCounts.set(`${m.labName ?? "?"}: ${m.cause}`, (causeCounts.get(`${m.labName ?? "?"}: ${m.cause}`) ?? 0) + 1);

  const reviews = await prisma.agentReviewItem.findMany({ where: { decidedAt: { gte: start, lt: end } }, select: { decision: true } });
  const overrideRate = reviews.length ? reviews.filter((r) => r.decision !== "APPROVED").length / reviews.length : null;
  const repeatAsks = todays.reduce((n, j) => n + Object.values(j.attempts as Record<string, { n?: number }>).filter((a) => (a?.n ?? 0) > 5).length, 0);
  const warnings = await prisma.agentOrderRisk.findMany({ where: { scoredAt: { gte: new Date(start.getTime() - 12 * H), lt: end }, level: "HIGH" }, select: { orderId: true, warnedStoreAt: true } });
  const missedIds = new Set(misses.map((m) => m.orderId));
  const warned = warnings.filter((w) => missedIds.has(w.orderId));
  const advanceWarning = warned.length ? warned.filter((w) => w.warnedStoreAt).length / warned.length : null;

  const storeReplies = await prisma.agentOutboxItem.findMany({ where: { ask: "STORE_REPLY", sentAt: { gte: start, lt: end } }, select: { createdAt: true, sentAt: true } });
  const p90 = (xs: number[]) => (xs.length ? xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))] : null);
  const storeReplyP90Min = p90(storeReplies.map((s) => (s.sentAt!.getTime() - s.createdAt.getTime()) / 60_000));
  const writes = await prisma.agentConsoleWrite.findMany({ where: { createdAt: { gte: start, lt: end }, status: { in: ["DONE", "TASKED"] } }, select: { createdAt: true, updatedAt: true } });
  const statusLagP90Min = p90(writes.map((w) => (w.updatedAt.getTime() - w.createdAt.getTime()) / 60_000));

  const tomorrowStart = new Date(start.getTime() + 24 * H);
  const tomorrow = await prisma.agentJourney.findMany({ where: { closedAt: null, consoleSnapshot: { path: ["appointmentTime"], gte: tomorrowStart.toISOString() } }, select: { riskLevel: true, consoleSnapshot: true } }).catch(() => []);
  const tomorrows = tomorrow.filter((j) => { const t = (j.consoleSnapshot as { appointmentTime?: string } | null)?.appointmentTime; return t && localDay(new Date(t)) === localDay(tomorrowStart); });
  const [proposals, pendingReview, promotions] = await Promise.all([
    prisma.agentSopProposal.count({ where: { decision: null } }),
    prisma.agentReviewItem.count({ where: { decision: null } }),
    prisma.agentAutonomy.count({ where: { agreementRate: { gte: 0.98 }, sampleSize: { gte: 200 }, level: { not: "ACT" } } }),
  ]);

  return {
    day: dayKey, orders: todays.length, autonomous, autonomyRate: todays.length ? autonomous / todays.length : null,
    onTimeCollection: onTime(collected), onTimeApi: onTime(api), onTimeManual: onTime(manual), onTimeReports,
    teamMessagesPerOrder: todays.length ? teamCount / todays.length : null, storeReplyP90Min, statusLagP90Min, overrideRate, repeatAsks, advanceWarning,
    misses, causes: [...causeCounts].map(([cause, count]) => ({ cause, count })).sort((a, b) => b.count - a.count).slice(0, 6),
    worse: [], waiting: { proposals, promotions, review: pendingReview },
    tomorrow: { orders: tomorrows.length, atRisk: tomorrows.filter((j) => j.riskLevel !== "LOW").length, high: tomorrows.filter((j) => j.riskLevel === "HIGH").length },
  };
}

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);

export function renderBrief(m: Metrics, now: Date): string {
  const date = now.toLocaleDateString("en-IN", { timeZone: tz(), weekday: "short", day: "numeric", month: "short" });
  const lines = [
    `OpsFlow brief · ${date}`,
    `Yesterday: ${m.orders} orders · ${pct(m.autonomyRate)} autonomous · collected on time ${pct(m.onTimeCollection)} (API ${pct(m.onTimeApi)}, manual ${pct(m.onTimeManual)}) · reports on time ${pct(m.onTimeReports)}`,
    `Team messages per order: ${m.teamMessagesPerOrder == null ? "—" : m.teamMessagesPerOrder.toFixed(1)} · store reply p90 ${m.storeReplyP90Min == null ? "—" : `${Math.round(m.storeReplyP90Min)} min`} · status lag p90 ${m.statusLagP90Min == null ? "—" : `${Math.round(m.statusLagP90Min)} min`} · overrides ${pct(m.overrideRate)}`,
    `Misses: ${m.misses.length}${m.causes.length ? ` · top causes: ${m.causes.slice(0, 3).map((c) => `${c.cause} (${c.count})`).join(", ")}` : ""}`,
    `Waiting for you: ${m.waiting.proposals} SOP proposal${m.waiting.proposals === 1 ? "" : "s"}, ${m.waiting.promotions} autonomy promotion${m.waiting.promotions === 1 ? "" : "s"}, ${m.waiting.review} review items`,
    `Today: ${m.tomorrow.orders} orders · ${m.tomorrow.atRisk} at risk (${m.tomorrow.high} high)`,
  ];
  return lines.join("\n");
}

export async function runNightly(now = new Date()): Promise<Record<string, number>> {
  const run = await prisma.agentBrainRun.create({ data: { kind: "nightly" }, select: { id: true } });
  try {
    const metrics = await computeMetrics(new Date(now.getTime() - 6 * H));
    // What came of the day's actions, the efficiency index, and the hour-by-hour lessons (27 Oct 2026).
    const outcomes = await scoreOutcomes(now).catch((e) => { console.warn("[Brain] outcomes:", e instanceof Error ? e.message : e); return null; });
    const dayStart = new Date(now.getTime() - 6 * H); dayStart.setUTCHours(0, 0, 0, 0);
    const efficiency = await computeEfficiency(new Date(dayStart.getTime() - 5.5 * H), new Date(dayStart.getTime() + 18.5 * H)).catch((e) => { console.warn("[Brain] efficiency:", e instanceof Error ? e.message : e); return null; });
    const lessons = await lessonsSince(new Date(now.getTime() - 24 * H)).catch(() => null);
    const styleLine = await styleBriefLine(new Date(now.getTime() - 24 * H)).catch(() => null);
    const brief = [
      renderBrief(metrics, new Date(now.getTime() + 12 * H)),
      ...(efficiency ? renderEfficiency(efficiency) : []),
      ...(styleLine ? [styleLine] : []),
      ...(lessons && lessons.runs ? [`Learned today (${lessons.runs} passes): ${lessons.wrong.length} things to fix, ${lessons.unanswered} questions nobody answered${lessons.wrong.length ? ` · top: ${lessons.wrong.slice(0, 3).map((w) => `${w.kind}${w.order ? ` #${w.order}` : ""}: ${w.what.slice(0, 70)}`).join(" | ")}` : ""}`] : []),
    ].join("\n");
    const audit = await auditSample(now).catch((e) => ({ sampled: 0, disagreements: 0, cases: 0, error: e instanceof Error ? e.message : String(e) }));
    await prisma.agentBrainRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), inputs: metrics as object, brief, findings: { audit, outcomes, efficiency, lessons: lessons ? { runs: lessons.runs, wrong: lessons.wrong.slice(0, 20), unanswered: lessons.unanswered, people: lessons.people.slice(0, 10) } : null } as object } });
    const jids = (process.env.AGENT_BRIEF_JIDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const jid of jids) await sendWhatsApp({ targetJid: jid, groupId: null, text: brief }).catch(() => undefined);
    return { orders: metrics.orders, misses: metrics.misses.length, audited: audit.sampled, disagreements: audit.disagreements, sent: jids.length };
  } catch (error) {
    await prisma.agentBrainRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), error: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}
