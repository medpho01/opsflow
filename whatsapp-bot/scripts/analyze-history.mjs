#!/usr/bin/env node
/**
 * Analyze out/history.jsonl (all Labstack groups, scraped via Baileys) into the
 * same artifacts the export-based analysis produced:
 *   out/messages.csv   one row per message + bot decision
 *   out/stats.json     aggregates for the PRD
 *
 * Same classifier + playbook as the live bot, so it stays a faithful preview.
 *   node scripts/analyze-history.mjs [out/history.jsonl]
 */
import fs from "node:fs";
import path from "node:path";
import { classify, extractIds, DISPOSITION, isLabstack } from "../lib/classifier.mjs";
import { PLAYBOOK, confidenceFor } from "../lib/playbook.mjs";

const IN = process.argv[2] || path.join(process.cwd(), "out", "history.jsonl");
const OUT = path.join(process.cwd(), "out");
fs.mkdirSync(OUT, { recursive: true });

if (!fs.existsSync(IN)) { console.error(`no history at ${IN} — run scrape-history.mjs first`); process.exit(1); }

// Strip every line-separator variant (CR, LF, VT, FF, NEL, LS, PS) so no cell
// can break a CSV row.
const csvCell = (v) => {
  const s = (v ?? "").toString().replace(new RegExp("[\\r\\n\\u000B\\u000C\\u0085\\u2028\\u2029]+", "g"), " / ").replace(/\t/g, " ");
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const COLUMNS = ["date","time","group","sender","side","message","has_id","ids","intent","disposition","action_type","needs_db_lookup","confidence","phase","owner","bot_action_or_reply"];

const rows = [];
const overall = { total: 0, substantive: 0, withId: 0, intents: {}, disp: {} };
const groups = new Map();  // subject -> {total,substantive,withId,disp,days:Set}
const examples = {};

const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" }); };
const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" }); };

for (const line of fs.readFileSync(IN, "utf8").split("\n").filter(Boolean)) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  const text = (o.text || "").trim();
  if (!text) continue;
  const subject = o.group || o.jid || "?";
  const intent = classify(text, o.sender);
  const disp = DISPOSITION[intent];
  const { ids, hasId } = extractIds(text);
  const pb = PLAYBOOK[intent] || {};
  const side = isLabstack(o.sender) ? "LAB" : "PARTNER";
  const conf = confidenceFor(intent, hasId);
  let action = "";
  if (pb.action === "AUTO_REPLY") action = hasId ? pb.reply(ids[0]) : "Ask for a valid order/booking id (auto)";
  else action = pb.reply ? pb.reply(ids[0]) : (pb.summary || disp);

  rows.push([
    fmtDate(o.ts), fmtTime(o.ts), subject, o.sender || "", side, text,
    hasId ? "Y" : "N", ids.join(" "), intent, disp, pb.action || "",
    pb.lookup ? "Y" : "N", conf, pb.phase || "", pb.owner || "", action,
  ]);

  let g = groups.get(subject);
  if (!g) { g = { total: 0, substantive: 0, withId: 0, disp: {}, days: new Set() }; groups.set(subject, g); }
  g.total++; g.days.add(fmtDate(o.ts));
  g.disp[disp] = (g.disp[disp] || 0) + 1;
  overall.total++;
  overall.intents[intent] = (overall.intents[intent] || 0) + 1;
  overall.disp[disp] = (overall.disp[disp] || 0) + 1;
  if (hasId) { g.withId++; overall.withId++; }
  if (intent !== "NOISE" && intent !== "SYSTEM") { g.substantive++; overall.substantive++; }
  if (!examples[intent]) examples[intent] = [];
  if (examples[intent].length < 12 && intent !== "NOISE" && intent !== "SYSTEM" && text.length > 3)
    examples[intent].push({ side, text: text.replace(/\s+/g, " ").slice(0, 200) });
}

fs.writeFileSync(path.join(OUT, "messages.csv"),
  [COLUMNS.join(",")].concat(rows.map((r) => r.map(csvCell).join(","))).join("\n") + "\n");

const sub = overall.substantive || 1;
const d = (k) => overall.disp[k] || 0;
const autoNow = d("AUTO_ANSWER");
const withLLM = autoNow + (overall.intents.ID_ONLY || 0) + Math.round((overall.intents.OTHER || 0) * 0.5);
const routable = d("ROUTE_CONSOLE") + d("OUTBOUND");
const stats = {
  generatedFrom: IN,
  totals: { messages: overall.total, substantive: overall.substantive, withId: overall.withId, groups: groups.size },
  intents: overall.intents,
  dispositions: overall.disp,
  ceiling: {
    autoAnswerNow_pctOfSubstantive: +(100 * autoNow / sub).toFixed(1),
    autoAnswerWithLLM_pctOfSubstantive: +(100 * withLLM / sub).toFixed(1),
    routableNoHumanReply_pctOfSubstantive: +(100 * routable / sub).toFixed(1),
    fullyDeflectable_pctOfSubstantive: +(100 * (autoNow + routable) / sub).toFixed(1),
  },
  perGroup: [...groups.entries()].sort((a, b) => b[1].total - a[1].total).map(([name, g]) => ({
    name, days: g.days.size, total: g.total, substantive: g.substantive, withId: g.withId,
    topDisp: Object.entries(g.disp).sort((a, b) => b[1] - a[1]).slice(0, 6),
  })),
  examples,
};
fs.writeFileSync(path.join(OUT, "stats.json"), JSON.stringify(stats, null, 2));

const pct = (n) => `${(100 * n / sub).toFixed(1)}%`;
console.log(`groups: ${groups.size}  messages: ${overall.total}  substantive: ${overall.substantive}  with-id: ${overall.withId}`);
console.log("\ndisposition (share of substantive):");
for (const [k, v] of Object.entries(overall.disp).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${String(v).padStart(6)}  ${pct(v)}`);
console.log("\nceiling:", JSON.stringify(stats.ceiling));
console.log(`\nwrote ${rows.length} rows → out/messages.csv  +  out/stats.json`);
