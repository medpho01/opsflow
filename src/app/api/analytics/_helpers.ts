/**
 * Shared helpers for /api/analytics/* routes.
 *
 * Centralised here because the audit (feature 07) flagged inconsistent
 * date handling across `agents/route.ts` and `summary/route.ts` — one
 * file used `setHours(0,0,0,0)` (server-local), the other used
 * `Date.UTC(...)` and a third path mixed both. With the JS server in
 * UTC and the DB session in IST, those produced midnights 5h30m apart
 * and "today" silently meant different things across the same product.
 *
 * Single helper, IST-anchored, used by every analytics route.
 */

/**
 * Anchor "today" to midnight in IST. Returns the corresponding UTC
 * instant so Prisma's bindings compare correctly against stored
 * timestamps. Same pattern as /api/dashboard.
 */
export function startOfTodayIST(): Date {
  const istDateKey = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return new Date(`${istDateKey}T00:00:00+05:30`);
}

/**
 * Resolve the start-of-range for analytics endpoints. Three buckets
 * matching the agents-panel selector:
 *
 *   today  — IST midnight today
 *   week   — IST midnight 7 days ago (rolling 7d window incl. today)
 *   month  — IST midnight 30 days ago (rolling 30d window incl. today)
 */
export function getRangeStart(range: string): Date {
  const today = startOfTodayIST();
  if (range === "week")  return new Date(today.getTime() - 6  * 24 * 60 * 60 * 1000);
  if (range === "month") return new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000);
  return today;
}

/**
 * Parse a YYYY-MM-DD string into the IST-midnight Date that begins it.
 * Returns null on any invalid input — bad regex match, NaN Date, or out
 * of plausible range. The audit (feature 07) flagged that the previous
 * regex check let "9999-99-99" through to a downstream Invalid Date.
 */
export function parseDateOrNull(dateParam: string | null): Date | null {
  if (!dateParam) return null;
  const m = dateParam.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const candidate = new Date(`${y}-${mo}-${d}T00:00:00+05:30`);
  if (isNaN(candidate.getTime())) return null;
  // Sanity: year should be reasonable (not 9999-99-99 → garbage).
  const yr = Number(y);
  if (yr < 2000 || yr > 2100) return null;
  return candidate;
}
