#!/usr/bin/env node
/**
 * WhatsApp partner-ops chat classifier — offline analysis.
 *
 * Parses WhatsApp "Export Chat (Without Media)" .txt files, extracts the
 * order/request IDs, classifies each substantive message into an ops
 * intent, and maps intents to bot dispositions:
 *
 *   AUTO_ANSWER      read-only status the bot answers from the LabStack
 *                    replica (status / report / cancel-reason / appt)
 *   ROUTE_CONSOLE    an action → create an OpsFlow task, team works console
 *   NEEDS_LAB        needs lab availability / serviceability (post to lab
 *                    group or call a lab API)
 *   HUMAN            escalation / complaint — route to a person, fast
 *   OUTBOUND         a LabStack-side status post (could be auto-generated)
 *   NOISE            acks / chatter / system
 *
 * This is a MEASUREMENT pass. The rules are deliberately transparent (not
 * an LLM) so the numbers are auditable; the live bot can keep these rules
 * as a fast path and add an LLM fallback for the REVIEW bucket.
 *
 * Run:  node scripts/whatsapp-analysis/classify.mjs "<dir with _chat.txt files>"
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.argv[2] || "/tmp/wa_analysis";

// ── LabStack-side sender detection ───────────────────────────────────────
// Direction matters: a partner ASKING "status?" is inbound (automatable);
// LabStack POSTING "Completed" is outbound. Best-effort — names carry
// "labstack", plus a small known-staff set seen across the four groups.
const LABSTACK_NAMES = [
  /labstack/i, /qikwell/i,
  /abhishek rajpoot/i, /varun kansal/i, /datta/i,
];
const isLabstack = (sender) => LABSTACK_NAMES.some((r) => r.test(sender));

// ── Parse one export file into structured messages ───────────────────────
const LINE_RE = /^‎?\[(\d{2}\/\d{2}\/\d{2}),\s*(\d{1,2}:\d{2}:\d{2}\s*[AP]M)\]\s*([^:]+?):\s?([\s\S]*)$/;

function parse(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/\r/g, "");
  const lines = raw.split("\n");
  const msgs = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(LINE_RE);
    if (m) {
      if (cur) msgs.push(cur);
      cur = { date: m[1], time: m[2], sender: m[3].trim(), text: m[4] };
    } else if (cur) {
      cur.text += "\n" + line; // continuation of a multi-line message
    }
  }
  if (cur) msgs.push(cur);
  return msgs;
}

// ── Noise / system detection ─────────────────────────────────────────────
const SYSTEM_RE = /was added|was removed|left$|changed to|created group|end-to-end|pinned a message|changed the group|changed this group|Waiting for this message|This message was deleted|You deleted|image omitted|<Media omitted>|video omitted|audio omitted|document omitted|sticker omitted|GIF omitted|Contact card omitted|deleted this message|added |removed |joined using|security code/i;

const ACK_RE = /^(ok(ay)?|k|done|thanks?( you)?|thankyou|welcome|sure|yes+|no+|noted|got it|on it|checking|check|great|fine|alright|👍+|🙏+|✅+|cc|@\S+)[\s.!👍🙏✅]*$/i;

// ── ID extraction ────────────────────────────────────────────────────────
// Two ID systems seen: Order/Booking IDs (bare 5–6 digits, sometimes
// "#" / "Lab Order #" / "Booking ID -") and Request IDs ("Request #NNNNN").
function extractIds(text) {
  const ids = new Set();
  let hasRequest = false;
  const reqRe = /request\s*#?\s*(\d{4,6})/gi;
  let r;
  while ((r = reqRe.exec(text))) { ids.add(r[1]); hasRequest = true; }
  // Bare / prefixed order ids — any standalone 5–6 digit run.
  const numRe = /(?<![\d/])(\d{5,6})(?![\d/])/g;
  while ((r = numRe.exec(text))) ids.add(r[1]);
  return { ids: [...ids], hasId: ids.size > 0, hasRequest };
}

// ── Intent classification (ordered: specific → general) ──────────────────
const DATE_TIME_RE = /\b(\d{1,2}\s*(st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|tomorrow|today|\d{1,2}\s*[:.]?\d{0,2}\s*(am|pm)|\d{1,2}(am|pm))\b/i;

function classify(text, sender) {
  const t = text.toLowerCase();
  const fromLab = isLabstack(sender);

  if (SYSTEM_RE.test(text)) return "SYSTEM";
  if (ACK_RE.test(text.trim())) return "NOISE";

  // Escalation overrides everything — must reach a human fast.
  if (/escalat|frustrat|angry|is upset|very bad|worst|unacceptable|not acceptable|disappoint|complain|raising (many|multiple)|too many tickets|why (is|so) (much )?delay|repeatedly|again and again/.test(t))
    return "ESCALATION";

  // Outbound LabStack status posts.
  if (fromLab && /(-|:)\s*(completed|complete|delivered|cancelled|canceled|booking created|rescheduled|rnr|resolved|done)\b|booking created|booking id|rescheduled with|user (not respond|didn.?t respond|not reachable|missed the call)|phlebo (no show|not|refused)|no show/.test(t))
    return "OUTBOUND_UPDATE";

  if (/reason.*(cancel|no show|no-show)|why.*(cancel|no show|rejected|not done)/.test(t)) return "CANCEL_REASON";
  if (/upload.*report|report.*(upload|pending|ready|share|awaited)|share.*report|tat.*(breach|over|exceed)|reports? not|complete reports?/.test(t)) return "REPORT_REQUEST";
  if (/reschedul/.test(t)) return "RESCHEDULE";
  if (/(please|pls|kindly).*(cancel)|cancel this (order|request|booking)|want to cancel|need to cancel/.test(t)) return "CANCEL_REQUEST";

  // Lab availability domain (serviceability / slots / price+feasibility
  // quotes). The one thing the bot can't answer from our current DB — it
  // needs a lab serviceability/pricing integration or the lab group.
  if (/serviceab|non.?servic|not servic|no labs? found|unable to (confirm|proceed|check)|centre visit possible|center visit possible|(is|are) (this|these|it) (order|orders )?serviceable/.test(t)) return "SERVICEABILITY";
  if (/\bpossible\b\s*[\n₹]?\s*\d{3,5}\s*\/?-?|pricing.*(update|shortly)|price will update|\b\d{2,3}\s*hrs\b/.test(t)) return "FEASIBILITY_QUOTE";
  if (/\bslot/.test(t)) return "SLOT_CHECK";

  // Product/console bug reports — a person (or product) must handle.
  if (/not able to (add|book|create|open|see)|unable to (add|book|open|see|find)|(console|portal|app).*(buffering|not working|error|issue|down|stuck|slow)|buffering|showing error|not reflecting|not showing/.test(t)) return "TECH_ISSUE";

  // Status / progress checks — widened for the real phrasings seen,
  // including the ops-idiom "pls check (and confirm)".
  if (/status|is (this|it|the|these) (order|request|booking)?\s*(collected|scheduled|re-?scheduled|confirmed|done|created|processed|updated)|collection status|(any|pls|please|kindly)\s*(update|upadte|confirm)|update\??\s*$|any upadte|what.*happen|update.*(status|me)|not confirmed|awaiting confirmation|price quoted|\bcollected\b|\bconfirmed\??\b|check (and|&|nd)\s*confirm|(pls|please|kindly|can you)\s*check\b/.test(t)) return "STATUS_CHECK";

  // Creation / proceed actions → a console task.
  if (/please (proceed|process|create|book|arrange|add)|(kindly|pls) (proceed|process|create|book|arrange|add)|create (a )?(request|order|booking)|add (this )?(request|order)?\s*(in|to)?\s*console|orders? created|request created|booking created|(are|is|these are) created|proceed with|do ?n['o]?t (process|add)|don.?t (process|add)/.test(t)) return "CREATE_ACTION";

  // New booking: from partner, has a date/time (+ usually an id).
  if (!fromLab && DATE_TIME_RE.test(t)) return "NEW_BOOKING";

  // Patient data being requested/supplied to complete a booking.
  if (/share.*(dob|date of birth|address|name|number|phone|details|age|gender)|^\s*\d{4}-\d{2}-\d{2}\s*$|\bdob\b|pincode|\bpin\b\s*[-:]?\s*\d|contact\s*\d/.test(t)) return "PATIENT_DATA";

  // Bare ID drop (+ mention/whitespace only): partner drops an order/
  // request id tagging LabStack = an implicit "look at this". Genuinely
  // ambiguous between status vs action WITHOUT the surrounding thread —
  // the canonical case for the live bot's LLM-with-context layer.
  const stripped = text.replace(/[‎@⁨⁩~+\d#\s\/():.\-]|request|order|booking|id|lab/gi, "");
  if (extractIds(text).hasId && stripped.length <= 3) return "ID_ONLY";

  return "OTHER"; // freeform coordination — needs a human / LLM in context
}

const DISPOSITION = {
  STATUS_CHECK: "AUTO_ANSWER",
  REPORT_REQUEST: "AUTO_ANSWER",
  CANCEL_REASON: "AUTO_ANSWER",
  RESCHEDULE: "ROUTE_CONSOLE",
  CANCEL_REQUEST: "ROUTE_CONSOLE",
  NEW_BOOKING: "ROUTE_CONSOLE",
  CREATE_ACTION: "ROUTE_CONSOLE",
  PATIENT_DATA: "ROUTE_CONSOLE",
  SERVICEABILITY: "NEEDS_LAB",
  SLOT_CHECK: "NEEDS_LAB",
  FEASIBILITY_QUOTE: "NEEDS_LAB",
  ESCALATION: "HUMAN",
  TECH_ISSUE: "HUMAN",
  OUTBOUND_UPDATE: "OUTBOUND",
  ID_ONLY: "REVIEW",
  NOISE: "NOISE",
  SYSTEM: "NOISE",
  OTHER: "REVIEW",
};

// ── Optional: dump N examples of one intent for rule-tuning ──────────────
const DUMP = process.env.DUMP; // e.g. DUMP=OTHER
const DUMP_N = parseInt(process.env.DUMP_N || "50", 10);
const dumped = [];

// ── Run over every group ─────────────────────────────────────────────────
const dirs = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const overall = { intents: {}, disp: {}, total: 0, withId: 0, substantive: 0 };
const perGroup = [];

for (const dir of dirs) {
  const file = path.join(ROOT, dir, "_chat.txt");
  if (!fs.existsSync(file)) continue;
  const msgs = parse(file);
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
    if (DUMP && intent === DUMP && dumped.length < DUMP_N) {
      dumped.push(`[${isLabstack(m.sender) ? "LAB" : "PTR"}] ${m.text.replace(/\n/g, " ⏎ ").slice(0, 160)}`);
    }
  }
  overall.total += g.total;
  perGroup.push(g);
}

// ── Report ───────────────────────────────────────────────────────────────
const pct = (n, d) => d ? `${((n / d) * 100).toFixed(1)}%` : "0%";
const sortEntries = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);

console.log("═".repeat(70));
console.log("WHATSAPP PARTNER-OPS TRAFFIC — MEASURED CLASSIFICATION");
console.log("═".repeat(70));
console.log(`Groups: ${perGroup.length} · Total messages: ${overall.total}`);
console.log(`Substantive (non-noise/system): ${overall.substantive} (${pct(overall.substantive, overall.total)})`);
console.log(`Carry an order/request id: ${overall.withId} (${pct(overall.withId, overall.total)})`);

console.log("\n── INTENT MIX (all messages) ──");
for (const [k, v] of sortEntries(overall.intents))
  console.log(`  ${k.padEnd(16)} ${String(v).padStart(6)}  ${pct(v, overall.total)}`);

console.log("\n── DISPOSITION (what the bot does) ──");
for (const [k, v] of sortEntries(overall.disp))
  console.log(`  ${k.padEnd(14)} ${String(v).padStart(6)}  ${pct(v, overall.total)}`);

// The headline: of substantive messages, the automatable split.
const sub = overall.substantive;
const auto = overall.disp.AUTO_ANSWER || 0;
const route = overall.disp.ROUTE_CONSOLE || 0;
const lab = overall.disp.NEEDS_LAB || 0;
const human = overall.disp.HUMAN || 0;
const outbound = overall.disp.OUTBOUND || 0;
const review = overall.disp.REVIEW || 0;
console.log("\n── HEADLINE (share of SUBSTANTIVE inbound+outbound work) ──");
console.log(`  Bot auto-answers (read status):      ${pct(auto, sub)}  (${auto})`);
console.log(`  Bot → console task (action):         ${pct(route, sub)}  (${route})`);
console.log(`  Needs lab (slots/serviceability):    ${pct(lab, sub)}  (${lab})`);
console.log(`  LabStack outbound (auto-postable):   ${pct(outbound, sub)}  (${outbound})`);
console.log(`  Human (escalation):                  ${pct(human, sub)}  (${human})`);
console.log(`  Unclassified (needs review/LLM):     ${pct(review, sub)}  (${review})`);

console.log("\n── PER-GROUP ──");
for (const g of perGroup) {
  console.log(`\n  ${g.name}  (${g.days.size} active days, ${g.total} msgs)`);
  const top = sortEntries(g.disp).filter(([k]) => k !== "NOISE").slice(0, 6);
  for (const [k, v] of top) console.log(`     ${k.padEnd(14)} ${String(v).padStart(5)}  ${pct(v, g.total)}`);
}
if (DUMP) {
  console.log(`\n── ${dumped.length} EXAMPLES of intent=${DUMP} ──`);
  for (const d of dumped) console.log("  " + d);
}
console.log("\n" + "═".repeat(70));
