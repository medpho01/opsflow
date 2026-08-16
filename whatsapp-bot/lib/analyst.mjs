/**
 * Case analyst — the LLM brain behind the CRM.
 *
 * For each active order/request it reads the FULL cross-group message thread
 * plus the live LabStack DB state and asks Claude for an accurate brief:
 * current status, who's waiting on whom, whether it's resolved (even if handled
 * outside the console), a clean timeline, and in-context suggested replies.
 *
 * Runs continuously from the gateway, but is change-detected: a case is only
 * re-analyzed when its messages or DB state actually changed (inputHash), so
 * continuous mode does not mean continuous spend.
 *
 * Actor model the prompt is grounded in:
 *   Ops      — LabStack's internal team, coordinating/managing orders
 *   Customer — partner brands (Plum, Sugarfit, Alyve…) raising queries
 *   Lab      — providers (Orange, Thyrocare, Good Health…) fulfilling + logistics
 */
import crypto from "crypto";
import { taskosQuery } from "./taskosdb.mjs";
import { lookupIds } from "./lookup.mjs";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// ── team roster (to tag Ops actors) ─────────────────────────────────────────
let teamCache = { at: 0, list: [] };
async function loadTeam() {
  if (Date.now() - teamCache.at < 60000) return teamCache.list;
  try {
    const rows = (await taskosQuery(`SELECT name, phone, aliases FROM wa_contacts WHERE active = true`)).rows;
    teamCache = { at: Date.now(), list: rows };
  } catch { /* table may be empty */ }
  return teamCache.list;
}
const last10 = (s) => (s || "").replace(/\D/g, "").slice(-10);
function makeTeamMatcher(team) {
  const byPhone = new Map(), byName = new Map();
  for (const t of team) {
    if (t.phone) byPhone.set(last10(t.phone), t.name);
    if (t.name) byName.set(t.name.toLowerCase().trim(), t.name);
    for (const a of t.aliases || []) byName.set(String(a).toLowerCase().trim(), t.name);
  }
  return (sender, senderJid) => {
    const d = last10((senderJid || "").split("@")[0]);
    if (d && byPhone.has(d)) return byPhone.get(d);
    const n = (sender || "").toLowerCase().trim();
    if (n && byName.has(n)) return byName.get(n);
    return null;
  };
}
function actorRole(m, matchTeam) {
  if (m.fromMe || matchTeam(m.sender, m.senderJid)) return "Ops";
  if (m.grole === "SUPPORT") return "Customer";
  if (m.grole === "PROVIDER") return "Lab";
  return "Unknown";
}

// ── gather one order's cross-group thread ───────────────────────────────────
async function gatherCase({ orderId, requestId }) {
  const col = orderId
    ? `m."orderIds" @> ARRAY[${Number(orderId)}]::int[]`
    : `m."requestIds" @> ARRAY[${Number(requestId)}]::int[]`;
  return (await taskosQuery(
    `SELECT m."waMsgId", m."fromMe", m.sender, m."senderJid", m.text, m."ocrText", m.ts, m.intent,
            g.subject AS gsubject, g.role AS grole
       FROM wa_messages m JOIN wa_groups g ON g.id = m."groupId"
      WHERE ${col} ORDER BY m.ts ASC LIMIT 200`
  )).rows;
}

// ── the Claude call ─────────────────────────────────────────────────────────
const SYSTEM = [
  "You are the case analyst for LabStack, a diagnostic-lab aggregator.",
  "Three actor roles appear in the chat:",
  "- Ops: LabStack's own internal team, coordinating and managing orders.",
  "- Customer: a partner brand (e.g. Plum, Sugarfit, Alyve Health) raising a query about an order.",
  "- Lab: the fulfilment provider (e.g. Orange, Thyrocare, Good Health) giving collection/report logistics.",
  "You are given ONE order's WhatsApp messages (may span multiple groups, each already tagged with the actor) and its live database state.",
  "Judge the TRUE current state, who must act next, and whether it is resolved — a case is resolved when the customer's query has been answered or the order reached a terminal state, even if closed in chat rather than in the console.",
  "Write suggested replies in the voice of Ops: concise, specific, ready to send. Leave a suggestion empty if none is warranted.",
  "Keep the timeline to AT MOST 8 entries (the key beats — merge or drop minor ones) and keep every string short (one line).",
  "Reply with a SINGLE JSON object and nothing else — no prose, no code fences, no trailing commentary.",
].join("\n");

