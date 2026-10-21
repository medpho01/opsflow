/**
 * Promises (DESIGN.md §4.3 step 4, FR-2.3, FR-8.6): a lab reply with a time
 * in it ("report by 6 pm", "reaching in 20 min", "tomorrow 10 am") sets the
 * due time of the checkpoint it is about. Pure: text and a reference time in,
 * a due instant out. Times are read in the operating time zone.
 */
import type { CheckpointName } from "./policy";

const MIN = 60_000;

/** Which checkpoint a fact kind answers for, and the promise kind it makes. */
export const FACT_TO_CHECKPOINT: Record<string, { checkpoint: CheckpointName; promise: "eta" | "report" | "confirm" | "reschedule" | "custom" }> = {
  confirmed: { checkpoint: "confirmed", promise: "confirm" },
  phlebo_name: { checkpoint: "phlebo_assigned", promise: "custom" },
  phlebo_phone: { checkpoint: "phlebo_assigned", promise: "custom" },
  eta: { checkpoint: "phlebo_reached", promise: "eta" },
  sample_collected: { checkpoint: "sample_collected", promise: "custom" },
  report_shared: { checkpoint: "report_delivered", promise: "report" },
  new_appointment_time: { checkpoint: "sample_collected", promise: "reschedule" },
  delay_reason: { checkpoint: "sample_collected", promise: "custom" },
  // Action-page taps and portal reads (DESIGN.md §4.5).
  phlebo_started: { checkpoint: "phlebo_reached", promise: "custom" },
  sample_delivered: { checkpoint: "sample_at_lab", promise: "custom" },
};

/** Local wall-clock parts of an instant. */
function localParts(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { hour: get("hour") % 24, minute: get("minute") };
}

/** The instant at local h:m on the same local day as `ref` (whole/half-hour zones). */
function atLocal(ref: Date, timeZone: string, hour: number, minute: number, dayOffset = 0): Date {
  const { hour: h, minute: m } = localParts(ref, timeZone);
  const sinceMidnight = (h * 60 + m) * MIN + (ref.getTime() % MIN);
  return new Date(ref.getTime() - sinceMidnight + (hour * 60 + minute) * MIN + dayOffset * 1440 * MIN);
}

/**
 * Read a time out of a reply, relative to `ref`.
 *   "by 6 pm", "6pm", "18:00", "9:15 am", "at 7"         → that time today (tomorrow if it has passed by more than 30 min)
 *   "in 20 min", "20 mins", "within 2 hrs", "1 hour"     → ref + duration
 *   "tomorrow 10 am", "kal 10 baje", "tomorrow"          → tomorrow (10:00 default)
 *   "shortly", "will check", "ok"                        → null (the SOP's default promise applies)
 */
export function parsePromiseTime(text: string, ref: Date, timeZone = "Asia/Kolkata"): Date | null {
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return null;

  const dur = t.match(/(?:in|within|after|next)?\s*(\d{1,3})\s*(min|mins|minutes|hr|hrs|hour|hours|h)\b/);
  if (dur) {
    const n = Number(dur[1]);
    const unit = dur[2].startsWith("h") ? 60 : 1;
    return new Date(ref.getTime() + n * unit * MIN);
  }
  if (/\bhalf an hour\b|\bhalf hour\b|\baadha ghanta\b/.test(t)) return new Date(ref.getTime() + 30 * MIN);
  if (/\b(an|one) hour\b|\bek ghanta\b/.test(t)) return new Date(ref.getTime() + 60 * MIN);

  const tomorrow = /\btomorrow\b|\bkal\b|\bnext day\b/.test(t);
  const clock = t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|baje|o'?clock)?\b/);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    const marker = clock[3]?.replace(/\./g, "");
    if (hour > 24 || minute > 59) return tomorrow ? atLocal(ref, timeZone, 10, 0, 1) : null;
    if (marker === "pm" && hour < 12) hour += 12;
    if (marker === "am" && hour === 12) hour = 0;
    // No marker: labs work by day, so 1–7 means afternoon/evening unless it is already morning context.
    if (!marker && hour >= 1 && hour <= 7) hour += 12;
    if (hour === 24) hour = 0;
    let due = atLocal(ref, timeZone, hour, minute, tomorrow ? 1 : 0);
    if (!tomorrow && due.getTime() < ref.getTime() - 30 * MIN) due = atLocal(ref, timeZone, hour, minute, 1);
    return due;
  }
  if (tomorrow) return atLocal(ref, timeZone, 10, 0, 1);
  if (/\bevening\b|\bshaam\b/.test(t)) return atLocal(ref, timeZone, 18, 0, 0);
  if (/\bmorning\b|\bsubah\b/.test(t)) return atLocal(ref, timeZone, 10, 0, localParts(ref, timeZone).hour >= 10 ? 1 : 0);
  if (/\bafternoon\b|\bdopahar\b/.test(t)) return atLocal(ref, timeZone, 14, 0, 0);
  return null;
}
