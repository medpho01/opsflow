/**
 * Combined messages: several orders, one ask, one message.
 *
 * Rules still decide per order ("order X needs a status check now"). For a
 * lab with batching LIVE, an item that can be combined waits for its intent's
 * next fixed SLOT and goes out with every other item for that lab and intent:
 *
 *   🔎 *Status check · 3 orders*
 *   1. #88704 · Manjusha · 7:00 am
 *   2. …
 *   Reply: *1 done, 2 not home, 3 at 5 pm* — or *all done*
 *
 * New orders combine too (intent NEW_ORDER, see new-order.ts): orders placed
 * within a short gather window go as one "new orders (N)" message with the
 * full detail block and a confirm link per order. Not combined: urgent rules
 * (P0) and anything for a lab with batching OFF.
 *
 * Slots are a fixed daily rhythm per ask, inside the lab's working hours, so
 * labs learn when to expect us and are never messaged at 05:00 or 23:00 (see
 * DAILY_SLOTS). A rule's repeat interval then works out to "the next slot".
 * Follow-ups quote the earlier message and name only what is still open.
 * Every message @mentions the lab's coordinators: people answer people.
 */
import { renderLoose, STYLE_DEFAULTS } from "@/lib/agents/style";
import { MS_PER_MIN } from "./evaluate";
import type { MessageRule } from "./types";

export type BatchingMode = "OFF" | "SHADOW" | "LIVE";

/** The new-order message: no slot, never held — gathered for a few minutes and combined (new-order.ts). */
export const NEW_ORDER_INTENT = "NEW_ORDER";
export const BATCH_INTENTS = [NEW_ORDER_INTENT, "ESCALATION", "PHLEBO", "ETA", "STATUS", "UNCONFIRMED", "OVERDUE", "REPORT"] as const;
export type KnownIntent = (typeof BATCH_INTENTS)[number];

const INTENT_BY_TEMPLATE: Record<string, KnownIntent> = {
  NON_API_REMINDER: "UNCONFIRMED",
  NON_API_URGENT_REMINDER: "UNCONFIRMED",
  NON_API_APPOINTMENT_REMINDER: "UNCONFIRMED",
  NON_API_ASSIGN_PHLEBO: "PHLEBO",
  NON_API_PHLEBO_ETA: "ETA",
  NON_API_STATUS_CHECK: "STATUS",
  NON_API_REPORT_CHASE: "REPORT",
  PROVIDER_SLA_MILESTONE: "OVERDUE",
};

/**
 * Which combined message this rule's items join, or null to send on its own.
 * Escalations to the manager combine among themselves (a different recipient);
 * a custom rule combines with itself only ("RULE:<id>").
 */
export function batchIntentOf(rule: MessageRule): string | null {
  if (rule.kind !== "ORDER") return null;
  if (rule.introduces) return NEW_ORDER_INTENT;
  if (rule.priority === 0) return null;
  // Timed close to the visit ("30 min before"): it cannot wait for a slot, or the
  // visit is over before it goes.
  const before = rule.triggerCondition?.minutesBeforeAppointment;
  if (typeof before === "number" && before <= 90) return null;
  if (rule.action === "ESCALATE" || rule.recipient === "MANAGER") return "ESCALATION";
  if (rule.milestoneLabel) return "OVERDUE";
  return INTENT_BY_TEMPLATE[rule.templateKey] ?? `RULE:${rule.id}`;
}

/** Order in which intents get a slot when a lab has more due than its per-slot cap. */
export function intentRank(intent: string): number {
  const index = (BATCH_INTENTS as readonly string[]).indexOf(intent);
  return index === -1 ? BATCH_INTENTS.length : index;
}

/**
 * When each ask goes out, local time. Time-sensitive asks (confirmation,
 * escalation) hourly; the rest a few times a day at the hours labs answered
 * most in the Oct 2026 chat review (DOCS/features/provider-communication/CHAT-REVIEW-OCT-2026.md).
 */
