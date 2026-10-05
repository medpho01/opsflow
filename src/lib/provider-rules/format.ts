/**
 * How dates, times and durations read in provider messages. One place, so a
 * reminder, its poll acknowledgement and the evening list say "6 Oct" alike.
 */
export const TIME_ZONE = () => process.env.TIMEZONE || "Asia/Kolkata";

export function formatDate(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: TIME_ZONE() }).format(date);
}

export function formatTime(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: TIME_ZONE() }).format(date);
}

export function formatDateTime(value: Date | string): string {
  return `${formatDate(value)} ${formatTime(value)}`;
}

/** "Tue, 6 Oct" (weekday kept: it earns its place in a daily message). */
export function dayLabel(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TIME_ZONE() }).format(value);
}

/** 95 → "1 h 35 min", 30 → "30 min", 1500 → "1 d 1 h". */
export function durationText(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;
  if (total < 1440) {
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  return h ? `${d} d ${h} h` : `${d} d`;
}
