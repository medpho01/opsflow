/**
 * The Ops Efficiency Index (27 Oct 2026): one number, 0–100, for how much of
 * the day's lab and store communication ran without a person, how fast, and
 * how cleanly. Computed per day (and summed over a week) from what the
 * gateway stored — every message in every group — and the agent's own log.
 * The definition lives in DOCS/features/ai-ops-agents/OPS-EFFICIENCY.md and
 * must stay stable so weeks compare.
 *
 *   autonomy      store questions answered by the bot with no team message in the thread within 2 h
 *   speed         median minutes from a store question to its first answer (bot or team)
 *   closure       store requests closed within 2 h of being asked (agent_threads)
 *   lab answers   asks to labs answered within 2 h (agent_actions.effect)
 *   messages      automated messages per order handled (fewer, better messages)
 *   human load    team messages per order handled
 */
import prisma from "@/lib/db/client";
import { isAutomated, loadTeam, makeTeamMatcher } from "@/lib/wa/team";

const MIN = 60_000;

export type Efficiency = {
  from: string; to: string;
  index: number | null;
  components: {
    autonomy: { value: number | null; score: number | null; questions: number; byBot: number; byTeam: number; unanswered: number };
    speed: { p50Min: number | null; p90Min: number | null; score: number | null };
    closure: { value: number | null; score: number | null; opened: number; closedIn2h: number };
    labAnswers: { value: number | null; score: number | null; asks: number; answered: number };
    messages: { perOrder: number | null; score: number | null; sent: number; orders: number };
    humanLoad: { perOrder: number | null; score: number | null; teamMessages: number };
  };
  noise: { repeats: number; questionsToBot: number };
};

export const WEIGHTS = { autonomy: 25, speed: 15, closure: 20, labAnswers: 15, messages: 10, humanLoad: 15 } as const;

const clamp = (v: number) => Math.max(0, Math.min(100, v));
/** Linear score: `best` or better is 100, `worst` or worse is 0. */
export const linear = (v: number | null, best: number, worst: number): number | null => (v == null ? null : clamp(100 * (worst - v) / (worst - best)));
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const p90 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(0.9 * (xs.length - 1))] : null);

/** The index from component scores: a weighted mean over the components that have data. */
export function combine(scores: Partial<Record<keyof typeof WEIGHTS, number | null>>): number | null {
  let sum = 0; let weight = 0;
  for (const [k, w] of Object.entries(WEIGHTS) as Array<[keyof typeof WEIGHTS, number]>) {
    const s = scores[k];
    if (s == null) continue;
    sum += s * w; weight += w;
  }
  return weight ? Math.round(sum / weight) : null;
}

