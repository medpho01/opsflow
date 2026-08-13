/**
 * Shared WhatsApp partner-ops classifier.
 *
 * Single source of truth used by BOTH the offline analysis script
 * (scripts/whatsapp-analysis) and the live bot (whatsapp-bot/index.mjs).
 * Rule-based fast path — transparent and auditable. The live bot layers an
 * LLM fallback on top for the REVIEW bucket (bare-ID drops, freeform
 * coordination) that rules can't resolve without conversation context.
 *
 * See the measured breakdown in the analysis report: ~26% of substantive
 * traffic is auto-answerable status the bot can serve from the LabStack
 * replica; the automatable ceiling rises to ~55-65% once the LLM+context
 * layer collapses ID_ONLY + much of OTHER into the same buckets.
 */

// ── LabStack-side sender detection ───────────────────────────────────────
const LABSTACK_NAMES = [/labstack/i, /qikwell/i, /abhishek rajpoot/i, /varun kansal/i, /datta/i];
export const isLabstack = (sender = "") => LABSTACK_NAMES.some((r) => r.test(sender));

// ── Order / request id extraction ────────────────────────────────────────
// Two id systems: Order/Booking (bare 5-6 digits, or "#", "Lab Order #",
// "Booking ID -") and Request ("Request #NNNNN"). Returns both the ids and
// whether any were request-prefixed (which table to look up first).
export function extractIds(text = "") {
  const ids = new Set();
  const requestIds = new Set();
  let r;
  const reqRe = /request\s*#?\s*(\d{4,6})/gi;
  while ((r = reqRe.exec(text))) { ids.add(r[1]); requestIds.add(r[1]); }
  const numRe = /(?<![\d/])(\d{5,6})(?![\d/])/g;
  while ((r = numRe.exec(text))) ids.add(r[1]);
  return { ids: [...ids], requestIds: [...requestIds], hasId: ids.size > 0 };
}

// Lab reference ids: city-prefixed booking numbers the store/lab quote in chat,
// e.g. "BLR5560683", "HYD6013288", "DEL2221267". These map to Order.labOrderId,
// not to our numeric order id — resolve them to an order via the replica.
const REF_RE = /\b([A-Za-z]{2,4}\d{6,})\b/g;
export function extractRefIds(text = "") {
  const refs = new Set();
  let r;
  while ((r = REF_RE.exec(text))) refs.add(r[1].toUpperCase());
  return [...refs];
}

