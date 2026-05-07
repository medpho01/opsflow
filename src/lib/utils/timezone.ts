/**
 * Timezone utility functions
 *
 * Our database stores timestamps as "timestamp without time zone" (naive).
 * PostgreSQL server timezone is set to Asia/Kolkata (IST, UTC+5:30).
 * This means naive timestamps represent IST time.
 *
 * However, JavaScript's new Date() interprets ISO strings as UTC.
 * This utility corrects for that mismatch.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5:30 in milliseconds

/**
 * Format an IST timestamp (stored as naive in PostgreSQL)
 * Corrects for the UTC interpretation issue
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
  // Create date treating string as UTC (how JS interprets it)
  const utcDate = new Date(timestampString);

  // Subtract 5:30 hours to get back to the actual IST time that was stored
  const istDate = new Date(utcDate.getTime() - IST_OFFSET_MS);

  return istDate.toLocaleString("en-IN", options);
}

/**
 * Format just the date part of an IST timestamp
 */
export function formatISTDate(
  timestampString: string,
  options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    year: "numeric",
  }
): string {
  const utcDate = new Date(timestampString);
  const istDate = new Date(utcDate.getTime() - IST_OFFSET_MS);
  return istDate.toLocaleDateString("en-IN", options);
}

/**
 * Format just the time part of an IST timestamp
 */
export function formatISTTime(
  timestampString: string,
  options: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
  }
): string {
  const utcDate = new Date(timestampString);
  const istDate = new Date(utcDate.getTime() - IST_OFFSET_MS);
  return istDate.toLocaleTimeString("en-IN", options);
}
