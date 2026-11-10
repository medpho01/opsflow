/**
 * The understanding desk, live (11 Nov 2026). For a store whose id is in AGENT_DESK_UNDERSTAND_STORES
 * the store reader hands each linked message here before the old kind-by-kind path: understand.ts says
 * what the store wants and plans the move, and this carries it out through the same guard as
 * everything else — a reply to the store, the exact question to the lab, a silent handoff, or
 * nothing. What the old path did around a message still happens: the request is tracked as a thread,
 * a tagged person gets three minutes first, a person already on the order is left to it, and the
 * dispatcher still drops a reply the team gave first.
 *
 * Kinds the store's desk does not answer itself (its live scope) are handed to a person, as before.
 * Returns null when the desk could not run (no model, an error): the caller falls back to the old path.
 */
import prisma from "@/lib/db/client";
import { contextFor } from "../reader/context";
import { coachingBlock } from "../brain/coach";
import { guard, type GuardState } from "../guard/guard";
import { fetchOrderSnapshot } from "../journey/window";
import { isAutomated } from "@/lib/wa/team";
import { labChaseable } from "./scope";
import { openThread } from "./threads";
import { runDesk, teamExamples, type Understanding } from "./understand";

/** Stores whose desk understands before it answers: AGENT_DESK_UNDERSTAND_STORES="6,12". */
export function deskStores(): Set<number> {
  return new Set((process.env.AGENT_DESK_UNDERSTAND_STORES ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0));
}

/** The old desk's kind for a topic, so the store's live scope and the thread tracker apply unchanged. */
export const TOPIC_KIND: Record<Understanding["topic"], string> = {
  collection: "status", report: "report", slot: "slot", reschedule: "reschedule", cancel: "cancel",
  tests: "change_tests", booking: "new_booking", complaint: "complaint", information: "other", none: "other",
};
const ASK_INTENT: Record<string, string> = { report: "REPORT", reschedule: "RESCHEDULE", cancel: "CANCEL" };

export type DeskMessage = { id: string; waMsgId: string; groupId: string; senderJid: string | null; ts: Date; text: string; quotedText: string | null };

