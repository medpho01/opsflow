/**
 * Why a store's questions are not being answered by its desk (10 Nov 2026). For one store (default
 * 6, Plum) over the last N days (default 7): what the desk decided about each store message and why
 * it held back, by kind of question; how its drafts compared with what the team then said; what is
 * muted by coaching; which actions wait for a person's click and for how long. Read-only; counts and
 * order ids only, no message text.
 *
 *   docker compose -f docker-compose.yml -f docker-compose.wa.yml exec -T app npx tsx scripts/plum-gaps.ts          # store 6, 7 days
 *   … scripts/plum-gaps.ts 6 3
 */
import prisma from "@/lib/db/client";

const pad = (s: unknown, n: number) => String(s ?? "").padEnd(n).slice(0, n);
const tally = <T>(rows: T[], key: (r: T) => string) => { const m = new Map<string, number>(); for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
const why = (b: string | null) => (b ?? "").replace(/\d{4,}/g, "#").replace(/"[^"]*"/g, '"…"').slice(0, 70) || "—";

async function main() {
  const storeId = Number(process.argv[2] ?? 6);
  const days = Number(process.argv[3] ?? 7);
  const since = new Date(Date.now() - days * 86_400_000);
  const desk = await prisma.agentDeskState.findFirst({ where: { desk: "STORE", scopeKind: "STORE", scopeId: storeId } });
  console.log(`Store ${storeId} desk: ${desk?.state ?? "OFF"} since ${desk?.liveSince?.toISOString().slice(0, 10) ?? "—"} · answers itself: ${desk?.liveIntents.length ? desk.liveIntents.join(", ") : "every kind"} · last ${days} days\n`);

  const journeys = await prisma.agentJourney.findMany({ where: { storeId }, select: { id: true } });
  const actions = await prisma.agentAction.findMany({ where: { desk: "STORE", createdAt: { gte: since }, journeyId: { in: journeys.map((j) => j.id) } }, select: { action: true, outcome: true, blockedBy: true, params: true, orderId: true, level: true } });
  console.log(`1. What the desk decided (${actions.length} decisions)`);
  for (const [k, n] of tally(actions, (a) => `${pad(a.action, 14)} ${pad(a.outcome, 9)} ${why(a.blockedBy)}`).slice(0, 30)) console.log(`   ${String(n).padStart(4)}  ${k}`);

  const replies = actions.filter((a) => ["store_reply", "ack"].includes(a.action));
  console.log(`\n2. Replies by kind of question: sent / held for a person / other`);
  const kinds = new Map<string, { sent: number; held: number; other: number; templates: Map<string, number> }>();
  for (const a of replies) {
    const p = a.params as { intent?: string; template?: string };
    const k = kinds.get(p.intent ?? "(none)") ?? kinds.set(p.intent ?? "(none)", { sent: 0, held: 0, other: 0, templates: new Map() }).get(p.intent ?? "(none)")!;
    if (a.outcome === "EXECUTED" || a.outcome === "PENDING") k.sent += 1; else if (a.outcome === "RECORDED" || a.outcome === "REVIEW") k.held += 1; else k.other += 1;
    k.templates.set(p.template ?? "—", (k.templates.get(p.template ?? "—") ?? 0) + 1);
  }
  for (const [k, v] of [...kinds].sort((a, b) => b[1].sent + b[1].held - a[1].sent - a[1].held)) console.log(`   ${pad(k, 16)} ${String(v.sent).padStart(4)} / ${String(v.held).padStart(4)} / ${String(v.other).padStart(4)}   ${[...v.templates].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t} ${n}`).join(", ")}`);

  const evals = await prisma.agentShadowEval.findMany({ where: { storeId, at: { gte: since } }, select: { intent: true, verdict: true, orderId: true, note: true } });
  console.log(`\n3. The desk's drafts against what the team said (${evals.length} store messages)`);
  const verdicts = [...new Set(evals.map((e) => e.verdict))].sort();
  console.log(`   ${pad("kind", 16)} ${verdicts.map((v) => pad(v, 11)).join(" ")}`);
  for (const [intent] of tally(evals, (e) => e.intent)) console.log(`   ${pad(intent, 16)} ${verdicts.map((v) => pad(evals.filter((e) => e.intent === intent && e.verdict === v).length || "", 11)).join(" ")}`);
  for (const v of ["MISSED", "WRONG_LINK", "CONTRADICTS", "WOULD_FAIL", "UNWANTED"]) {
    const rows = evals.filter((e) => e.verdict === v);
    if (rows.length) console.log(`   ${v}: ${[...new Set(rows.map((e) => e.orderId).filter(Boolean))].slice(0, 15).map((x) => `#${x}`).join(" ")}`);
  }
  const notes = evals.filter((e) => ["CONTRADICTS", "WRONG_LINK", "WOULD_FAIL"].includes(e.verdict) && e.note).slice(0, 12);
  for (const e of notes) console.log(`     ${e.verdict} ${e.intent} #${e.orderId ?? "—"}: ${String(e.note).replace(/\d{10}/g, "<phone>").slice(0, 150)}`);

  const lessons = await prisma.agentCoaching.findMany({ where: { status: "ACTIVE", scope: { in: ["GLOBAL", `STORE:${storeId}`] } }, select: { scope: true, lesson: true, createdAt: true } });
  console.log(`\n4. Active coaching lessons that hold replies back: ${lessons.length}`);
  for (const l of lessons.slice(0, 25)) { const x = (l.lesson ?? {}) as { kind?: string; rule?: string; applies?: string[] }; console.log(`   ${l.createdAt.toISOString().slice(0, 10)} ${pad(l.scope, 9)} ${pad(x.kind, 10)} ${pad((x.applies ?? []).join(","), 28)} ${String(x.rule ?? "").slice(0, 110)}`); }

  const autonomy = await prisma.agentAutonomy.findMany({ where: { level: { in: ["SHADOW", "SUGGEST"] } }, select: { action: true, desk: true, scopeKind: true, scopeKey: true, level: true } });
  console.log(`\n5. Actions set to wait for a person or only be recorded (${autonomy.length} rules; store_warning and status_write wait by default)`);
  for (const a of autonomy) console.log(`   ${pad(a.desk, 6)} ${pad(a.action, 18)} ${pad(`${a.scopeKind}:${a.scopeKey}`, 14)} ${a.level}`);

  const review = await prisma.agentReviewItem.findMany({ where: { createdAt: { gte: since } }, select: { kind: true, desk: true, decision: true, createdAt: true, decidedAt: true } });
  console.log(`\n6. Items that waited for a click, all stores and labs (${review.length})`);
  for (const [k] of tally(review, (r) => `${r.desk} ${r.kind}`)) {
    const rows = review.filter((r) => `${r.desk} ${r.kind}` === k);
    const done = rows.filter((r) => r.decidedAt);
    const waits = done.map((r) => (r.decidedAt!.getTime() - r.createdAt.getTime()) / 60_000).sort((a, b) => a - b);
    console.log(`   ${pad(k, 22)} ${String(rows.length).padStart(4)} raised · ${String(rows.length - done.length).padStart(4)} never decided · decided: ${tally(done, (r) => r.decision ?? "—").map(([d, n]) => `${d} ${n}`).join(", ") || "—"}${waits.length ? ` · median wait ${Math.round(waits[Math.floor(waits.length / 2)])} min` : ""}`);
  }
  const labReview = await prisma.agentAction.findMany({ where: { desk: "LAB", outcome: "REVIEW", createdAt: { gte: since } }, select: { action: true, params: true, level: true } });
  console.log(`\n7. Lab actions sent to review (${labReview.length})`);
  for (const [k, n] of tally(labReview, (a) => { const p = a.params as { intent?: string; taskType?: string; alwaysSuggest?: boolean; rung?: string; to?: string }; return `${pad(a.action, 14)} ${pad(p.intent ?? p.taskType ?? p.to ?? "", 24)} level ${a.level}${p.alwaysSuggest ? " (SOP: always suggest)" : ""}`; })) console.log(`   ${String(n).padStart(4)}  ${k}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
