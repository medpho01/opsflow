/**
 * Build the evaluation case file (27 Oct 2026) from what actually happened:
 * every store question and lab reply of the last N days, with what the bot
 * read and did, what the team did, and the lessons the hourly learning pass
 * attached. Written as JSON for scripts/eval-run.ts, with `expected` fields
 * to fill in by hand where the automatic label is not trusted.
 *
 * The file names patients and quotes chats: keep it on the server or your
 * own machine, never in the repository.
 *
 *   docker compose exec -T app npx tsx scripts/eval-build-cases.ts 7 > ~/eval-cases.json
 */
import prisma from "@/lib/db/client";
import { isAutomated, loadTeam, makeTeamMatcher } from "@/lib/wa/team";
import type { LearnFindings } from "@/lib/agents/brain/learn";

type Case = {
  id: string; side: "lab" | "store"; group: string; at: string; text: string; quoted: string | null;
  bot: { intent: string | null; orders: number[]; actions: string[] };
  team: { replied: boolean; minutes: number | null; text: string | null };
  expected: { intent: string | null; orders: number[] | null; note: string | null };
  lesson: string | null;
};

async function main() {
  const days = Number(process.argv[2] ?? 7);
  const since = new Date(Date.now() - days * 86_400_000);
  const isTeam = makeTeamMatcher(await loadTeam());
  const groups = await prisma.waGroup.findMany({ where: { archivedAt: null, active: true, role: { in: ["SUPPORT", "PROVIDER"] } }, select: { id: true, subject: true, role: true } });
  const messages = await prisma.waMessage.findMany({ where: { groupId: { in: groups.map((g) => g.id) }, ts: { gte: since } }, orderBy: { ts: "asc" }, select: { id: true, waMsgId: true, groupId: true, ts: true, fromMe: true, sender: true, senderJid: true, text: true, intent: true, orderIds: true, replyToWaId: true } });
  const byWa = new Map(messages.map((m) => [m.waMsgId, m]));
  const events = await prisma.agentJourneyEvent.findMany({ where: { kind: "store_message", at: { gte: since } }, select: { payload: true, journey: { select: { orderId: true } } } });
  const linked = new Map<string, number[]>();
  for (const e of events) { const id = (e.payload as { messageId?: string }).messageId; if (id) linked.set(id, [...(linked.get(id) ?? []), e.journey.orderId]); }
  const facts = await prisma.providerOrderFact.findMany({ where: { createdAt: { gte: since } }, select: { sourceMessageId: true, orderId: true, kind: true } });
  const factsByMsg = new Map<string, Array<{ orderId: number; kind: string }>>();
  for (const f of facts) if (f.sourceMessageId) factsByMsg.set(f.sourceMessageId, [...(factsByMsg.get(f.sourceMessageId) ?? []), { orderId: f.orderId, kind: f.kind }]);
  const lessons = await prisma.agentBrainRun.findMany({ where: { kind: "learn", startedAt: { gte: since }, error: null }, select: { findings: true } });
  const lessonByText = new Map<string, string>();
  for (const r of lessons) for (const c of ((r.findings as Partial<LearnFindings> | null)?.cases ?? [])) lessonByText.set(c.text.trim().slice(0, 120), `${c.lesson}${c.expectedIntent ? ` [expect ${c.expectedIntent}${c.expectedOrder ? ` #${c.expectedOrder}` : ""}]` : ""}`);

  const cases: Case[] = [];
  for (const [i, m] of messages.entries()) {
    const text = (m.text ?? "").trim();
    if (!text || m.fromMe || isAutomated(m) || isTeam(m.sender, m.senderJid)) continue;
    const g = groups.find((x) => x.id === m.groupId)!;
    const side = g.role === "SUPPORT" ? "store" : "lab";
    const reply = messages.slice(i + 1, i + 40).find((r) => r.groupId === m.groupId && (r.fromMe || isTeam(r.sender, r.senderJid)) && !isAutomated(r) && r.ts.getTime() - m.ts.getTime() <= 90 * 60_000);
    const actions = side === "store" && linked.get(m.id)?.length
      ? (await prisma.agentAction.findMany({ where: { orderId: { in: linked.get(m.id)! }, createdAt: { gte: m.ts, lte: new Date(m.ts.getTime() + 20 * 60_000) } }, select: { action: true, outcome: true } })).map((a) => `${a.action}:${a.outcome}`)
      : (factsByMsg.get(m.id) ?? []).map((f) => `fact:${f.kind}`);
    const lesson = lessonByText.get(text.slice(0, 120)) ?? null;
    cases.push({
      id: m.id, side, group: g.subject, at: m.ts.toISOString(), text: text.slice(0, 600), quoted: m.replyToWaId ? (byWa.get(m.replyToWaId)?.text ?? null) : null,
      bot: { intent: m.intent ?? null, orders: side === "store" ? linked.get(m.id) ?? [] : [...new Set((factsByMsg.get(m.id) ?? []).map((f) => f.orderId))], actions },
      team: { replied: !!reply, minutes: reply ? Math.round((reply.ts.getTime() - m.ts.getTime()) / 60_000) : null, text: reply?.text?.slice(0, 300) ?? null },
      expected: { intent: null, orders: null, note: null },
      lesson,
    });
  }
  process.stdout.write(JSON.stringify({ builtAt: new Date().toISOString(), days, cases }, null, 1));
  console.error(`${cases.length} cases (${cases.filter((c) => c.side === "store").length} store, ${cases.filter((c) => c.side === "lab").length} lab, ${cases.filter((c) => c.lesson).length} with a lesson)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