export async function computeEfficiency(from: Date, to: Date): Promise<Efficiency> {
  const isTeam = makeTeamMatcher(await loadTeam());
  const groups = await prisma.waGroup.findMany({ where: { archivedAt: null, active: true, OR: [{ role: "SUPPORT", storeId: { not: null } }, { role: "PROVIDER", labId: { not: null } }] }, select: { id: true, role: true } });
  const storeGroups = groups.filter((g) => g.role === "SUPPORT").map((g) => g.id);
  const groupIds = groups.map((g) => g.id);

  // Every message in the window, once.
  const messages = await prisma.waMessage.findMany({
    where: { groupId: { in: groupIds }, ts: { gte: from, lt: to } },
    select: { groupId: true, ts: true, fromMe: true, sender: true, senderJid: true, intent: true, direction: true },
    orderBy: { ts: "asc" },
  });
  const outbounds = await prisma.waOutbound.findMany({ where: { groupId: { in: groupIds }, createdAt: { gte: from, lt: new Date(to.getTime() + 2 * 3_600_000) } }, select: { groupId: true, createdAt: true, createdById: true } });
  const team = (m: { fromMe: boolean; sender: string; senderJid: string | null; intent: string | null }) => !isAutomated(m) && (m.fromMe || !!isTeam(m.sender, m.senderJid));

  // 1. Store questions: who answered, how fast.
  const questions = messages.filter((m) => storeGroups.includes(m.groupId) && m.direction === "IN" && !m.fromMe && !team(m) && !!m.intent?.startsWith("STORE_") && m.intent !== "STORE_NOISE");
  let byBot = 0; let byTeam = 0; let unanswered = 0; const firstAnswerMin: number[] = [];
  for (const q of questions) {
    const twoH = q.ts.getTime() + 2 * 3_600_000;
    const bot = outbounds.find((o) => o.groupId === q.groupId && o.createdById == null && o.createdAt > q.ts && o.createdAt.getTime() <= q.ts.getTime() + 30 * MIN);
    const teamMsg = messages.find((m) => m.groupId === q.groupId && m.ts > q.ts && m.ts.getTime() <= twoH && team(m))
      ?? outbounds.find((o) => o.groupId === q.groupId && o.createdById != null && o.createdAt > q.ts && o.createdAt.getTime() <= twoH);
    const teamAt = teamMsg ? ("ts" in teamMsg ? teamMsg.ts : teamMsg.createdAt) : null;
    if (bot && !teamAt) byBot += 1; else if (teamAt) byTeam += 1; else unanswered += 1;
    const first = [bot?.createdAt, teamAt].filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0];
    if (first) firstAnswerMin.push((first.getTime() - q.ts.getTime()) / MIN);
  }
  const autonomy = questions.length ? byBot / questions.length : null;

  // 2. Store requests closed within 2 h.
  const threads = await prisma.agentThread.findMany({ where: { openedAt: { gte: from, lt: to } }, select: { openedAt: true, closedAt: true } });
  const closedIn2h = threads.filter((t) => t.closedAt && t.closedAt.getTime() - t.openedAt.getTime() <= 2 * 3_600_000).length;
  const closure = threads.length ? closedIn2h / threads.length : null;

  // 3. Asks to labs answered (scored by outcomes.ts).
  const asks = await prisma.agentAction.findMany({ where: { action: { in: ["ask", "reminder"] }, outcome: "EXECUTED", createdAt: { gte: from, lt: to }, effectAt: { not: null } }, select: { effect: true } });
  const answered = asks.filter((a) => (a.effect as { answered?: boolean } | null)?.answered).length;
  const labAnswers = asks.length ? answered / asks.length : null;

  // 4. Messages per order, human messages per order.
  const sentItems = await prisma.agentOutboxItem.findMany({ where: { status: "SENT", sentAt: { gte: from, lt: to }, counterparty: { not: "OPS" } }, select: { outboundId: true, orderId: true } });
  const sent = new Set(sentItems.map((i) => i.outboundId).filter(Boolean)).size;
  const activeOrders = await prisma.agentJourney.count({ where: { openedAt: { lt: to }, OR: [{ closedAt: null }, { closedAt: { gte: from } }] } });
  const teamMessages = messages.filter((m) => team(m)).length + outbounds.filter((o) => o.createdById != null && o.createdAt < to).length;
  const perOrder = activeOrders ? sent / activeOrders : null;
  const humanPerOrder = activeOrders ? teamMessages / activeOrders : null;

  // Noise: the same alert twice on an order within 2 h; questions the bot could not answer.
  const alerts = await prisma.agentAction.findMany({ where: { action: "store_alert", outcome: "EXECUTED", createdAt: { gte: from, lt: to } }, select: { orderId: true, params: true, createdAt: true }, orderBy: { createdAt: "asc" } });
  let repeats = 0; const seen = new Map<string, number>();
  for (const a of alerts) { const k = `${a.orderId}:${(a.params as { template?: string }).template ?? ""}`; const prev = seen.get(k); if (prev != null && a.createdAt.getTime() - prev < 2 * 3_600_000) repeats += 1; seen.set(k, a.createdAt.getTime()); }
  const questionsToBot = await prisma.agentOutboxItem.count({ where: { counterparty: "OPS", ask: "OPS_QUESTION", createdAt: { gte: from, lt: to } } });

  const scores = {
    autonomy: autonomy == null ? null : clamp(autonomy * 100),
    speed: linear(median(firstAnswerMin), 5, 60),
    closure: closure == null ? null : clamp(closure * 100),
    labAnswers: labAnswers == null ? null : clamp(labAnswers * 100),
    messages: linear(perOrder, 1, 4),
    humanLoad: linear(humanPerOrder, 0.5, 3),
  };
  return {
    from: from.toISOString(), to: to.toISOString(), index: combine(scores),
    components: {
      autonomy: { value: autonomy, score: scores.autonomy, questions: questions.length, byBot, byTeam, unanswered },
      speed: { p50Min: median(firstAnswerMin), p90Min: p90(firstAnswerMin), score: scores.speed },
      closure: { value: closure, score: scores.closure, opened: threads.length, closedIn2h },
      labAnswers: { value: labAnswers, score: scores.labAnswers, asks: asks.length, answered },
      messages: { perOrder, score: scores.messages, sent, orders: activeOrders },
      humanLoad: { perOrder: humanPerOrder, score: scores.humanLoad, teamMessages },
    },
    noise: { repeats, questionsToBot },
  };
}

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const min = (v: number | null) => (v == null ? "—" : `${Math.round(v)} min`);

/** Two lines for the brief. */
export function renderEfficiency(e: Efficiency): string[] {
  const c = e.components;
  return [
    `Ops efficiency: ${e.index == null ? "—" : `${e.index}/100`} · autonomy ${pct(c.autonomy.value)} (${c.autonomy.byBot} of ${c.autonomy.questions} store questions by the bot, ${c.autonomy.unanswered} unanswered) · first answer p50 ${min(c.speed.p50Min)}, p90 ${min(c.speed.p90Min)}`,
    `Requests closed in 2 h ${pct(c.closure.value)} (${c.closure.closedIn2h}/${c.closure.opened}) · lab asks answered ${pct(c.labAnswers.value)} · messages/order ${c.messages.perOrder == null ? "—" : c.messages.perOrder.toFixed(1)} · team messages/order ${c.humanLoad.perOrder == null ? "—" : c.humanLoad.perOrder.toFixed(1)} · repeats ${e.noise.repeats} · questions to the bot ${e.noise.questionsToBot}`,
  ];
}