const SCHEMA_HINT = '{"queryType":"the CUSTOMER\'s actual request — one of STATUS_CHECK|RESCHEDULE|CANCEL_REQUEST|CANCEL_REASON|REPORT_REQUEST|NEW_BOOKING|SLOT_CHECK|SERVICEABILITY|FEASIBILITY_QUOTE|ESCALATION|PATIENT_DATA|TECH_ISSUE|CREATE_ACTION|OTHER (use OTHER only when truly none fit)","status":"one line, the order\'s true current state","resolved":true|false,"resolvedReason":"short why","waiting":"who must do what next","timeline":[{"ts":"iso","actor":"display name","role":"Ops|Customer|Lab","event":"what happened"}],"suggestions":{"store":"ready reply to the customer or empty","lab":"ready message to the lab or empty"}}';

async function callAnalyst({ apiKey, model, orderId, requestId, dbRow, messages }) {
  const user =
    `ORDER: ${orderId || "-"}  REQUEST: ${requestId || "-"}\n` +
    `LIVE DB STATE: ${JSON.stringify(dbRow || {})}\n` +
    `MESSAGES (chronological, actor-tagged):\n${JSON.stringify(messages)}\n\n` +
    `Return JSON exactly shaped like: ${SCHEMA_HINT}`;
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 2500, system: SYSTEM, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) {
    // API-level failure → signal the loop to back off (don't hammer/spam).
    const body = (await res.text().catch(() => "")).slice(0, 200);
    const e = new Error(`api ${res.status}`);
    if (res.status === 429 || res.status === 529) e.backoffMs = 60_000;                       // rate / overloaded
    else if (res.status === 401 || res.status === 403) e.backoffMs = 600_000;                  // bad key
    else if (res.status === 400 && /credit|billing|balance/i.test(body)) e.backoffMs = 600_000; // out of credit
    console.error("[analyst] api", res.status, body);
    throw e;
  }
  const data = await res.json();
  if (data?.stop_reason === "max_tokens") console.warn("[analyst] hit max_tokens for", orderId || requestId);
  try {
    let txt = (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    txt = txt.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const a = txt.indexOf("{"), z = txt.lastIndexOf("}");
    if (a >= 0 && z > a) txt = txt.slice(a, z + 1);
    return JSON.parse(txt);
  } catch (e) { console.error("[analyst] parse:", e.message); return null; } // per-case skip, no backoff
}

const QUERY_TYPES = new Set(["STATUS_CHECK", "RESCHEDULE", "CANCEL_REQUEST", "CANCEL_REASON", "REPORT_REQUEST", "NEW_BOOKING", "SLOT_CHECK", "SERVICEABILITY", "FEASIBILITY_QUOTE", "ESCALATION", "PATIENT_DATA", "TECH_ISSUE", "CREATE_ACTION", "OTHER"]);