export const DAILY_SLOTS: Record<string, string[]> = {
  UNCONFIRMED: ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00"],
  ESCALATION: ["10:00", "12:00", "14:00", "16:00", "18:00"],
  PHLEBO: ["08:30", "10:30", "12:30", "14:30", "16:30", "18:30"],
  ETA: ["08:30", "10:30", "12:30", "14:30", "16:30", "18:30"],
  STATUS: ["11:00", "13:30", "16:00", "18:30"],
  REPORT: ["10:30", "16:30"],
  OVERDUE: ["12:00", "17:00"],
  /** The weekly lab scorecard (agents): Monday 10:30; the dispatcher's one-hour slot window carries it. */
  SCORECARD: ["10:30"],
};
const DEFAULT_SLOTS = ["09:00", "13:00", "17:00"];
export const slotsFor = (intent: string) => DAILY_SLOTS[intent] ?? DEFAULT_SLOTS;

export function localParts(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone,
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** The instant at local h:m on the same local day as `at` (offset-safe for whole-hour/half-hour zones). */
export function atLocal(at: Date, timeZone: string, hour: number, minute: number): Date {
  const { hour: h, minute: m, second: s } = localParts(at, timeZone);
  const sinceMidnight = (h * 60 + m) * MS_PER_MIN + s * 1000 + at.getMilliseconds();
  return new Date(at.getTime() - sinceMidnight + (hour * 60 + minute) * MS_PER_MIN);
}

/** The first slot for `intent` at or after `dueAt` (today, else tomorrow's first). */
export function nextSlot(intent: string, dueAt: Date, timeZone: string): Date {
  const slots = slotsFor(intent).map((s) => s.split(":").map(Number));
  for (let day = 0; day < 2; day += 1) {
    const base = new Date(dueAt.getTime() + day * 1440 * MS_PER_MIN);
    for (const [hour, minute] of slots) {
      const slot = atLocal(base, timeZone, hour, minute);
      if (slot.getTime() >= dueAt.getTime()) return slot;
    }
  }
  return dueAt;
}

/** An ask whose slot would miss the visit goes this long before the visit at the latest. */
export const VISIT_LEAD_MINUTES = 90;
/**
 * …and only between these local hours (the chat review found nobody answers
 * earlier, and nobody should be woken later) — unless the visit itself comes
 * before the next 07:00.
 */
export const EARLIEST_RELEASE_HOUR = 7;
export const LATEST_RELEASE_HOUR = 21;

const inWakingHours = (at: Date, timeZone: string) => {
  const { hour } = localParts(at, timeZone);
  return hour >= EARLIEST_RELEASE_HOUR && hour < LATEST_RELEASE_HOUR;
};
/** The next 07:00 local at or after `at`. */
const nextMorning = (at: Date, timeZone: string) => {
  const today = atLocal(at, timeZone, EARLIEST_RELEASE_HOUR, 0);
  return today.getTime() >= at.getTime() ? today : new Date(today.getTime() + 1440 * MS_PER_MIN);
};

/**
 * When an item due at `dueAt` goes out: its intent's next slot — unless that
 * slot falls at or after the order's visit, when waiting would drop the ask
 * (every pre-visit rule has `notAfterAppointment`). Then it goes at the
 * earlier of its due time and 90 min before the visit, within 07:00-21:00
 * local; outside those hours it waits for 07:00. A visit at or before the
 * next 07:00 is the one exception: 07:00 would miss it, so the ask goes at
 * the odd hour — the only chance it has.
 *
 * Example: visit Wed 07:00, order placed Tue 16:45. The 5 h manager escalation
 * (due 21:45) would wait for Wed 10:00; 07:00 would be the visit → goes Tue
 * 21:45. The phlebo ask and the 2 h ping (due 05:00) would wait for 08:30 /
 * 09:00 → go at 05:00. Visit Wed 09:00: the 2 h ping (due 07:00) would wait
 * for the 09:00 slot, which is the visit → goes at 07:00; that order's
 * escalation due Tue 21:45 → Wed 07:00.
 */
export function releaseAt(intent: string, dueAt: Date, timeZone: string, appointmentAt?: Date | null): Date {
  const slot = nextSlot(intent, dueAt, timeZone);
  // Only a visit still ahead can be missed: asks after the visit (status
  // check, report chase) keep their slots.
  if (!appointmentAt || appointmentAt.getTime() <= dueAt.getTime() || slot.getTime() < appointmentAt.getTime()) return slot;
  return earlyRelease(dueAt, appointmentAt, timeZone);
}

/** The pre-visit release for an ask whose slot would miss the visit (see releaseAt). */
export function earlyRelease(dueAt: Date, appointmentAt: Date, timeZone: string): Date {
  const wanted = new Date(Math.min(dueAt.getTime(), appointmentAt.getTime() - VISIT_LEAD_MINUTES * MS_PER_MIN));
  if (inWakingHours(wanted, timeZone)) return wanted;
  const morning = nextMorning(wanted, timeZone);
  return morning.getTime() < appointmentAt.getTime() ? morning : wanted;
}

/**
 * May this ask go out now, between slots, because waiting for its next slot
 * would miss the visit? Such an item is released off-slot by `releaseAt`, so
 * delivery must not hold it for a slot that will never be in time — but it
 * still keeps the 07:00-21:00 hours (an item the day cap held is not sent
 * at midnight when the cap resets) unless the visit is before the next 07:00.
 */
export function slotMissesVisit(intent: string, now: Date, appointmentAt: Date | null, timeZone: string): boolean {
  if (!appointmentAt || appointmentAt.getTime() <= now.getTime()) return false;
  if (nextSlot(intent, now, timeZone).getTime() < appointmentAt.getTime()) return false;
  return inWakingHours(now, timeZone) || nextMorning(now, timeZone).getTime() >= appointmentAt.getTime();
}

/** The local day of `at`, for the per-day cap: "2026-10-20". */
export function startOfLocalDay(at: Date, timeZone: string): Date {
  return atLocal(at, timeZone, 0, 0);
}

/** The slot `now` falls in: the latest :00/:30 at or before it. */
export function currentSlot(now: Date, timeZone: string): Date {
  const { minute, second } = localParts(now, timeZone);
  return new Date(now.getTime() - ((minute % 30) * 60 + second) * 1000 - now.getMilliseconds());
}

// ── Reading a reply to a combined message ────────────────────────────────

const ALL_RE = /^\s*(?:all|sab|sabhi|everything|all of them|all orders)\b[\s:,-]*(.*)$/i;

/**
 * Item numbers at the start of a token: "1", "1 2", "1 & 2", "1 and 2", "1/2",
 * "1-4", "1–4", "1 to 4", "1 se 4 (tak)" and mixes of these ("1-3 5").
 * Captures the number list and what follows it.
 */
const ITEMS_RE = /^#?(\d{1,2}(?:\s*(?:&|and|\/|-|–|—|to|se|tak|\s)\s*#?\d{1,2})*)(?:\s+tak\b)?\s*[:.)-]?\s*(.*)$/i;
const RANGE_OPS = new Set(["-", "–", "—", "to", "se"]);

/** "1-3 5" → [1, 2, 3, 5]; keeps only numbers that are items of this message. */
export function expandItemNumbers(list: string, numbers: Set<number>): number[] {
  const out: number[] = [];
  let last: number | null = null;
  let range = false;
  for (const match of list.matchAll(/\d{1,2}|-|–|—|\b(?:to|se)\b/gi)) {
    const token = match[0];
    if (RANGE_OPS.has(token.toLowerCase())) { range = last != null; continue; }
    const n = Number(token);
    if (range && last != null && n > last) for (let i = last + 1; i < n; i += 1) out.push(i);
    out.push(n);
    last = n;
    range = false;
  }
  return [...new Set(out)].filter((n) => numbers.has(n));
}

/**
 * Split a lab's reply into the part about each numbered item.
 *
 *   "1 done, 2 not home, 3 at 5 pm"  → {1: "done", 2: "not home", 3: "at 5 pm"}
 *   "1,2 collected. 3 rescheduled"     → {1: "collected", 2: "collected", 3: "rescheduled"}
 *   "1-4 ok", "1 to 4 ok", "1 se 4 ok" → items 1..4: "ok"
 *   "1-3, 5 ok"                        → items 1, 2, 3, 5: "ok"
 *   "all done"                         → every item: "done"
 *   "88704 done"                       → the item for order 88704
 *   anything, for a one-item message   → that item
 *
 * Items it cannot place are left out (never guessed).
 */
export function splitBatchReply(text: string, items: Array<{ n: number; orderId: number; labRef?: string | null; line?: string }>): Map<number, string> {
  const result = new Map<number, string>();
  const clean = (text || "").replace(/\*/g, "").trim();
  if (!clean || items.length === 0) return result;
  const numbers = new Set(items.map((item) => item.n));

  // The lab's own reference, as labs answer (25 Oct 2026): "VL336FC5 serviced",
  // "Booking (ID: 19457839) sample collected", "BLR6365567 — collection in progress".
  // Matched against the reference on the item, else the reference in its line.
  const refOf = (item: { labRef?: string | null; line?: string }) =>
    (item.labRef ?? item.line?.match(/^\d+\.\s*([A-Z]{2,5}[0-9A-Z]{4,}|\d{7,9})\s*·/)?.[1] ?? null)?.toUpperCase() ?? null;
  const byRef = new Map(items.flatMap((item) => { const r = refOf(item); return r ? [[r, item.n] as const] : []; }));
  if (byRef.size) {
    // A reference has letters and digits (VL336FC5, BLR6365567) or is a long number; a word is never one.
    const refTokens = [...clean.matchAll(/(?:booking\s*\(?\s*id\s*:?\s*)?\b(?=[A-Za-z0-9]*\d)([A-Za-z]{2,5}[0-9A-Za-z]{4,}|\d{7,9})\b\)?\s*[:.)\-–—]?\s*([^\n;]*)/g)];
    let hit = false;
    for (const [k, m] of refTokens.entries()) {
      const n = byRef.get(m[1].toUpperCase());
      if (n == null) continue;
      hit = true;
      let said = m[2].trim();
      // The lab pasted our own line ("1. VL336FC5 · #93942 · Anvesh · …") and answered under
      // it: the answer is what follows the line, up to the next reference.
      if (!said || said.startsWith("·")) {
        const start = (m.index ?? 0) + m[0].length;
        const next = refTokens[k + 1]?.index ?? clean.length;
        said = clean.slice(start, next).trim();
      }
      result.set(n, said || clean);
    }
    if (hit) return result;
  }

  const all = clean.match(ALL_RE);
  if (all) {
    const rest = all[1].trim() || clean;
    for (const item of items) result.set(item.n, rest);
    return result;
  }

  // Order ids named in the text: "88704 done, 88711 not home".
  const byOrder = new Map(items.map((item) => [String(item.orderId), item.n]));
  const tokens = clean.split(/[\n;,]+|\.\s+/).map((part) => part.trim()).filter(Boolean);
  let pending: number[] = [];
  for (const token of tokens) {
    const orderMatch = token.match(/#?(\d{5,})\b\s*[:.)-]?\s*(.*)$/);
    if (orderMatch && byOrder.has(orderMatch[1])) {
      const n = byOrder.get(orderMatch[1])!;
      if (orderMatch[2]) { for (const p of [...pending, n]) result.set(p, orderMatch[2].trim()); pending = []; }
      else pending.push(n);
      continue;
    }
    // "1 done", "2) not home", "#3: at 5 pm", "1 & 2 collected", "1-4 ok", "1 to 4 ok", "1 2 collected"
    let numbered = token.match(ITEMS_RE);
    // "2 by 3 pm", "2-3 pm reaching": the second number is a time, not an item.
    if (numbered && /^(?:am|pm|baje|o'?clock|min|mins|hrs?|hours?)\b/i.test(numbered[2] ?? "")) numbered = token.match(/^#?(\d{1,2})\s*[:.)-]?\s*(.*)$/);
    if (numbered) {
      const ns = expandItemNumbers(numbered[1], numbers);
      const said = numbered[2]?.trim();
      if (ns.length === 0) continue;
      if (said) { for (const n of [...pending, ...ns]) result.set(n, said); pending = []; }
      else pending.push(...ns);
      continue;
    }
    // Free text right after bare numbers: "1, 2 collected" arrives as "1" then "2 collected".
    if (pending.length) { for (const n of pending) result.set(n, token); pending = []; }
  }

  if (result.size === 0 && items.length === 1) result.set(items[0].n, clean);
  return result;
}

// ── One line per order ───────────────────────────────────────────────────

export type ItemLineData = {
  n: number;
  orderId: number;
  patientName: string | null;
  appointment: Date | null;
  area?: string | null;
  phlebo?: string | null;
  confirmUrl?: string | null;
  createdAt?: Date;
  milestone?: string | null;
  dueAt?: Date;
  /** The lab's own order reference (API labs): what their desk searches by. */
  labRef?: string | null;
  /** A short specific note on the line ("urine pending"). */
  note?: string | null;
  /** New-order block: the patient's details the lab needs to serve the order. */
  mobile?: string | null;
  address?: string | null;
  mapUrl?: string | null;
  tests?: string | null;
};

const firstName = (name: string | null) => (name || "Patient").trim().split(/\s+/)[0];

/** "7:00 am" today, "tomorrow 7:00 am", "yesterday 7:00 am", else "Thu 9 Oct 7:00 am". */
export function shortWhen(at: Date | null, now: Date, timeZone: string): string {
  if (!at) return "no appointment time";
  const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone });
  const time = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone }).format(at);
  const diffDays = Math.round((Date.parse(day(at)) - Date.parse(day(now))) / 86_400_000);
  if (diffDays === 0) return time;
  if (diffDays === 1) return `tomorrow ${time}`;
  if (diffDays === -1) return `yesterday ${time}`;
  const date = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone }).format(at);
  return `${date} ${time}`;
}

