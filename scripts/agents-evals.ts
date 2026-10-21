/**
 * `npm run agents:evals [seed]` — run every eval suite (and seed cases first with `seed`).
 * Exits non-zero when any suite misses its gate, so CI blocks a prompt, model or SOP change.
 */
import { runAllSuites, seedFromHistory } from "../src/lib/agents/evals/run";
import prisma from "../src/lib/db/client";

async function main() {
  if (process.argv.includes("seed")) console.log("seeded", await seedFromHistory());
  const results = await runAllSuites();
  for (const r of results) console.log(`${r.passedGate ? "PASS" : "FAIL"}  ${r.suite.padEnd(18)} ${r.passed}/${r.cases}  score ${(r.score * 100).toFixed(1)}%  gate ${(r.gate * 100).toFixed(0)}%`);
  for (const r of results.filter((x) => !x.passedGate)) for (const f of r.failures.slice(0, 5)) console.log(`   ${r.suite}: got ${JSON.stringify(f.got)} wanted ${JSON.stringify(f.want)} for ${JSON.stringify(f.input).slice(0, 100)}`);
  await prisma.$disconnect();
  process.exit(results.some((r) => r.cases > 0 && !r.passedGate) ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