async function upsertBrief(c, b, inputHash, model) {
  const col = c.orderId ? "orderId" : "requestId";
  const val = c.orderId || c.requestId;
  const queryType = QUERY_TYPES.has(String(b.queryType || "").toUpperCase()) ? String(b.queryType).toUpperCase() : null;
  const exists = (await taskosQuery(`SELECT id FROM wa_case_briefs WHERE "${col}" = $1`, [val])).rows[0];
  const vals = [b.status || null, !!b.resolved, b.resolvedReason || null, b.waiting || null,
    JSON.stringify(b.timeline || []), JSON.stringify(b.suggestions || {}), JSON.stringify(b.actors || {}), model || null, inputHash, queryType];
  if (exists) {
    await taskosQuery(
      `UPDATE wa_case_briefs SET status=$2, resolved=$3, "resolvedReason"=$4, waiting=$5, timeline=$6,
              suggestions=$7, actors=$8, model=$9, "inputHash"=$10, "queryType"=$11, "analyzedAt"=now(), "updatedAt"=now() WHERE id=$1`,
      [exists.id, ...vals]
    );
  } else {
    await taskosQuery(
      `INSERT INTO wa_case_briefs (id, "${col}", status, resolved, "resolvedReason", waiting, timeline, suggestions, actors, model, "inputHash", "queryType", "analyzedAt", "updatedAt", "createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now(), now())`,
      [val, ...vals]
    );
  }
  // Write the LLM's classification back onto the open case(s) for this order,
  // so the console + analytics show a real query type instead of "other".
  if (queryType) {
    const tcol = c.orderId ? "orderId" : "requestId";
    await taskosQuery(`UPDATE wa_tickets SET intent = $2 WHERE "${tcol}" = $1 AND status <> 'RESOLVED'`, [val, queryType]).catch(() => {});
  }
}

/**
 * Analyze up to `limit` active cases whose inputs changed since last run.
 * Called on an interval by the gateway.
 */
let cooldownUntil = 0; // set when the API says rate/credit/auth — pause the loop

export async function analyzeActiveCases({ limit = 8, model, apiKey } = {}) {
  if (!apiKey) return { skipped: "no-api-key" };
  if (Date.now() < cooldownUntil) return { skipped: "cooldown", untilMs: cooldownUntil - Date.now() };
  const matchTeam = makeTeamMatcher(await loadTeam());
  const cases = (await taskosQuery(
    `SELECT DISTINCT t."orderId", t."requestId"
       FROM wa_tickets t
      WHERE t.status <> 'RESOLVED' AND (t."orderId" IS NOT NULL OR t."requestId" IS NOT NULL)
      LIMIT 300`
  )).rows;

  let analyzed = 0;
  for (const c of cases) {
    if (analyzed >= limit) break;
    const msgs = await gatherCase(c);
    if (!msgs.length) continue;

    const idKey = c.orderId || c.requestId;
    const look = await lookupIds([idKey]).catch(() => ({ orders: [], requests: [] }));
    const dbRow = c.orderId ? (look.orders || [])[0] : (look.requests || [])[0];

    const hashSrc = msgs.map((m) => m.waMsgId + (m.ocrText ? "*" : "")).join(",") + "|" + String(msgs[msgs.length - 1]?.ts || "") + "|" + JSON.stringify(dbRow || {});
    const inputHash = crypto.createHash("sha1").update(hashSrc).digest("hex");
    const col = c.orderId ? "orderId" : "requestId";
    const existing = (await taskosQuery(`SELECT "inputHash" FROM wa_case_briefs WHERE "${col}" = $1`, [idKey])).rows[0];
    if (existing && existing.inputHash === inputHash) continue; // nothing changed → no spend

    const tagged = msgs.map((m) => ({
      ts: m.ts, actor: m.fromMe ? "You" : (m.sender || "?"), role: actorRole(m, matchTeam), group: m.gsubject,
      text: (m.text || "").slice(0, 500),
      ...(m.ocrText ? { image: m.ocrText.slice(0, 500) } : {}),
    }));
    let brief;
    try {
      brief = await callAnalyst({ apiKey, model, orderId: c.orderId, requestId: c.requestId, dbRow, messages: tagged });
    } catch (e) {
      if (e.backoffMs) { cooldownUntil = Date.now() + e.backoffMs; console.warn(`[analyst] backing off ${Math.round(e.backoffMs / 1000)}s (${e.message})`); break; }
      console.error("[analyst] case:", e.message); continue; // transient (e.g. network) → skip case
    }
    if (!brief) continue; // parse skip
    await upsertBrief(c, brief, inputHash, model);
    analyzed++;
  }
  return { candidates: cases.length, analyzed };
}