function ago(from: Date | undefined | null, now: Date): string {
  if (!from) return "";
  const minutes = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

/**
 * The single line (plus a link line where the ask needs one) for an order in a
 * combined message. A new order is the exception: a block — full name, visit,
 * contact, address, map, tests and the confirm link — since this is the one
 * message that must carry everything the lab needs.
 */
export function itemLine(intent: string, item: ItemLineData, now: Date, timeZone: string, body?: string): string {
  const when = shortWhen(item.appointment, now, timeZone);
  if (intent === NEW_ORDER_INTENT) {
    return renderLoose(body ?? STYLE_DEFAULTS.BATCH_ITEM_NEW_ORDER.body, {
      n: String(item.n), ref: item.labRef ? `${item.labRef} · ` : "", order_id: String(item.orderId), name: (item.patientName || "Patient").trim(), when,
      mobile: item.mobile, area: item.address ?? item.area, map_url: item.mapUrl, tests: item.tests, note: item.note, link: item.confirmUrl, extra: "",
    });
  }
  // Labs find an order by their own reference or the patient's phone, not by our id (Orange, 24 Oct 2026).
  // `when` is the time phrase this ask needs; `extra` what else it carries (the phlebo, the wait).
  const phrase: Record<string, { when: string; extra: string }> = {
    ETA: { when, extra: item.phlebo ?? "" },
    ESCALATION: { when, extra: item.createdAt ? `waiting ${ago(item.createdAt, now)}` : "" },
    REPORT: { when: `visit ${when} (${ago(item.appointment, now)} ago)`, extra: "" },
    OVERDUE: { when: `${item.milestone ?? "update"} ${ago(item.dueAt, now)} late`, extra: "" },
    // No visit time: it read as a slot on offer (29 Oct 2026: "10:15 am · urine sample pending").
    RECOLLECT: { when: "", extra: "" },
  };
  const p = phrase[intent] ?? { when, extra: "" };
  return renderLoose(body ?? STYLE_DEFAULTS.BATCH_ITEM.body, {
    // A report is found by the patient's full name at a manual lab (29 Oct 2026: the team chases by name lists).
    n: String(item.n), ref: item.labRef ? `${item.labRef} · ` : "", order_id: String(item.orderId), name: intent === "REPORT" ? (item.patientName || "Patient").trim() : firstName(item.patientName),
    mobile: item.mobile, area: item.area, when: p.when, extra: p.extra, note: item.note, link: item.confirmUrl ? `\n    ${item.confirmUrl}` : "",
  });
}

/**
 * Is one of this ask's slots open right now (it started within the last hour)?
 * Items held back — by the per-slot or per-day cap — only ever go out in a slot,
 * never at, say, 00:00 when the day cap resets.
 */
export function isSlotOpen(intent: string, now: Date, timeZone: string, windowMinutes = 60): boolean {
  return slotsFor(intent).some((slot) => {
    const [hour, minute] = slot.split(":").map(Number);
    const start = atLocal(now, timeZone, hour, minute).getTime();
    return now.getTime() >= start && now.getTime() - start < windowMinutes * MS_PER_MIN;
  });
}
