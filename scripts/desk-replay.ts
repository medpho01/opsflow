/**
 * The desk that understands before it answers, replayed over a store's real messages (11 Nov 2026).
 * For each store message of the last N days that the readiness run kept (with what the old desk
 * drafted and what the team then said): the order as it stood THEN, the thread before it, the team's
 * answers to earlier similar messages — and what the new desk would have done. A strict judge then
 * compares its reply with the team's. Sends nothing, writes nothing but the model-call audit rows.
 *
 *   docker compose -f docker-compose.yml -f docker-compose.wa.yml exec -T app npx tsx scripts/desk-replay.ts            # store 6, 7 days, 60 messages
 *   … scripts/desk-replay.ts 6 7 150          # store, days, how many messages (newest first)
 *
 * Prints counts and, per message, the question as understood, the old draft, the new move and the
 * team's reply — phone numbers masked. Costs model calls: about three per message.
 */
import prisma from "@/lib/db/client";
import { askModel } from "@/lib/agents/llm";
import { contextFor } from "@/lib/agents/reader/context";
import { coachingBlock } from "@/lib/agents/brain/coach";
import { loadGuardState } from "@/lib/agents/guard/guard";
import { labChaseable } from "@/lib/agents/store/scope";
import { runDesk, teamExamples } from "@/lib/agents/store/understand";
import { isAutomated, loadTeam, makeTeamMatcher } from "@/lib/wa/team";

