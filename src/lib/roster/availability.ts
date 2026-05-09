/**
 * Roster availability utility — computes whether a team member is currently available
 * for task assignment, based on weekly schedule + roster exceptions.
 *
 * This is the single source of truth used by both:
 *   - GET /api/team        (display rosterStatus in the UI)
 *   - pickAssignee()       (filter eligible agents during auto-assignment)
 *
 * Logic priority:
 *   1. Roster exception for today (highest — explicit override)
 *      - status="ACTIVE" → available even if schedule says OFF
 *      - status="OFF" / "SICK" / "ON_LEAVE" → not available
 *   2. Weekly schedule for today's day-of-week
 *      - missing or isWorking=false → not available
 *      - current time outside startTime–endTime → not available
 *      - current time inside breakStart–breakEnd → not available
 *      - otherwise → available
 */

export interface ScheduleSlice {
  isWorking: boolean;
  startTime: string | null;
  endTime: string | null;
  breakStart: string | null;
  breakEnd: string | null;
}

export interface ExceptionSlice {
  status: string; // "ACTIVE" | "OFF" | "SICK" | "ON_LEAVE"
}

export type RosterStatus = "ACTIVE" | "OFF" | "SICK" | "ON_LEAVE";

/**
 * Compute current roster status for a team member.
 * @param schedule  Weekly schedule entry for today's day-of-week (null if none exists)
 * @param exception Roster exception for today's date (null if none exists)
 * @param now       Current time — defaults to new Date(); pass an explicit value for testing
 */
export function computeRosterStatus(
  schedule: ScheduleSlice | null,
  exception: ExceptionSlice | null,
  now: Date = new Date()
): RosterStatus {
  // 1. Exception takes priority
  if (exception) {
    if (exception.status === "ACTIVE") return "ACTIVE";
    if (exception.status === "OFF") return "OFF";
    if (exception.status === "SICK") return "SICK";
    if (exception.status === "ON_LEAVE") return "ON_LEAVE";
    return "OFF"; // unknown exception status → safe default
  }

  // 2. Weekly schedule
  if (!schedule || !schedule.isWorking) return "OFF";

  const currentTime = now.toTimeString().slice(0, 5); // "HH:MM"
  const startTime = schedule.startTime || "00:00";
  const endTime = schedule.endTime || "23:59";

  if (currentTime < startTime || currentTime > endTime) return "OFF";

  // Inside break window?
  if (schedule.breakStart && schedule.breakEnd) {
    if (currentTime >= schedule.breakStart && currentTime <= schedule.breakEnd) {
      return "OFF";
    }
  }

  return "ACTIVE";
}

/** Convenience wrapper: returns true iff status === "ACTIVE". */
export function isAvailableNow(
  schedule: ScheduleSlice | null,
  exception: ExceptionSlice | null,
  now: Date = new Date()
): boolean {
  return computeRosterStatus(schedule, exception, now) === "ACTIVE";
}

/** Day-of-week (0=Sunday … 6=Saturday) for the given date in UTC. */
export function getUTCDayOfWeek(date: Date = new Date()): number {
  return date.getUTCDay();
}
