/**
 * Message style (27 Oct 2026): the wording of every message the system sends is
 * not fixed. Each kind of message has a CONTRACT — what it must carry (the order
 * id, the name, the phone, the date), what it may carry, how long it may be —
 * and a body. The body is the live template (editable on the Templates page)
 * or, for part of the labs and stores, a TRIAL variant the Brain wrote. Every
 * send is logged against its variant; the Brain's style pass (brain/style.ts)
 * compares engagement, promotes or retires the trial, and writes the next one.
 *
 *   styledBody(key, counterparty)  → the body to render, and which variant it is
 *   renderLoose(body, vars)        → render where optional parts may be empty
 *   recordSend(...)                → the send log the engagement is scored from
 *   checkVariant(key, body)        → the contract check every variant must pass
 */
import { Prisma } from "@prisma/client";
import prisma from "@/lib/db/client";
import { ensureTemplate, isNonApiTemplateKey, allowedVariablesFor, requiredVariablesFor } from "@/lib/non-api-labs/templates";

export type Audience = "lab" | "manager" | "store";
export type StyleContract = {
  /** What the message is for, in one line — the Brain's brief. */
  purpose: string;
  audience: Audience;
  required: readonly string[];
  allowed: readonly string[];
  maxChars: number;
  /** Variables that may render empty (a line with only empty variables disappears). */
  optional?: readonly string[];
};

const LINE_ITEM_VARS = ["n", "ref", "order_id", "name", "mobile", "area", "when", "extra", "note", "link", "map_url", "tests"] as const;
const ENTRY_VARS = ["n", "time", "date_time", "name", "order_id", "mobile", "address", "map_url", "centre", "packages", "tests", "since", "confirm_line"] as const;
const STORE_VARS = ["order_id", "patient_name", "lab_name", "time", "detail", "slot", "reason", "expected", "alternative", "change", "status_line", "next_line"] as const;

/** Defaults for the keys this module owns (the per-order lines inside combined messages and lists). */
export const STYLE_DEFAULTS: Record<string, { name: string; body: string }> = {
  // One order inside a combined ask. Labs find an order by their own reference or the patient's phone.
  BATCH_ITEM: { name: "Line: one order in a combined ask", body: "{{n}}. {{ref}}#{{order_id}} · {{name}} · {{mobile}} · {{area}} · {{when}} · {{extra}} · {{note}}{{link}}" },
  BATCH_ITEM_NEW_ORDER: { name: "Line: one new order", body: "{{n}}. {{ref}}#{{order_id}} · {{name}} · {{when}}\n    📞 {{mobile}}\n    📍 {{area}}\n    🗺️ {{map_url}}\n    🧪 {{tests}}\n    {{note}}\n    {{link}}" },
  // One order in the evening list: who, phone, where (for the route), what, and the confirm link while unconfirmed.
  SUMMARY_ENTRY_TOMORROW: { name: "Entry: tomorrow's list", body: "*{{n}}. {{time}}* – {{name}} · #{{order_id}} · 📞 {{mobile}}\n   📍 {{address}}\n   🗺️ {{map_url}}\n   🏥 {{centre}}\n   🧪 {{packages}}\n   {{confirm_line}}" },
  // One order in a list of past visits (reports, open orders): the id, the name, the phone, the visit date. Nothing the lab needed only on the day.
  SUMMARY_ENTRY_PAST: { name: "Entry: past visits list", body: "*{{n}}.* #{{order_id}} · {{name}} · 📞 {{mobile}} · visit {{date_time}} ({{since}})\n   {{confirm_line}}" },
};

const lab = (purpose: string, required: readonly string[], allowed: readonly string[], maxChars = 600, optional: readonly string[] = []): StyleContract => ({ purpose, audience: "lab", required, allowed, maxChars, optional });
const store = (purpose: string, required: readonly string[], maxChars = 320): StyleContract => ({ purpose, audience: "store", required, allowed: STORE_VARS, maxChars, optional: ["next_line"] });

