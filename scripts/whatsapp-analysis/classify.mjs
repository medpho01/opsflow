#!/usr/bin/env node
/**
 * WhatsApp partner-ops traffic — offline measurement report.
 *
 * Thin wrapper over the SHARED classifier in whatsapp-bot/lib/classifier.mjs
 * (the same code the live bot runs). Parses the exports, classifies every
 * message, and prints the intent/disposition breakdown + the automatable
 * headline. Optional: DUMP=<INTENT> DUMP_N=50 dumps examples for tuning.
 *
 * Run:  node scripts/whatsapp-analysis/classify.mjs "<dir of _chat.txt>"
 */
import fs from "node:fs";
import path from "node:path";
import { classify, extractIds, DISPOSITION, isLabstack, parseExport } from "../../whatsapp-bot/lib/classifier.mjs";

const ROOT = process.argv[2] || "/tmp/wa_analysis";
const DUMP = process.env.DUMP;
const DUMP_N = parseInt(process.env.DUMP_N || "50", 10);
const dumped = [];

const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const overall = { intents: {}, disp: {}, total: 0, withId: 0, substantive: 0 };
const perGroup = [];

for (const dir of dirs) {
  const file = path.join(ROOT, dir, "_chat.txt");
  if (!fs.existsSync(file)) continue;
  const msgs = parseExport(fs.readFileSync(file, "utf8"));
  const g = { name: dir, intents: {}, disp: {}, total: msgs.length, withId: 0, substantive: 0, days: new Set() };
  for (const m of msgs) {
    g.days.add(m.date);
    const intent = classify(m.text, m.sender);
    const disp = DISPOSITION[intent];
    const { hasId } = extractIds(m.text);
    g.intents[intent] = (g.intents[intent] || 0) + 1;
    g.disp[disp] = (g.disp[disp] || 0) + 1;
    overall.intents[intent] = (overall.intents[intent] || 0) + 1;
    overall.disp[disp] = (overall.disp[disp] || 0) + 1;
    if (hasId) { g.withId++; overall.withId++; }
    if (intent !== "NOISE" && intent !== "SYSTEM") { g.substantive++; overall.substantive++; }
    if (DUMP && intent === DUMP && dumped.length < DUMP_N)
      dumped.push(`[${isLabstack(m.sender) ? "LAB" : "PTR"}] ${m.text.replace(/\n/g, " ⏎ ").slice(0, 160)}`);
  }
  overall.total += g.total;
  perGroup.push(g);
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "0%");
const sortEntries = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);

console.log("═".repeat(70));
console.log("WHATSAPP PARTNER-OPS TRAFFIC — MEASURED CLASSIFICATION");
console.log("═".repeat(70));
console.log(`Groups: ${perGroup.length} · Total messages: ${overall.total}`);
console.log(`Substantive (non-noise/system): ${overall.substantive} (${pct(overall.substantive, overall.total)})`);
console.log(`Carry an order/request id: ${overall.withId} (${pct(overall.withId, overall.total)})`);

console.log("\n── INTENT MIX (all messages) ──");
for (const [k, v] of sortEntries(overall.intents)) console.log(`  ${k.padEnd(16)} ${String(v).padStart(6)}  ${pct(v, overall.total)}`);

console.log("\n── DISPOSITION (what the bot does) ──");
for (const [k, v] of sortEntries(overall.disp)) console.log(`  ${k.padEnd(14)} ${String(v).padStart(6)}  ${pct(v, overall.total)}`);

const sub = overall.substantive;
const d = (k) => overall.disp[k] || 0;
console.log("\n── HEADLINE (share of SUBSTANTIVE work) ──");
console.log(`  Bot auto-answers (read status):      ${pct(d("AUTO_ANSWER"), sub)}  (${d("AUTO_ANSWER")})`);
console.log(`  Bot → console task (action):         ${pct(d("ROUTE_CONSOLE"), sub)}  (${d("ROUTE_CONSOLE")})`);
console.log(`  Needs lab (slots/serviceability):    ${pct(d("NEEDS_LAB"), sub)}  (${d("NEEDS_LAB")})`);
console.log(`  LabStack outbound (auto-postable):   ${pct(d("OUTBOUND"), sub)}  (${d("OUTBOUND")})`);
console.log(`  Human (escalation/tech):             ${pct(d("HUMAN"), sub)}  (${d("HUMAN")})`);
console.log(`  Unclassified (needs review/LLM):     ${pct(d("REVIEW"), sub)}  (${d("REVIEW")})`);

console.log("\n── PER-GROUP ──");
for (const g of perGroup) {
  console.log(`\n  ${g.name}  (${g.days.size} active days, ${g.total} msgs)`);
  for (const [k, v] of sortEntries(g.disp).filter(([k]) => k !== "NOISE").slice(0, 6)) console.log(`     ${k.padEnd(14)} ${String(v).padStart(5)}  ${pct(v, g.total)}`);
}
if (DUMP) { console.log(`\n── ${dumped.length} EXAMPLES of intent=${DUMP} ──`); for (const x of dumped) console.log("  " + x); }
console.log("\n" + "═".repeat(70));
