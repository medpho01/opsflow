/**
 * The outcome auditor on demand (29 Oct 2026): reads the store and lab groups for the last N hours,
 * judges whether the agent's jobs got done, and prints what it found. Records a brain run; sends nothing.
 *
 *   npx tsx scripts/outcomes.ts            the latest audit
 *   npx tsx scripts/outcomes.ts run 3      audit the last 3 hours now (uses the auditor model)
 */
import prisma from "@/lib/db/client";
import { latestAuditText, runOutcomeAudit, type AuditFindings } from "@/lib/agents/brain/outcomes-audit";

async function main() {
  const [mode, h] = process.argv.slice(2);
  if (mode === "run") console.log(await runOutcomeAudit(new Date(), { hours: Number(h ?? 3), kind: "outcomes" }));
  console.log(await latestAuditText());
  const run = await prisma.agentBrainRun.findFirst({ where: { kind: { in: ["outcomes", "outcomes_day"] }, finishedAt: { not: null } }, orderBy: { startedAt: "desc" }, select: { findings: true, model: true, costPaise: true, error: true } });
  const f = run?.findings as (Partial<AuditFindings> & { raw?: string }) | null;
  if (run?.error) console.log("error:", run.error);
  if (!f) return;
  if (f.raw) { console.log("model answer (end):", f.raw.slice(-600)); return; }
  console.log(`\n(model ${run?.model}, ~₹${((run?.costPaise ?? 0) / 100).toFixed(0)})`);
  for (const o of f.outcomes ?? []) { console.log(`\njob ${o.id}: ${o.status}`); for (const e of o.evidence ?? []) console.log(`  ${e.time} ${e.group} ${e.order ?? ""} — ${e.note}`); }
  if (f.humanDidAgentWork?.length) { console.log("\npeople did this by hand:"); for (const x of f.humanDidAgentWork) console.log(`  ${x.time} ${x.group} ${x.order ?? ""} — ${x.what}`); }
  if (f.noise?.length) { console.log("\nnoise:"); for (const x of f.noise) console.log(`  ${x.time} ${x.group} ${x.order ?? ""} — ${x.why}`); }
  for (const [i, p] of (f.proposals ?? []).entries()) console.log(`\n${i + 1}. [${p.kind}] ${p.title} (${Math.round((p.confidence ?? 0) * 100)}%)\n   why: ${p.why}\n   when: ${p.trigger}\n   do: ${p.action}\n   for: ${p.scope}\n   worked if: ${p.measure}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