/** The contract of every message kind the Brain may restyle. Keys not listed are never restyled. */
export const STYLE_CONTRACTS: Record<string, StyleContract> = {
  BATCH_ITEM: lab("One line per order inside a combined ask to a lab's coordinator (status, phlebo, ETA, report, overdue). Must let the lab find the order and know what is asked.", ["n", "order_id", "name", "when"], LINE_ITEM_VARS, 220, ["ref", "mobile", "area", "extra", "note", "link"]),
  BATCH_ITEM_NEW_ORDER: lab("One new order inside a combined new-orders message: everything the lab needs to take it — name, visit, phone, address, map, tests, confirm link.", ["n", "order_id", "name", "when", "mobile", "link"], LINE_ITEM_VARS, 500, ["ref", "area", "extra", "note", "map_url", "tests"]),
  SUMMARY_ENTRY_TOMORROW: lab("One order in the evening list of tomorrow's visits: who, phone, where (address + map for the route), what (package names), and the confirm link while unconfirmed.", ["n", "time", "name", "order_id", "mobile"], ENTRY_VARS, 500, ["address", "map_url", "centre", "packages", "tests", "confirm_line"]),
  SUMMARY_ENTRY_PAST: lab("One order in a list of past visits (reports pending, open orders): the id, the name, the phone and the visit date — nothing the lab needed only on the day.", ["n", "order_id", "name", "date_time"], ENTRY_VARS, 220, ["mobile", "since", "confirm_line", "centre"]),
  BATCH_STATUS_CHECK: lab("Combined ask after visits: were these collected? Header + the numbered items + how to reply.", ["items"], ["coordinator", "count", "items", "lab_name"], 400),
  BATCH_ASSIGN_PHLEBO: lab("Combined ask: these visits have no phlebo yet; share name and number.", ["items"], ["coordinator", "count", "items", "lab_name"], 400),
  BATCH_PHLEBO_ETA: lab("Combined ask: is the phlebo on time? Reply with the ETA.", ["items"], ["coordinator", "count", "items", "lab_name"], 400),
  BATCH_UNCONFIRMED: lab("Combined ask: please confirm these orders (each item carries its confirm link).", ["items"], ["coordinator", "count", "items", "lab_name"], 400),
  BATCH_REPORT_CHASE: lab("Combined ask: these reports are pending; share them or say when.", ["items"], ["coordinator", "count", "items", "lab_name"], 400),
  BATCH_OVERDUE: lab("Combined ask: these orders are running late at a step; update LabStack or reply.", ["items"], ["coordinator", "count", "items", "lab_name"], 400),
  BATCH_NEW_ORDER: lab("Combined new orders: header + the full item blocks + how to confirm or decline.", ["items"], ["coordinator", "count", "items", "lab_name"], 400),
  BATCH_FOLLOW_UP: lab("Second ask, replying to the earlier combined message: names the items still open.", ["numbers"], ["coordinator", "numbers", "since", "count", "lab_name"], 200),
  BATCH_FOLLOW_UP_FIRM: lab("Third ask on, firmer: the items still pending since a time; update LabStack or reply.", ["numbers"], ["coordinator", "numbers", "since", "count", "lab_name"], 240),
  BATCH_ESCALATION: { purpose: "To the lab's manager, in a personal chat: the orders their team has not confirmed; each item has its link.", audience: "manager", required: ["items"], allowed: ["manager_name", "lab_name", "count", "orders_word", "items"], maxChars: 400 },
  PROVIDER_DAILY_DIGEST: lab("The evening list: tomorrow's orders for the lab (the entries are rendered separately into {{tomorrow_schedule}}), with counts and a line asking to confirm the pending ones.", ["tomorrow_schedule"], ["lab_name", "tomorrow_date", "tomorrow_total", "tomorrow_schedule", "tomorrow_confirmed", "tomorrow_unconfirmed", "summary_date", "order_count", "order_list"], 400),
  STORE_STATUS_ANSWER: store("Answer to a store's status question about an order, from the console.", ["order_id", "status_line"], 240),
  STORE_CHECKING: store("Tell the store we are asking the lab and will update here.", ["order_id"], 160),
  STORE_NOTED: store("Acknowledge a store's change request (reschedule, cancel, change): noted, confirming shortly.", ["order_id"], 160),
  STORE_PATIENT_UNREACHABLE: store("Tell the store the lab could not reach the customer; ask them to help reach them or share a slot.", ["order_id", "patient_name"], 320),
  STORE_COLLECTED: store("Tell the store the sample was collected.", ["order_id", "patient_name"], 200),
  STORE_LAB_RESCHEDULED: store("Tell the store the lab rescheduled, so they can tell the customer.", ["order_id", "patient_name", "detail"], 280),
  STORE_SAMPLE_OWED: store("Tell the store a sample is still to be collected and we are getting a slot.", ["order_id", "patient_name", "detail"], 280),
  STORE_LAB_CANCELLED: store("Tell the store the lab cancelled, with the reason, and that we are arranging an alternative.", ["order_id", "patient_name", "detail"], 320),
  STORE_LAB_CANNOT: store("Tell the store the lab cannot do this order and we are arranging an alternative.", ["order_id", "patient_name", "detail"], 280),
  STORE_REPORT_SHARED: store("Tell the store the lab shared the report and it is being uploaded.", ["order_id", "patient_name"], 200),
  STORE_AT_RISK: store("Warn the store a collection is at risk, with the reason, when we expect it, and an alternative to offer.", ["order_id", "slot", "reason"], 320),
  STORE_CANNOT_TODAY: store("Tell the store a collection cannot happen today, with the reason, and ask for an alternative.", ["order_id", "slot", "reason"], 320),
};

