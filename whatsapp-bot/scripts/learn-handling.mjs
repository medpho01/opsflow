#!/usr/bin/env node
/**
 * Learn HOW the team actually handles messages, from real traffic.
 *
 * Reconstructs partner-question → team-reply pairs by:
 *   1. explicit WhatsApp reply link (quoted message) — when present (live log),
 *   2. shared order/booking id between a partner message and a later LAB message,
 *   3. adjacency — the next LAB message after a partner question, same group.
 *
 * Then it summarises, per question-intent, how it was resolved and the REAL
 * phrasings the team uses — the ground-truth reply library that should replace
 * our guessed templates.
 *
 * Inputs (auto-detected, concatenated): out/history.jsonl (scrape) +
 * messages.log.jsonl (live transcript, richer: has fromMe + reply links).
 *
 * Outputs:
 *   out/handling.csv         one row per Q→A pair (question, team reply, how resolved)
 *   out/reply-library.json   per intent: resolution mix + top real reply templates
 *
 *   node scripts/learn-handling.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { classify, extractIds, isLabstack } from "../lib/classifier.mjs";

const OUT = path.join(process.cwd(), "out");
fs.mkdirSync(OUT, { recursive: true });
const SOURCES = [path.join(OUT, "history.jsonl"), path.join(process.cwd(), "messages.log.jsonl")];

// Signals that a message is an ANSWER (posted by the LabStack side): status
// outcomes, scheduling, prices, serviceability verdicts, report readiness.
const ANSWER_RE = /\b(done|completed|collected|delivered|scheduled|rescheduled|cancell?ed|assigned|processed|dispatched|booking created)\b|\d\s*\/-|\bpossible\b|not servic|non.?servic|slot (is )?(available|not available|booked)|report (delivered|shared|ready)|phlebo/i;

// ── load + normalise messages ────────────────────────────────────────────
const raw = [];
for (const src of SOURCES) {
  if (!fs.existsSync(src)) continue;
  for (const line of fs.readFileSync(src, "utf8").split("\n").filter(Boolean)) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    const text = (o.text || "").trim();
    if (!text) continue;
    const ts = new Date(o.ts).getTime();
    if (isNaN(ts)) continue;
    const { ids } = extractIds(text);
    // explicit side from the live transcript (fromMe / side); else infer later
    const explicitSide = o.side || (o.fromMe ? "LAB" : null);
    raw.push({
      ts, group: o.group || o.jid || "?", sender: o.sender || "(empty)", explicitSide,
      text, ids, msgId: o.msgId || null, replyToId: o.replyToId || null,
      replyToText: o.replyToText || "", intent: o.intent || classify(text, o.sender),
      answerish: ANSWER_RE.test(text),
    });
  }
}

// Infer the LAB participants per group = the senders who post the most answers.
// (History sync gives opaque @lid ids, not names, so we identify the team by
// behaviour: they're the ones who answer.)
const labByGroup = new Map();
{
  const perGroupSender = new Map(); // group -> sender -> {total, ans}
  for (const m of raw) {
    if (m.explicitSide) continue; // live data already knows the side
    const g = perGroupSender.get(m.group) || new Map();
    const s = g.get(m.sender) || { total: 0, ans: 0 };
    s.total++; if (m.answerish) s.ans++;
    g.set(m.sender, s); perGroupSender.set(m.group, g);
  }
  for (const [group, g] of perGroupSender) {
    // LAB = senders with a strong answer-signal (top answerers), min 3 answers.
    const ranked = [...g.entries()].filter(([, v]) => v.ans >= 3)
      .sort((a, b) => b[1].ans - a[1].ans);
    const lab = new Set(ranked.slice(0, 3).map(([s]) => s)); // up to 3 coordinators
    labByGroup.set(group, lab);
  }
}

const msgs = raw.map((m) => ({
  ...m,
  side: m.explicitSide || (labByGroup.get(m.group)?.has(m.sender) ? "LAB" : "PARTNER"),
}));
msgs.sort((a, b) => a.ts - b.ts);

// index by group, and by msgId for reply-link resolution
const byGroup = new Map();
const byId = new Map();
for (const m of msgs) {
  if (!byGroup.has(m.group)) byGroup.set(m.group, []);
  byGroup.get(m.group).push(m);
  if (m.msgId) byId.set(m.msgId, m);
}

// ── resolution classifier: what did the team's reply DO? ───────────────────
function resolutionOf(text) {
  const t = text.toLowerCase();
  if (/report (delivered|shared|ready|attached)|reports? (are )?(delivered|ready)|please find.*report/.test(t)) return "REPORT_SHARED";
  if (/\b(done|completed|collected|sample collected|picked up|processed)\b/.test(t)) return "COMPLETED";
  if (/schedul|slot (is )?(available|booked)|assigned|phlebo (assigned|on the way)/.test(t)) return "SCHEDULED";
  if (/reschedul/.test(t)) return "RESCHEDULED";
  if (/cancel|not serviceable|non.?servic|unable|no labs? found|no slot/.test(t)) return "CANCELLED_OR_NEGATIVE";
  if (/possible.*\d{3,5}|₹?\s*\d{3,5}\s*\/-|price|quote/.test(t)) return "QUOTED";
  if (/(share|send|provide|need|kindly send).*(dob|date of birth|number|address|name|details|report|prescription)|please share/.test(t)) return "INFO_REQUESTED";
  if (/check|will update|updating|looking into|please wait|in.?process|shortly/.test(t)) return "ACK_WORKING";
  return "OTHER";
}

// ── pair questions to the team reply that handled them ─────────────────────
const WINDOW = 6 * 3600 * 1000; // 6h
const pairs = [];
for (const [group, list] of byGroup) {
  for (let i = 0; i < list.length; i++) {
    const q = list[i];
    if (q.side !== "PARTNER") continue;              // questions come from partners
    if (q.intent === "NOISE" || q.intent === "SYSTEM") continue;

    let answer = null, how = "";
    // 1) explicit reply link — a later LAB msg quoting this one
    if (q.msgId) {
      const a = list.find((m) => m.side === "LAB" && m.replyToId === q.msgId && m.ts >= q.ts);
      if (a) { answer = a; how = "reply-link"; }
    }
    // 2) shared id — next LAB msg mentioning the same id within window
    if (!answer && q.ids.length) {
      for (let j = i + 1; j < list.length && list[j].ts - q.ts < WINDOW; j++) {
        const m = list[j];
        if (m.side === "LAB" && m.ids.some((id) => q.ids.includes(id))) { answer = m; how = "shared-id"; break; }
      }
    }
    // 3) adjacency — the next LAB msg before another partner msg, within window
    if (!answer) {
      for (let j = i + 1; j < list.length && list[j].ts - q.ts < WINDOW; j++) {
        const m = list[j];
        if (m.side === "LAB") { answer = m; how = "adjacency"; break; }
        if (m.side === "PARTNER" && m.intent !== "NOISE") break; // superseded by a new partner msg
      }
    }
    if (!answer) continue;
    pairs.push({
      group, qts: q.ts, qtext: q.text, intent: q.intent, ids: q.ids.join(" "),
      atext: answer.text, aby: answer.sender, how,
      latencyMin: Math.round((answer.ts - q.ts) / 60000),
      resolution: resolutionOf(answer.text),
    });
  }
}

// ── write handling.csv ─────────────────────────────────────────────────────
const csvCell = (v) => {
  const s = (v ?? "").toString().replace(new RegExp("[\\r\\n\\u000B\\u000C\\u0085\\u2028\\u2029]+", "g"), " / ").replace(/\t/g, " ");
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const COLS = ["group", "intent", "ids", "question", "team_reply", "replied_by", "resolution", "latency_min", "matched_by"];
const rows = pairs.map((p) => [p.group, p.intent, p.ids, p.qtext, p.atext, p.aby, p.resolution, p.latencyMin, p.how]);
fs.writeFileSync(path.join(OUT, "handling.csv"),
  [COLS.join(",")].concat(rows.map((r) => r.map(csvCell).join(","))).join("\n") + "\n");

// ── learn the reply library: per intent → resolution mix + top phrasings ───
const norm = (t) => t.toLowerCase()
  .replace(/\d+/g, "#")                       // collapse ids/numbers
  .replace(/[^\p{L}\p{N}#\s]/gu, " ")
  .replace(/\s+/g, " ").trim().slice(0, 80);
const lib = {};
for (const p of pairs) {
  const k = p.intent;
  lib[k] ??= { count: 0, resolutions: {}, phrases: {} };
  lib[k].count++;
  lib[k].resolutions[p.resolution] = (lib[k].resolutions[p.resolution] || 0) + 1;
  const ph = norm(p.atext);
  if (ph.length > 2) lib[k].phrases[ph] = (lib[k].phrases[ph] || 0) + 1;
}
const library = {};
for (const [intent, v] of Object.entries(lib)) {
  library[intent] = {
    pairs: v.count,
    resolutions: Object.fromEntries(Object.entries(v.resolutions).sort((a, b) => b[1] - a[1])),
    topReplies: Object.entries(v.phrases).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p, n]) => ({ n, template: p })),
  };
}
fs.writeFileSync(path.join(OUT, "reply-library.json"), JSON.stringify(library, null, 2));

// ── console summary ────────────────────────────────────────────────────────
const byHow = pairs.reduce((a, p) => ((a[p.how] = (a[p.how] || 0) + 1), a), {});
const byRes = pairs.reduce((a, p) => ((a[p.resolution] = (a[p.resolution] || 0) + 1), a), {});
console.log(`messages: ${msgs.length}  ·  Q→A pairs reconstructed: ${pairs.length}`);
console.log(`matched by: ${JSON.stringify(byHow)}`);
console.log(`\nhow messages get resolved (team's actual action):`);
for (const [k, v] of Object.entries(byRes).sort((a, b) => b[1] - a[1]))
  console.log(`  ${k.padEnd(22)} ${String(v).padStart(6)}  ${(100 * v / pairs.length).toFixed(1)}%`);
const med = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
console.log(`\nmedian reply latency: ${med(pairs.map((p) => p.latencyMin))} min`);
console.log(`\nby question intent → top resolution:`);
for (const [intent, v] of Object.entries(library).sort((a, b) => b[1].pairs - a[1].pairs).slice(0, 10)) {
  const top = Object.entries(v.resolutions)[0];
  console.log(`  ${intent.padEnd(16)} ${String(v.pairs).padStart(5)} pairs → ${top ? top[0] + " (" + (100 * top[1] / v.pairs).toFixed(0) + "%)" : "?"}`);
}
console.log(`\nwrote out/handling.csv (${pairs.length} pairs) + out/reply-library.json`);