// ── Intent classification ────────────────────────────────────────────────
const SYSTEM_RE = /was added|was removed|left$|changed to|created group|end-to-end|pinned a message|changed the group|changed this group|Waiting for this message|This message was deleted|You deleted|image omitted|<Media omitted>|video omitted|audio omitted|document omitted|sticker omitted|GIF omitted|Contact card omitted|deleted this message|added |removed |joined using|security code/i;
const ACK_RE = /^(ok(ay)?|k|done|thanks?( you)?|thankyou|welcome|sure|yes+|no+|noted|got it|on it|checking|check|great|fine|alright|👍+|🙏+|✅+|cc|@\S+)[\s.!👍🙏✅]*$/i;
const DATE_TIME_RE = /\b(\d{1,2}\s*(st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|tomorrow|today|\d{1,2}\s*[:.]?\d{0,2}\s*(am|pm)|\d{1,2}(am|pm))\b/i;

export function classify(text = "", sender = "") {
  const t = text.toLowerCase();
  const fromLab = isLabstack(sender);

  if (SYSTEM_RE.test(text)) return "SYSTEM";
  if (ACK_RE.test(text.trim())) return "NOISE";

  if (/escalat|frustrat|angry|is upset|very bad|worst|unacceptable|not acceptable|disappoint|complain|raising (many|multiple)|too many tickets|why (is|so) (much )?delay|repeatedly|again and again/.test(t)) return "ESCALATION";
  if (fromLab && /(-|:)\s*(completed|complete|delivered|cancelled|canceled|booking created|rescheduled|rnr|resolved|done)\b|booking created|booking id|rescheduled with|user (not respond|didn.?t respond|not reachable|missed the call)|phlebo (no show|not|refused)|no show/.test(t)) return "OUTBOUND_UPDATE";
  if (/reason.*(cancel|no show|no-show)|why.*(cancel|no show|rejected|not done)/.test(t)) return "CANCEL_REASON";
  if (/upload.*report|report.*(upload|pending|ready|share|awaited)|share.*report|tat.*(breach|over|exceed)|reports? not|complete reports?/.test(t)) return "REPORT_REQUEST";
  if (/reschedul/.test(t)) return "RESCHEDULE";
  if (/(please|pls|kindly).*(cancel)|cancel this (order|request|booking)|want to cancel|need to cancel/.test(t)) return "CANCEL_REQUEST";
  if (/serviceab|non.?servic|not servic|no labs? found|unable to (confirm|proceed|check)|centre visit possible|center visit possible|(is|are) (this|these|it) (order|orders )?serviceable/.test(t)) return "SERVICEABILITY";
  if (/\bpossible\b\s*[\n₹]?\s*\d{3,5}\s*\/?-?|pricing.*(update|shortly)|price will update|\b\d{2,3}\s*hrs\b/.test(t)) return "FEASIBILITY_QUOTE";
  if (/\bslot/.test(t)) return "SLOT_CHECK";
  if (/not able to (add|book|create|open|see)|unable to (add|book|open|see|find)|(console|portal|app).*(buffering|not working|error|issue|down|stuck|slow)|buffering|showing error|not reflecting|not showing/.test(t)) return "TECH_ISSUE";
  if (/status|is (this|it|the|these) (order|request|booking)?\s*(collected|scheduled|re-?scheduled|confirmed|done|created|processed|updated)|collection status|(any|pls|please|kindly)\s*(update|upadte|confirm)|update\??\s*$|any upadte|what.*happen|update.*(status|me)|not confirmed|awaiting confirmation|price quoted|\bcollected\b|\bconfirmed\??\b|check (and|&|nd)\s*confirm|(pls|please|kindly|can you)\s*check\b/.test(t)) return "STATUS_CHECK";
  if (/please (proceed|process|create|book|arrange|add)|(kindly|pls) (proceed|process|create|book|arrange|add)|create (a )?(request|order|booking)|add (this )?(request|order)?\s*(in|to)?\s*console|orders? created|request created|booking created|(are|is|these are) created|proceed with|do ?n['o]?t (process|add)|don.?t (process|add)/.test(t)) return "CREATE_ACTION";
  if (!fromLab && DATE_TIME_RE.test(t)) return "NEW_BOOKING";
  if (/share.*(dob|date of birth|address|name|number|phone|details|age|gender)|^\s*\d{4}-\d{2}-\d{2}\s*$|\bdob\b|pincode|\bpin\b\s*[-:]?\s*\d|contact\s*\d/.test(t)) return "PATIENT_DATA";

  const stripped = text.replace(/[‎@⁨⁩~+\d#\s\/():.\-]|request|order|booking|id|lab/gi, "");
  if (extractIds(text).hasId && stripped.length <= 3) return "ID_ONLY";

  return "OTHER";
}

export const DISPOSITION = {
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

// ── Export-file parser (used by the offline analysis script) ─────────────
const LINE_RE = /^‎?\[(\d{2}\/\d{2}\/\d{2}),\s*(\d{1,2}:\d{2}:\d{2}\s*[AP]M)\]\s*([^:]+?):\s?([\s\S]*)$/;
export function parseExport(raw) {
  const lines = raw.replace(/\r/g, "").split("\n");
  const msgs = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(LINE_RE);
    if (m) { if (cur) msgs.push(cur); cur = { date: m[1], time: m[2], sender: m[3].trim(), text: m[4] }; }
    else if (cur) cur.text += "\n" + line;
  }
  if (cur) msgs.push(cur);
  return msgs;
}
