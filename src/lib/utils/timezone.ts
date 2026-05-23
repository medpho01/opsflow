/**
 * Timezone utility functions
 *
 * All timestamps from the source DB (labstack/dhanavantri) are converted to
 * proper UTC at the SQL boundary via `AT TIME ZONE 'Asia/Kolkata'` (see
 * src/lib/engine/labstack.ts). Prisma deserialises them as correct UTC Date
 * objects that the JS Date constructor reads as-is.
 *
 * These helpers simply render a UTC ISO string in IST for display using the
 * IANA timezone identifier "Asia/Kolkata" (UTC+5:30). No manual arithmetic
 * is needed — the Intl API handles DST-safety and correct offset application.
 *
 * ⚠️  The old approach subtracted IST_OFFSET_MS from the UTC value before
 * calling toLocaleString. That was a band-aid for an earlier schema where
 * timestamps were stored as naive IST values and read as UTC without
 * correction. The AT TIME ZONE fix in labstack.ts made the SQL do the right
 * thing; subtracting the offset again would show a time 5h30 too early.
 * Do NOT re-add the manual subtraction.
 */

/**
 * Format a UTC timestamp string for display in IST (Asia/Kolkata).
 *
 * @param timestampString - any ISO 8601 / Date-parseable string (UTC)
 * @param options         - Intl.DateTimeFormatOptions (timeZone is forced to "Asia/Kolkata")
 * @returns formatted string, e.g. "23 May, 06:00 pm"
 */
export function formatISTTimestamp(
  timestampString: string,
  options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }
): string {
  const date = new Date(timestampString);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-IN", { ...options, timeZone: "Asia/Kolkata" });
}

/**
 * Format just the date portion of a UTC timestamp in IST.
 */
export function formatISTDate(
  timestampString: string,
  options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    year: "numeric",
  }
): string {
  const date = new Date(timestampString);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", { ...options, timeZone: "Asia/Kolkata" });
}

/**
 * Format just the time portion of a UTC timestamp in IST.
 */
export function formatISTTime(
  timestampString: string,
  options: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
  }
): string {
  const date = new Date(timestampString);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("en-IN", { ...options, timeZone: "Asia/Kolkata" });
}