const TZ = process.env.TIMEZONE || "Asia/Kolkata";
const mask = (s: string | null | undefined, n = 200) => (s ?? "").replace(/(?:\+?91[\s-]?)?\b[6-9]\d{9}\b/g, "<phone>").replace(/@\d{6,}/g, "@…").replace(/\s+/g, " ").trim().slice(0, n);
const clock = (d: Date) => d.toLocaleString("en-IN", { timeZone: TZ, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

type Grade = "MATCHES" | "USEFUL" | "BESIDE_THE_POINT" | "WRONG";
async function grade(question: string, reply: string, team: string): Promise<{ grade: Grade; why: string } | null> {
  const r = await askModel({
    purpose: "desk_check", maxTokens: 250, effort: "low",
    schema: { type: "object", additionalProperties: false, required: ["grade", "why"], properties: { grade: { type: "string", enum: ["MATCHES", "USEFUL", "BESIDE_THE_POINT", "WRONG"] }, why: { type: "string" } } },
    system: [
      "A partner store asked LabStack's operations desk something in WhatsApp. You are given what a human on the team actually replied, and a reply a bot would have sent instead. Grade the bot's reply against the human's.",
      "MATCHES: it tells the store the same thing the human did. USEFUL: different words or an earlier step (for example, saying the lab is being asked, when the human went on to give the lab's answer), with nothing wrong and nothing beside the point.",
      "BESIDE_THE_POINT: true perhaps, but it does not address what the store asked — a status line where the store wanted a reason, an action or a next step. WRONG: it states something the human's reply shows to be false, or promises what was not done.",
    ].join("\n"),
    user: `STORE ASKED: ${question}\n\nHUMAN REPLIED: ${team}\n\nBOT WOULD REPLY: ${reply}`,
  });
  if (!r) return null;
  try { const p = JSON.parse(r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1)); return { grade: p.grade, why: String(p.why ?? "").slice(0, 160) }; } catch { return null; }
}

async function main() {
  const storeId = Number(process.argv[2] ?? 6);
  const days = Number(process.argv[3] ?? 7);
  const limit = Number(process.argv[4] ?? 60);
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.agentShadowEval.findMany({ where: { storeId, at: { gte: since } }, orderBy: { at: "desc" }, take: limit, select: { messageId: true, intent: true, orderId: true, at: true, question: true, botDraft: true, teamReply: true, verdict: true } });
  if (!rows.length) { console.log("no store messages kept for this window — the nightly readiness run fills them"); return; }
  const [state, coaching, team] = await Promise.all([loadGuardState(), coachingBlock({ storeId }, "store"), loadTeam()]);
  const isTeam = makeTeamMatcher(team);
  console.log(`Desk replay — store ${storeId}, ${rows.length} store messages since ${clock(since)} (newest first)\n`);

  const tally = { answer: 0, ask_lab: 0, handoff: 0, silent: 0, held: 0, failed: 0 };
  const grades: Record<string, number> = {}; const oldVerdicts: Record<string, number> = {};
  let withTeam = 0; let newSpoke = 0; let oldSpoke = 0; let tokens = 0;
  for (const row of rows) {
    const m = await prisma.waMessage.findUnique({ where: { id: row.messageId }, select: { text: true, groupId: true, senderJid: true, replyToWaId: true, ts: true } });
    if (!m) continue;
    const quoted = m.replyToWaId ? await prisma.waMessage.findUnique({ where: { waMsgId: m.replyToWaId }, select: { text: true } }) : null;
    // The order as it stood when the message came: the last console change the journey saw before it.
    const asOf = new Map<number, { orderStatus: string; appointmentTime: Date | null }>();
    let labId: number | null = null;
    if (row.orderId) {
      const j = await prisma.agentJourney.findUnique({ where: { orderId: row.orderId }, select: { id: true, labId: true } });
      labId = j?.labId ?? null;
      const ev = j ? await prisma.agentJourneyEvent.findFirst({ where: { journeyId: j.id, kind: "console_change", at: { lte: m.ts } }, orderBy: { at: "desc" }, select: { payload: true } }) : null;
      const to = (ev?.payload as { to?: { status?: string; appointmentTime?: string | null } } | null)?.to;
      if (to?.status) asOf.set(row.orderId, { orderStatus: to.status, appointmentTime: to.appointmentTime ? new Date(to.appointmentTime) : null });
    }
    const before = await prisma.waMessage.findMany({ where: { groupId: m.groupId, ts: { lt: m.ts, gte: new Date(m.ts.getTime() - 45 * 60_000) } }, orderBy: { ts: "desc" }, take: 8, select: { ts: true, text: true, sender: true, senderJid: true, fromMe: true, intent: true } });
    const thread = before.reverse().map((b) => `  ${clock(b.ts)} ${b.fromMe || isAutomated(b) ? "us" : isTeam(b.sender, b.senderJid) ? "our team" : "store"}: ${mask(b.text, 200)}`).join("\n");
    const [context, examples, reachable] = await Promise.all([
      row.orderId ? contextFor([row.orderId], m.ts, { groupId: m.groupId, senderJid: m.senderJid, asOf }) : Promise.resolve(""),
      teamExamples(storeId, m.text, m.ts),
      labId != null ? labChaseable(labId, state.desks).catch(() => false) : Promise.resolve(false),
    ]);
    const out = await runDesk({ storeId, orderId: row.orderId, text: m.text, quotedText: quoted?.text ?? null, context, thread, labReachable: reachable, coaching, examples });
    if (!out) { tally.failed += 1; continue; }
    tally[out.plan.action] += 1;
    if (out.check && !out.check.ok) tally.held += 1;
    oldVerdicts[row.verdict] = (oldVerdicts[row.verdict] ?? 0) + 1;
    if (row.botDraft && !row.botDraft.startsWith("[")) oldSpoke += 1;
    let g: Awaited<ReturnType<typeof grade>> = null;
    if (out.plan.reply) newSpoke += 1;
    if (row.teamReply) {
      withTeam += 1;
      if (out.plan.reply) { g = await grade(row.question, out.plan.reply, row.teamReply); if (g) grades[g.grade] = (grades[g.grade] ?? 0) + 1; }
      else grades[out.plan.action === "silent" ? "SILENT_BUT_TEAM_ANSWERED" : "HANDED_TO_TEAM"] = (grades[out.plan.action === "silent" ? "SILENT_BUT_TEAM_ANSWERED" : "HANDED_TO_TEAM"] ?? 0) + 1;
    }
    console.log(`── ${clock(row.at)} · #${row.orderId ?? "—"} · old kind "${row.intent}"`);
    console.log(`   store:      ${mask(row.question, 220)}`);
    console.log(`   understood: ${out.understanding.question} [${out.understanding.topic}]`);
    console.log(`   old desk:   ${row.botDraft ? mask(row.botDraft, 180) : "(nothing)"}  → ${row.verdict}`);
    console.log(`   new desk:   ${out.plan.action.toUpperCase()}${out.plan.reply ? ` — ${mask(out.plan.reply, 220)}` : ""}${out.plan.labQuestion ? `\n               asks the lab: ${mask(out.plan.labQuestion, 180)}` : ""}${!out.plan.reply ? `  (${mask(out.plan.reason, 140)})` : ""}`);
    console.log(`   team said:  ${row.teamReply ? mask(row.teamReply, 220) : "(nothing within the window)"}${g ? `\n   grade:      ${g.grade} — ${g.why}` : ""}`);
  }
  const n = rows.length - tally.failed;
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "—");
  console.log(`\n══ Summary (${n} messages)`);
  console.log(`New desk: answered ${tally.answer} · asked the lab ${tally.ask_lab} · handed to a person ${tally.handoff} · stayed silent ${tally.silent}  (${tally.held} replies held by the check; ${tally.failed} model failures)`);
  console.log(`Spoke in the group: new ${newSpoke} (${pct(newSpoke, n)}) · old ${oldSpoke} (${pct(oldSpoke, n)})`);
  console.log(`Against the team's reply (${withTeam} messages the team answered): ${Object.entries(grades).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}`);
  const good = (grades.MATCHES ?? 0) + (grades.USEFUL ?? 0); const bad = (grades.WRONG ?? 0) + (grades.BESIDE_THE_POINT ?? 0);
  console.log(`  of the replies it would have sent where the team also answered: ${pct(good, good + bad)} right or useful, ${bad} wrong or beside the point`);
  console.log(`Old desk's verdicts on the same messages: ${Object.entries(oldVerdicts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  void tokens;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
