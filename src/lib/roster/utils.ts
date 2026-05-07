/**
 * Roster utility functions for time validation and calculations
 */

export function isValidTimeFormat(time: string): boolean {
  const pattern = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
  return pattern.test(time);
}

export function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0");
  const m = (minutes % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

export function isTimeAfter(time1: string, time2: string): boolean {
  return timeToMinutes(time1) > timeToMinutes(time2);
}

export function isTimeEqual(time1: string, time2: string): boolean {
  return timeToMinutes(time1) === timeToMinutes(time2);
}

export function isTimeWithin(time: string, start: string, end: string): boolean {
  const mins = timeToMinutes(time);
  const minsStart = timeToMinutes(start);
  const minsEnd = timeToMinutes(end);
  return mins >= minsStart && mins <= minsEnd;
}

export function getTimeRange(startTime: string, endTime: string): { start: number; end: number } {
  return {
    start: timeToMinutes(startTime),
    end: timeToMinutes(endTime),
  };
}

export function getDayOfWeekFromDate(date: string): number {
  // date format: YYYY-MM-DD
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error("Invalid date format");
  const dateObj = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return dateObj.getUTCDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
}

export function formatDate(date: Date | string): string {
  if (typeof date === "string") return date;
  const year = date.getUTCFullYear();
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getDayName(dayOfWeek: number): string {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return days[dayOfWeek] || "Unknown";
}

/**
 * Calculate actual roster status for a person on a given date
 * considering both their weekly schedule and exceptions
 */
export interface ScheduledTime {
  isWorking: boolean;
  startTime?: string;
  endTime?: string;
  breakStart?: string;
  breakEnd?: string;
}

export interface RosterException {
  status: "ON_LEAVE" | "SICK" | "OFF";
  note?: string;
  createdBy?: number;
  createdAt: Date;
}

export interface DailyRosterEntry {
  userId: number;
  name: string;
  scheduled: ScheduledTime;
  exception: RosterException | null;
  status: "ACTIVE" | "ON_LEAVE" | "SICK" | "OFF";
}

export function calculateRosterStatus(scheduled: ScheduledTime, exception: RosterException | null): "ACTIVE" | "ON_LEAVE" | "SICK" | "OFF" {
  // Exception overrides schedule
  if (exception) {
    return exception.status as "ON_LEAVE" | "SICK" | "OFF";
  }

  // If not scheduled to work, status is OFF
  if (!scheduled.isWorking) {
    return "OFF";
  }

  // Otherwise ACTIVE
  return "ACTIVE";
}

/**
 * Check if an agent is available for task assignment on a given date
 */
export function isAgentAvailable(rosterStatus: string): boolean {
  return rosterStatus === "ACTIVE";
}

/**
 * Format time range for display (e.g., "09:00 AM - 5:00 PM")
 */
export function formatTimeRange(startTime: string, endTime: string): string {
  const formatTime = (time: string) => {
    const [h, m] = time.split(":").map(Number);
    const meridiem = h >= 12 ? "PM" : "AM";
    const displayH = h % 12 === 0 ? 12 : h % 12;
    return `${displayH}:${m.toString().padStart(2, "0")} ${meridiem}`;
  };

  return `${formatTime(startTime)} - ${formatTime(endTime)}`;
}

/**
 * Format break time for display
 */
export function formatBreakTime(breakStart: string | null, breakEnd: string | null): string | null {
  if (!breakStart || !breakEnd) return null;
  return formatTimeRange(breakStart, breakEnd);
}

/**
 * Validate a weekly schedule for a team member
 * Returns { valid: boolean, errors: string[] }
 */
export interface ScheduleDay {
  dayOfWeek: number;
  isWorking: boolean;
  startTime?: string;
  endTime?: string;
  breakStart?: string;
  breakEnd?: string;
}

export function validateSchedule(days: ScheduleDay[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const day of days) {
    const dayName = getDayName(day.dayOfWeek);

    // Check dayOfWeek
    if (day.dayOfWeek < 0 || day.dayOfWeek > 6) {
      errors.push(`${dayName}: Invalid day of week`);
    }

    if (day.isWorking) {
      // Check required fields
      if (!day.startTime || !day.endTime) {
        errors.push(`${dayName}: Start and end times required when working`);
        continue;
      }

      // Check time format
      if (!isValidTimeFormat(day.startTime)) {
        errors.push(`${dayName}: Invalid start time format`);
      }
      if (!isValidTimeFormat(day.endTime)) {
        errors.push(`${dayName}: Invalid end time format`);
      }

      // Check time logic
      if (isValidTimeFormat(day.startTime) && isValidTimeFormat(day.endTime)) {
        if (!isTimeAfter(day.endTime, day.startTime)) {
          errors.push(`${dayName}: End time must be after start time`);
        }

        // Check break times
        if (day.breakStart || day.breakEnd) {
          if (!day.breakStart || !day.breakEnd) {
            errors.push(`${dayName}: Both break start and end required if any break time provided`);
          } else {
            if (!isValidTimeFormat(day.breakStart)) {
              errors.push(`${dayName}: Invalid break start time format`);
            }
            if (!isValidTimeFormat(day.breakEnd)) {
              errors.push(`${dayName}: Invalid break end time format`);
            }

            if (isValidTimeFormat(day.breakStart) && isValidTimeFormat(day.breakEnd)) {
              if (!isTimeAfter(day.breakEnd, day.breakStart)) {
                errors.push(`${dayName}: Break end time must be after break start time`);
              }
              if (!isTimeWithin(day.breakStart, day.startTime, day.endTime)) {
                errors.push(`${dayName}: Break start time must be within work hours`);
              }
              if (!isTimeWithin(day.breakEnd, day.startTime, day.endTime)) {
                errors.push(`${dayName}: Break end time must be within work hours`);
              }
            }
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
