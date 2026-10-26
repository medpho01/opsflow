/**
 * Score the reader and the linker against a case file (scripts/eval-build-cases.ts),
 * and gate a change on it (27 Oct 2026).
 *
 * For every case the reader is run again (the model when ANTHROPIC_API_KEY is
 * set, the patterns otherwise) and compared with:
 *   - `expected` where someone filled it in (the ground truth);
 *   - otherwise the bot's own reading at the time (drift: what would change).
 * Order linking is scored on the ids the store wrote (the pure linker).
 *
 *   npx tsx scripts/eval-run.ts ~/eval-cases.json                 # report
 *   npx tsx scripts/eval-run.ts ~/eval-cases.json --baseline      # save scores as the baseline
 *   npx tsx scripts/eval-run.ts ~/eval-cases.json --gate          # exit 1 if worse than the baseline by > 2 points
 */
import fs from "node:fs";
import path from "node:path";
import { readMessage } from "@/lib/agents/reader/read";
import { explicitOrderIds } from "@/lib/agents/store/reader";

type Case = { id: string; side: "lab" | "store"; text: string; quoted: string | null; bot: { intent: string | null; orders: number[] }; expected: { intent: string | null; orders: number[] | null }; lesson: string | null };

async function main() {
  const file = process.argv[2];
  if (!file) { console.log("usage: npx tsx scripts/eval-run.ts <cases.json> [--baseline] [--gate]"); return; }
  const { cases } = JSON.parse(fs.readFileSync(file, "utf8")) as { cases: Case[] };
  const labelled = cases.filter((c) => c.expected.intent || c.expected.orders);
  const pool = labelled.length ? labelled : cases;
  let intentHits = 0; let intentTotal = 0; let linkHits = 0; let linkTotal = 0; let drift = 0;
  const misses: string[] = [];
  for (const c of pool) {
    const reading = await readMessage({ side: c.side, text: c.text, quotedText: c.quoted, scope: {} }).catch(() => null);
    if (!reading) continue;
    const got = reading.ack || reading.request.kind === "none" ? "none" : reading.request.kind;
    const want = c.expected.intent ?? (c.bot.intent?.replace(/^STORE_/, "").toLowerCase() ?? null);
    if (want) {
      intentTotal += 1;
      if (got === want) intentHits += 1; else { if (!c.expected.intent) drift += 1; misses.push(`${c.side} intent: wanted ${want}, got ${got} — "${c.text.slice(0, 80)}"`); }
    }
    if (c.side === "store") {
      const written = explicitOrderIds(c.text);
      const want = c.expected.orders ?? (written.length ? written : null);
      if (want) {
        linkTotal += 1;
        const same = want.length === written.length && want.every((id) => written.includes(id));
        if (same) linkHits += 1; else misses.push(`store link: wanted #${want.join(",#")}, read #${written.join(",#") || "none"} — "${c.text.slice(0, 80)}"`);
      }
    }
  }
  const scores = { intent: intentTotal ? Math.round((100 * intentHits) / intentTotal) : null, linking: linkTotal ? Math.round((100 * linkHits) / linkTotal) : null };
  console.log(`cases ${cases.length} · labelled ${labelled.length} · scored ${pool.length}${labelled.length ? "" : " (no labels yet: scoring drift against the bot's own readings)"}`);
  console.log(`intent ${scores.intent ?? "—"}% (${intentHits}/${intentTotal})${labelled.length ? "" : ` · would change ${drift}`} · linking ${scores.linking ?? "—"}% (${linkHits}/${linkTotal})`);
  for (const m of misses.slice(0, 25)) console.log("  ✗ " + m);
  const baselinePath = path.join(path.dirname(file), "eval-baseline.json");
  if (process.argv.includes("--baseline")) { fs.writeFileSync(baselinePath, JSON.stringify({ at: new Date().toISOString(), scores }, null, 2)); console.log(`baseline saved: ${baselinePath}`); }
  if (process.argv.includes("--gate") && fs.existsSync(baselinePath)) {
    const base = JSON.parse(fs.readFileSync(baselinePath, "utf8")).scores as typeof scores;
    const worse = (["intent", "linking"] as const).filter((k) => base[k] != null && scores[k] != null && scores[k]! < base[k]! - 2);
    if (worse.length) { console.log(`GATE FAILED: ${worse.map((k) => `${k} ${base[k]} → ${scores[k]}`).join(", ")}`); process.exit(1); }
    console.log("gate passed");
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
