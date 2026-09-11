#!/usr/bin/env node
/**
 * Build the LabStack WhatsApp-bot analysis artifacts from the chat exports:
 *
 *   out/messages.csv   one row per message + the bot's decision (living sheet)
 *   out/stats.json     aggregates for the PRD (intent mix, dispositions,
 *                      per-group, automation ceiling, per-intent examples)
 *
 * Uses the SAME classifier + playbook the live bot uses, so the sheet is a
 * faithful preview of production behaviour.
 *
 *   node scripts/build-analysis.mjs "<dir of exports>"   (default /tmp/wa_analysis)
 */
import fs from "node:fs";
import path from "node:path";
import { classify, extractIds, DISPOSITION, isLabstack, parseExport } from "../lib/classifier.mjs";
import { PLAYBOOK, confidenceFor } from "../lib/playbook.mjs";

const ROOT = process.argv[2] || "/tmp/wa_analysis";
const OUT = path.join(process.cwd(), "out");
fs.mkdirSync(OUT, { recursive: true });

// CSV writer — RFC-4180 quoting, one-line cells.
const csvCell = (v) => {
  const s = (v === null || v === undefined ? "" : String(v)).replace(/[\r\n\u000B\u000C\u0085\u2028\u2029]+/g, " / ").replace(/\t/g, " ");
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const COLUMNS = [
  "date", "time", "group", "sender", "side", "message",
  "has_id", "ids", "intent", "disposition", "action_type",
  "needs_db_lookup", "confidence", "phase", "owner", "bot_action_or_reply",
];

const rows = [];
const overall = { total: 0, substantive: 0, withId: 0, intents: {}, disp: {}, action: {}, phase: {}, conf: {} };
const perGroup = [];
const examples = {}; // intent -> [{side,text}]

const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

for (const dir of dirs) {
  const file = path.join(ROOT, dir, "_chat.txt");
  if (!fs.existsSync(file)) continue;
  const msgs = parseExport(fs.readFileSync(file, "utf8"));
  const g = { name: dir, total: msgs.length, substantive: 0, withId: 0, disp: {}, intents: {}, days: new Set() };

  for (const m of msgs) {
    const intent = classify(m.text, m.sender);
    const disp = DISPOSITION[intent];
    const { ids, hasId } = extractIds(m.text);
    const pb = PLAYBOOK[intent] || {};
    const side = isLabstack(m.sender) ? "LAB" : "PARTNER";
    const conf = confidenceFor(intent, hasId);

    // What the bot would actually do / say, as a concrete string.
    let action = "";
    if (pb.action === "AUTO_REPLY") action = hasId ? pb.reply(ids[0]) : "Ask for a valid order/booking id (auto)";
    else action = pb.reply ? pb.reply(ids[0]) : (pb.summary || disp);

    rows.push([
      m.date, m.time, dir, m.sender, side, m.text,
      hasId ? "Y" : "N", ids.join(" "), intent, disp, pb.action || "",
      pb.lookup ? "Y" : "N", conf, pb.phase || "", pb.owner || "", action,
    ]);

    // aggregates
    g.days.add(m.date);
    g.intents[intent] = (g.intents[intent] || 0) + 1;
    g.disp[disp] = (g.disp[disp] || 0) + 1;
    overall.intents[intent] = (overall.intents[intent] || 0) + 1;
    overall.disp[disp] = (overall.disp[disp] || 0) + 1;
    overall.action[pb.action || "?"] = (overall.action[pb.action || "?"] || 0) + 1;
    overall.phase[pb.phase || "?"] = (overall.phase[pb.phase || "?"] || 0) + 1;
    overall.conf[conf] = (overall.conf[conf] || 0) + 1;
    if (hasId) { g.withId++; overall.withId++; }
    if (intent !== "NOISE" && intent !== "SYSTEM") { g.substantive++; overall.substantive++; }
    if (!examples[intent]) examples[intent] = [];
    if (examples[intent].length < 12 && intent !== "NOISE" && intent !== "SYSTEM" && m.text.trim().length > 3)
      examples[intent].push({ side, text: m.text.replace(/\s+/g, " ").slice(0, 200) });
  }
  overall.total += g.total;
  perGroup.push({ ...g, days: g.days.size });
}

// ── write CSV ──────────────────────────────────────────────────────────────
const csv = [COLUMNS.join(",")].concat(rows.map((r) => r.map(csvCell).join(","))).join("\n");
fs.writeFileSync(path.join(OUT, "messages.csv"), csv + "\n");

// ── automation ceiling ──────────────────────────────────────────────────────
const sub = overall.substantive;
const d = (k) => overall.disp[k] || 0;
const autoNow = d("AUTO_ANSWER");                                  // rules + replica today
const withLLM = autoNow + (overall.intents.ID_ONLY || 0) + Math.round((overall.intents.OTHER || 0) * 0.5);
const routable = d("ROUTE_CONSOLE") + d("OUTBOUND");               // handled without a human typing a reply
const stats = {
  generatedFrom: ROOT,
  totals: { messages: overall.total, substantive: sub, withId: overall.withId },
  intents: overall.intents,
  dispositions: overall.disp,
  actions: overall.action,
  phases: overall.phase,
  confidence: overall.conf,
  ceiling: {
    autoAnswerNow_pctOfSubstantive: +(100 * autoNow / sub).toFixed(1),
    autoAnswerWithLLM_pctOfSubstantive: +(100 * withLLM / sub).toFixed(1),
    routableNoHumanReply_pctOfSubstantive: +(100 * routable / sub).toFixed(1),
    fullyDeflectable_pctOfSubstantive: +(100 * (autoNow + routable) / sub).toFixed(1),
  },
  perGroup: perGroup.map((g) => ({
    name: g.name, days: g.days, total: g.total, substantive: g.substantive, withId: g.withId,
    topDisp: Object.entries(g.disp).sort((a, b) => b[1] - a[1]).slice(0, 6),
  })),
  examples,
};
fs.writeFileSync(path.join(OUT, "stats.json"), JSON.stringify(stats, null, 2));

// ── console summary ──────────────────────────────────────────────────────────
const pct = (n) => `${(100 * n / sub).toFixed(1)}%`;
console.log(`messages: ${overall.total}  substantive: ${sub}  with-id: ${overall.withId} (${(100*overall.withId/overall.total).toFixed(1)}%)`);
console.log("\ndisposition (share of substantive):");
for (const [k, v] of Object.entries(overall.disp).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${String(v).padStart(6)}  ${pct(v)}`);
console.log("\nceiling:", JSON.stringify(stats.ceiling, null, 0));
console.log(`\nwrote ${rows.length} rows → out/messages.csv`);
console.log(`wrote stats → out/stats.json`);
