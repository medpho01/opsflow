/**
 * When the new-order message goes out.
 *
 * It is the one message that must reach the lab promptly with everything it
 * needs (patient, contact, address, map, tests, confirm link), so it has no
 * slot and no cap holds it. But it is also the majority of what a lab with
 * back-to-back orders sees (DOCS/features/provider-communication/
 * TIMELINE-WALKTHROUGH.md, C4), so it follows the rest of the engagement
 * design where that costs nothing:
 *
 *   - gather:  orders placed within GATHER_MINUTES of each other go as one
 *              "new orders (N)" message. The window starts at the earliest
 *              order still waiting for its message; everything placed before
 *              it closes joins. A lone order waits at most GATHER_MINUTES.
 *   - night:   an order placed 21:00–08:00 local waits for 08:00 (the evening
 *              list already covered tomorrow's visits, and nobody at the lab
 *              reads at 23:30).
 *   - urgency: a visit within NEAR_VISIT_MINUTES of placement goes at once;
 *              so does one the hold would leave fewer than VISIT_LEAD_MINUTES
 *              before (a 23:30 order for a 07:00 visit must not surface at
 *              08:00 — `notAfterAppointment` would drop it).
 *
 * Code constants, not configuration: one standard set for every lab.
 */
import { MS_PER_MIN } from "./evaluate";
import { atLocal, localParts } from "./batching";

export const NEW_ORDER_GATHER_MINUTES = 10;
/** The least notice a hold may leave before the visit. */
export const VISIT_LEAD_MINUTES = 90;
export const NIGHT_FROM_HOUR = 21;
export const NIGHT_UNTIL_HOUR = 8;
export const NEAR_VISIT_MINUTES = 180;

export function isNight(at: Date, timeZone: string): boolean {
  const { hour } = localParts(at, timeZone);
  return hour >= NIGHT_FROM_HOUR || hour < NIGHT_UNTIL_HOUR;
}

/** The next 08:00 local strictly after `at`. */
export function nextMorning(at: Date, timeZone: string): Date {
  const morning = atLocal(at, timeZone, NIGHT_UNTIL_HOUR, 0);
  return morning.getTime() > at.getTime() ? morning : new Date(morning.getTime() + 1440 * MS_PER_MIN);
}

/**
 * The instant the new-order message for an order placed at `dueAt` goes out.
 * `gatherFrom` is the placement time of the earliest order of the same lab
 * still waiting for its message (this one, when it is the earliest).
 */
export function newOrderReleaseAt(dueAt: Date, appointmentAt: Date | null, gatherFrom: Date | null, timeZone: string): Date {
  const visitIn = appointmentAt ? appointmentAt.getTime() - dueAt.getTime() : Infinity;
  if (visitIn <= NEAR_VISIT_MINUTES * MS_PER_MIN) return dueAt;

  const windowStart = gatherFrom && gatherFrom.getTime() <= dueAt.getTime() ? gatherFrom : dueAt;
  const windowEnd = new Date(windowStart.getTime() + NEW_ORDER_GATHER_MINUTES * MS_PER_MIN);
  let release = windowEnd.getTime() >= dueAt.getTime() ? windowEnd : new Date(dueAt.getTime() + NEW_ORDER_GATHER_MINUTES * MS_PER_MIN);

  if (isNight(dueAt, timeZone)) {
    const morning = nextMorning(dueAt, timeZone);
    if (morning.getTime() > release.getTime()) release = morning;
  }
  // Waiting must never cost the lab its lead time before the visit.
  if (appointmentAt && appointmentAt.getTime() < release.getTime() + VISIT_LEAD_MINUTES * MS_PER_MIN) return dueAt;
  return release;
}
