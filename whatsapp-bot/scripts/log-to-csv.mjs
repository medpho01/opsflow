#!/usr/bin/env node
/**
 * Append newly-observed live messages to out/messages.csv in the SAME schema
 * the analysis produced, so the Google Sheet keeps growing.
 *
 *   node scripts/log-to-csv.mjs            # reads ./dry-run.log.jsonl
 *   node scripts/log-to-csv.mjs path.jsonl
 *
 * Idempotent: skips rows already present (keyed by ts+jid+message), so it's
 * safe to run on a cron / after each dry-run session.
 */
import fs from "node:fs";
import path from "node:path";
import { isLabstack, extractIds } from "../lib/classifier.mjs";
import { PLAYBOOK, confidenceFor } from "../lib/playbook.mjs";

const LOG = process.argv[2] || path.join(process.cwd(), "dry-run.log.jsonl");
const CSV = path.join(process.cwd(), "out", "messages.csv");
const COLUMNS = ["date","time","group","sender","side","message","has_id","ids","intent","disposition","action_type","needs_db_lookup","confidence","phase","owner","bot_action_or_reply"];

const csvCell = (v) => {
  const s = (v ?? "").toString().replace(/[\r\n\u000B\u000C\u0085\u2028\u2029]+/g, " / ").replace(/\t/g, " ");
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

if (!fs.existsSync(LOG)) { console.error(`no log at ${LOG}`); process.exit(1); }
fs.mkdirSync(path.dirname(CSV), { recursive: true });

// existing keys (col5=message, but we key on a compact hash of message+group)
const seen = new Set();
let existing = "";
if (fs.existsSync(CSV)) {
  existing = fs.readFileSync(CSV, "utf8");
  // key = group|message — cheap dedupe against re-runs
  for (const line of existing.split("\n").slice(1)) {
    const m = line.split(",");
    if (m.length > 5) seen.add(`${m[2]}|${m[5]}`.slice(0, 120));
  }
} else {
  existing = COLUMNS.join(",") + "\n";
}

const rows = [];
for (const line of fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean)) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  const ts = new Date(o.ts);
  const date = isNaN(ts) ? "" : ts.toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" });
  const time = isNaN(ts) ? "" : ts.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" });
  const group = o.group || o.jid || "";
  const text = o.text || "";
  const key = `${group}|${text}`.replace(/[",]/g, "").slice(0, 120);
  if (seen.has(key)) continue;
  seen.add(key);

  const intent = o.intent || "OTHER";
  const pb = PLAYBOOK[intent] || {};
  const { ids, hasId } = extractIds(text);
  const side = isLabstack(o.sender) ? "LAB" : "PARTNER";
  const action = o.willReply ? o.reply : (o.note || pb.summary || "");
  rows.push([
    date, time, group, o.sender || "", side, text,
    hasId ? "Y" : "N", (o.ids || ids).join(" "), intent, o.disposition || pb.disposition || "",
    pb.action || "", pb.lookup ? "Y" : "N", confidenceFor(intent, hasId), pb.phase || "", pb.owner || "", action,
  ]);
}

if (!rows.length) { console.log("no new rows to append"); process.exit(0); }
const append = rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
fs.writeFileSync(CSV, existing.endsWith("\n") ? existing + append : existing + "\n" + append);
console.log(`appended ${rows.length} new rows → out/messages.csv (total now ${existing.split("\n").length - 1 + rows.length})`);
console.log(`re-run: python3 scripts/build_xlsx.py  to refresh the workbook`);