export const STYLE_KEYS = Object.keys(STYLE_CONTRACTS);

// ── Which body a send uses ───────────────────────────────────────────────

type Trial = { id: string; key: string; body: string; share: number };
let trialCache: { at: number; byKey: Map<string, Trial> } | null = null;
const TRIAL_CACHE_MS = 60_000;

async function trials(): Promise<Map<string, Trial>> {
  if (trialCache && Date.now() - trialCache.at < TRIAL_CACHE_MS) return trialCache.byKey;
  const rows = await prisma.agentMessageVariant.findMany({ where: { status: "TRIAL" }, select: { id: true, key: true, body: true, share: true }, orderBy: { createdAt: "asc" } }).catch(() => []);
  const byKey = new Map<string, Trial>();
  for (const r of rows) if (!byKey.has(r.key)) byKey.set(r.key, r);
  trialCache = { at: Date.now(), byKey };
  return byKey;
}
export function invalidateStyleCache() { trialCache = null; }

/** A stable split: the same counterparty always sees the same arm of a trial. */
export function inTrial(counterparty: string, share: number, salt = ""): boolean {
  let h = 2166136261;
  for (const ch of `${salt}|${counterparty}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return (h % 1000) / 1000 < share;
}

/** The live body for a key: the Templates-page row, seeded from the default. */
export async function liveBody(key: string): Promise<{ body: string; isActive: boolean }> {
  if (isNonApiTemplateKey(key)) { const t = await ensureTemplate(key); return { body: t.body, isActive: t.isActive }; }
  const def = STYLE_DEFAULTS[key];
  if (def) {
    const row = await prisma.labCommunicationTemplate.upsert({ where: { key }, update: {}, create: { key, name: def.name, body: def.body, isActive: true }, select: { body: true, isActive: true } });
    return row.isActive ? row : { body: def.body, isActive: true };
  }
  const row = await prisma.labCommunicationTemplate.findUnique({ where: { key }, select: { body: true, isActive: true } });
  if (!row) throw new Error(`Template ${key} was not found`);
  return row;
}

export type Styled = { body: string; variantId: string | null; isActive: boolean };

/** The body a send to this counterparty uses: the trial variant for its share of counterparties, else the live body. */
export async function styledBody(key: string, counterparty: string | null, live?: { body: string; isActive: boolean }): Promise<Styled> {
  const base = live ?? await liveBody(key);
  const trial = counterparty ? (await trials()).get(key) : undefined;
  if (trial && base.isActive && inTrial(counterparty!, trial.share, trial.id)) return { body: trial.body, variantId: trial.id, isActive: true };
  return { body: base.body, variantId: null, isActive: base.isActive };
}

// ── Rendering where parts may be empty ───────────────────────────────────

/**
 * Render a body whose variables may be empty: an empty variable vanishes, a line
 * left with nothing but punctuation and emoji vanishes, " · " separators collapse.
 */
export function renderLoose(body: string, vars: Record<string, string | null | undefined>): string {
  const rendered = body.replace(/{{\s*([a-z_]+)\s*}}/g, (_m, k: string) => (vars[k] ?? "").toString().replace(/^[ \t]+|[ \t]+$/g, ""));
  const hasContent = (s: string) => /[\p{L}\p{N}]/u.test(s);
  return rendered
    .split("\n")
    .map((line) => {
      // A " · " separated segment that is left with only an emoji or punctuation ("📞") disappears.
      const indent = line.match(/^[ \t]*/)?.[0] ?? "";
      const segments = line.trim().split(/[ \t]*·[ \t]*/).map((s) => s.replace(/\(\s*\)/g, "").trim()).filter(hasContent);
      return indent + segments.join(" · ");
    })
    .filter((line) => hasContent(line))   // a line with no letter or digit left is dropped
    .join("\n")
    .trim();
}

// ── The contract check ───────────────────────────────────────────────────

const VAR_RE = /{{\s*([a-z_]+)\s*}}/g;

/** Why a variant body cannot be used, or null when it honours the contract. */
export function checkVariant(key: string, body: string, against?: string): string | null {
  const c = STYLE_CONTRACTS[key];
  if (!c) return `no contract for ${key}`;
  const text = body.trim();
  if (!text) return "empty";
  if (text.length > c.maxChars) return `too long: ${text.length} > ${c.maxChars} characters`;
  const used = new Set([...text.matchAll(VAR_RE)].map((m) => m[1]));
  const allowed = new Set<string>([...c.allowed, ...(isNonApiTemplateKey(key) ? allowedVariablesFor(key) : [])]);
  for (const v of used) if (!allowed.has(v)) return `uses {{${v}}}, which this message does not have`;
  const required = new Set<string>([...c.required, ...(isNonApiTemplateKey(key) ? requiredVariablesFor(key) : [])]);
  for (const v of required) if (!used.has(v)) return `missing {{${v}}}`;
  if (/{{|}}/.test(text.replace(VAR_RE, ""))) return "a stray {{ or }}";
  if (/https?:\/\//i.test(text) && !(against && /https?:\/\//i.test(against))) return "adds a link";
  if (/\b(guarantee|refund|free|discount|penalty|legal)\b/i.test(text)) return "promises or threatens";
  if (c.audience !== "manager" && key.startsWith("BATCH_") && !key.startsWith("BATCH_ITEM") && !used.has("coordinator")) return "a combined ask must address the coordinator ({{coordinator}})";
  return null;
}

// ── The send log ─────────────────────────────────────────────────────────

export type SendRecord = { key: string; variantId: string | null; counterparty: string; groupId?: string | null; outboundId?: string | null; orderIds: number[]; sentAt: Date };

/** Log a styled send; never throws (a lost log line is not a lost message). */
export async function recordSend(s: SendRecord): Promise<void> {
  await prisma.agentMessageSend.create({ data: { key: s.key, variantId: s.variantId, counterparty: s.counterparty, groupId: s.groupId ?? null, outboundId: s.outboundId ?? null, orderIds: s.orderIds, sentAt: s.sentAt } as Prisma.AgentMessageSendUncheckedCreateInput }).catch((e) => console.warn("[Style] send log:", e instanceof Error ? e.message : e));
}