export async function deskHandle(input: {
  message: DeskMessage; storeId: number; orderIds: number[]; tagged: boolean; state: GuardState;
  isTeam: (sender: string, jid: string | null) => unknown; now: Date;
}): Promise<{ executed: number; review: number } | null> {
  const { message: m, storeId, state, now } = input;
  const candidates = [...new Set(input.orderIds)].slice(0, 3);
  if (!candidates.length) return null;
  // Once per message: a second pass over the same message does nothing.
  const idemKey = `desk:${m.id}`;
  if (await prisma.agentAction.findUnique({ where: { idemKey }, select: { id: true } })) return { executed: 0, review: 0 };

  const snaps = new Map((await Promise.all(candidates.map(async (id) => [id, await fetchOrderSnapshot(id).catch(() => null)] as const))));
  const reachable: Record<number, boolean> = {};
  for (const id of candidates) { const lab = snaps.get(id)?.labId; reachable[id] = lab != null ? await labChaseable(lab, state.desks).catch(() => false) : false; }
  const before = await prisma.waMessage.findMany({ where: { groupId: m.groupId, ts: { lt: m.ts, gte: new Date(m.ts.getTime() - 45 * 60_000) } }, orderBy: { ts: "desc" }, take: 8, select: { ts: true, text: true, sender: true, senderJid: true, fromMe: true, intent: true } });
  const tz = process.env.TIMEZONE || "Asia/Kolkata";
  const thread = before.reverse().map((b) => `  ${b.ts.toLocaleTimeString("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit" })} ${b.fromMe || isAutomated(b) ? "us" : input.isTeam(b.sender, b.senderJid) ? "our team" : "store"}: ${(b.text ?? "").replace(/\s+/g, " ").slice(0, 200)}`).join("\n");
  const [context, examples, coaching] = await Promise.all([
    contextFor(candidates, m.ts, { groupId: m.groupId, senderJid: m.senderJid, max: 3, recentHours: 48, lines: 12, facts: true }),
    teamExamples(storeId, m.text, m.ts),
    coachingBlock({ storeId }, "store"),
  ]);
  const out = await runDesk({ storeId, orderId: candidates.length === 1 ? candidates[0] : null, text: m.text, quotedText: m.quotedText, context, thread, labReachable: false, candidates, reachable, coaching, examples });
  if (!out) return null;
  const { understanding: u, plan } = out;
  const kind = TOPIC_KIND[u.topic] ?? "other";
  const orderId = plan.orderId ?? candidates[0];
  const o = snaps.get(orderId) ?? null;
  const ctx = { journeyId: null, orderId, labId: o?.labId ?? null, storeId, orderType: o?.orderType, appointmentTime: o?.appointmentTime ?? null, patientName: o?.patientName ?? null, labName: o?.labName ?? null, storeName: o?.storeName ?? null };

  // The plan is kept whatever becomes of it: this row is what the daily report reads.
  await prisma.agentAction.create({ data: {
    orderId, desk: "STORE", action: "desk_plan", level: "ACT", outcome: "RECORDED", idemKey, model: out.model,
    reason: u.question.slice(0, 300),
    params: { messageId: m.id, topic: u.topic, kind, action: plan.action, reply: plan.reply, labQuestion: plan.labQuestion, basis: plan.basis, why: plan.reason, confidence: plan.confidence, check: out.check, candidates },
  } }).catch(() => undefined);
  if (plan.action !== "silent") await openThread({ orderId, storeId, groupId: m.groupId, kind, messageId: m.id, waMsgId: m.waMsgId, text: m.text, at: m.ts, order: o }).catch(() => null);

  const results: Array<{ outcome: string }> = [];
  const live = state.scopes.get(`STORE:STORE:${storeId}`);
  const inScope = !live || live.includes(kind);
  if (plan.action === "silent") return { executed: 0, review: 0 };
  if (plan.action === "handoff" || !inScope) {
    results.push(await guard({ desk: "STORE", action: "store_handoff", params: { orderId, storeId, intent: kind, quotedWaId: m.waMsgId, note: !inScope && plan.action !== "handoff" ? `${kind} is not live for this store — ${u.question}` : `${u.question} — ${plan.reason}`.slice(0, 300) }, reason: `desk: ${plan.reason}`.slice(0, 300), idemKey: `${idemKey}:handoff` }, ctx, state));
  } else {
    if (plan.action === "ask_lab" && plan.labQuestion && o?.labId != null) {
      // A tagged person gets three minutes to ask the lab themselves; then the ask goes unless they did.
      const from = input.tagged ? new Date(now.getTime() + 3 * 60_000) : now;
      results.push(await guard({ desk: "LAB", action: "ask", params: {
        checkpoint: "sample_collected", orderId, labId: o.labId, attempt: 1, dueAt: now, rung: "ask", intent: ASK_INTENT[kind] ?? "STATUS", counterparty: `LAB:${o.labId}`,
        windowFrom: from, windowTo: new Date(now.getTime() + 8 * 3_600_000), urgent: true, forStore: true, ...(input.tagged ? { teamTagged: true } : { storeRequest: true }),
        line: { orderId, patientName: o.patientName, appointment: o.appointmentTime, labRef: o.labRef ?? null, mobile: o.mobile ?? null, area: o.area ?? null, note: plan.labQuestion.replace(/^[^:]{0,60}#?\d{5,6}[^:]{0,40}:\s*/, "").slice(0, 240) },
      }, reason: `desk: the store asks — ${u.question}`.slice(0, 300), idemKey: `${idemKey}:ask` }, ctx, state));
    }
    if (plan.reply) results.push(await guard({ desk: "STORE", action: "store_reply", params: { text: plan.reply, orderId, storeId, intent: kind, quotedWaId: m.waMsgId }, reason: `desk: ${u.question}`.slice(0, 300), idemKey: `${idemKey}:reply` }, ctx, state));
  }
  return { executed: results.filter((r) => r.outcome === "EXECUTED").length, review: results.filter((r) => r.outcome === "REVIEW").length };
}
