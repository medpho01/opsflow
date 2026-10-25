/**
 * Run the reader's anonymised cases through the MODEL (needs ANTHROPIC_API_KEY)
 * and print accuracy and every miss — the check before trusting a model or
 * prompt change. The same cases run through the pattern fallback in `npm test`.
 *
 *   docker compose exec -T app npx tsx scripts/reader-eval.ts
 */
import { EXAMPLES } from "@/lib/agents/reader/examples";
import { readMessage, readWithPatterns } from "@/lib/agents/reader/read";
import { readingMatches } from "@/lib/agents/evals/run";

async function main() {
  let pass = 0; let patternPass = 0;
  for (const e of EXAMPLES) {
    const got = await readMessage({ side: e.side, text: e.text, quotedText: e.quoted ?? null });
    const p = await readWithPatterns({ side: e.side, text: e.text, quotedText: e.quoted ?? null });
    const m = readingMatches(got, e.expect); const pm = readingMatches(p, e.expect);
    if (m.pass) pass += 1; if (pm.pass) patternPass += 1;
    if (!m.pass) console.log(`✗ ${e.side}  ${JSON.stringify(e.text.slice(0, 70))}\n   model (${got.via}): ${m.why}\n   got ${JSON.stringify({ request: got.request, samples: got.samples, events: got.events.map((x) => x.kind), orders: got.orders })}`);
  }
  console.log(`\nmodel: ${pass}/${EXAMPLES.length} · patterns: ${patternPass}/${EXAMPLES.length}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
