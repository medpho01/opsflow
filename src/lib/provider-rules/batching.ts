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
 * Not combined: the new-order message (it carries the full details once),
 * urgent rules (P0) and anything for a lab with batching OFF.
 *
 * Slots are fixed, so labs learn when to expect us: :00 and :30, and report
 * chases at 10:00, 14:00 and 18:00 (local time).
 */
import { MS_PER_MIN } from "./evaluate";
import type { MessageRule } from "./types";

export type BatchingMode = "OFF" | "SHADOW" | "LIVE";

export const BATCH_INTENTS = ["ESCALATION", "PHLEBO", "ETA", "STATUS", "UNCONFIRMED", "OVERDUE", "REPORT"] as const;
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
  if (rule.kind !== "ORDER" || rule.introduces || rule.priority === 0) return null;
  if (rule.action === "ESCALATE" || rule.recipient === "MANAGER") return "ESCALATION";
  if (rule.milestoneLabel) return "OVERDUE";
  return INTENT_BY_TEMPLATE[rule.templateKey] ?? `RULE:${rule.id}`;
}

/** Order in which intents get a slot when a lab has more due than its per-slot cap. */
export function intentRank(intent: string): number {
  const index = (BATCH_INTENTS as readonly string[]).indexOf(intent);
  return index === -1 ? BATCH_INTENTS.length : index;
}

const REPORT_SLOTS = [10, 14, 18];

function localParts(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone,
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** The instant at local h:m on the same local day as `at` (offset-safe for whole-hour/half-hour zones). */
function atLocal(at: Date, timeZone: string, hour: number, minute: number): Date {
  const { hour: h, minute: m, second: s } = localParts(at, timeZone);
  const sinceMidnight = (h * 60 + m) * MS_PER_MIN + s * 1000 + at.getMilliseconds();
  return new Date(at.getTime() - sinceMidnight + (hour * 60 + minute) * MS_PER_MIN);
}

/** The first slot for `intent` at or after `dueAt`. */
export function releaseAt(intent: string, dueAt: Date, timeZone: string): Date {
  if (intent === "REPORT") {
    for (let day = 0; day < 2; day += 1) {
      const base = new Date(dueAt.getTime() + day * 1440 * MS_PER_MIN);
      for (const hour of REPORT_SLOTS) {
        const slot = atLocal(base, timeZone, hour, 0);
        if (slot.getTime() >= dueAt.getTime()) return slot;
      }
    }
  }
  const { minute, second } = localParts(dueAt, timeZone);
  if (minute % 30 === 0 && second === 0 && dueAt.getMilliseconds() === 0) return dueAt;
  const startOfMinute = dueAt.getTime() - second * 1000 - dueAt.getMilliseconds();
  return new Date(startOfMinute + (30 - (minute % 30)) * MS_PER_MIN);
}

/** The slot `now` falls in: the latest :00/:30 at or before it. */
export function currentSlot(now: Date, timeZone: string): Date {
  const { minute, second } = localParts(now, timeZone);
  return new Date(now.getTime() - ((minute % 30) * 60 + second) * 1000 - now.getMilliseconds());
}

// ── Reading a reply to a combined message ────────────────────────────────

const ALL_RE = /^\s*(?:all|sab|sabhi|everything|all of them|all orders)\b[\s:,-]*(.*)$/i;

/**
 * Split a lab's reply into the part about each numbered item.
 *
 *   "1 done, 2 not home, 3 at 5 pm"  → {1: "done", 2: "not home", 3: "at 5 pm"}
 *   "1,2 collected. 3 rescheduled"     → {1: "collected", 2: "collected", 3: "rescheduled"}
 *   "all done"                         → every item: "done"
 *   "88704 done"                       → the item for order 88704
 *   anything, for a one-item message   → that item
 *
 * Items it cannot place are left out (never guessed).
 */
export function splitBatchReply(text: string, items: Array<{ n: number; orderId: number }>): Map<number, string> {
  const result = new Map<number, string>();
  const clean = (text || "").replace(/\*/g, "").trim();
  if (!clean || items.length === 0) return result;
  const numbers = new Set(items.map((item) => item.n));

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
    // "1 done", "2) not home", "#3: at 5 pm", "1 & 2 collected", "1 2 collected"
    const numbered = token.match(/^#?((?:\d{1,2}\s*(?:&|and|\/|\s)\s*)*\d{1,2})\s*[:.)-]?\s+(.+)$/i)
      ?? token.match(/^#?(\d{1,2})\s*[:.)-]?$/);
    if (numbered) {
      const ns = numbered[1].split(/\s*(?:&|and|\/|\s)\s*/i).map(Number).filter((n) => numbers.has(n));
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

/** The single line (plus a link line where the ask needs one) for an order in a combined message. */
export function itemLine(intent: string, item: ItemLineData, now: Date, timeZone: string): string {
  const head = `${item.n}. #${item.orderId} · ${firstName(item.patientName)}`;
  const when = shortWhen(item.appointment, now, timeZone);
  const link = item.confirmUrl ? `\n    ${item.confirmUrl}` : "";
  switch (intent) {
    case "PHLEBO": return `${head} · ${when}${item.area ? ` · ${item.area}` : ""}`;
    case "ETA": return `${head} · ${when}${item.phlebo ? ` · ${item.phlebo}` : ""}`;
    case "UNCONFIRMED": return `${head} · ${when}${link}`;
    case "ESCALATION": return `${head} · ${when} · waiting ${ago(item.createdAt, now)}${link}`;
    case "REPORT": return `${head} · visit ${when} (${ago(item.appointment, now)} ago)`;
    case "OVERDUE": return `${head} · ${item.milestone ?? "update"} ${ago(item.dueAt, now)} late`;
    default: return `${head} · ${when}`;
  }
}
