/**
 * In-memory rate limiter. Per-key sliding-window counter, suitable for the
 * "don't let one OPS_HEAD reset 50 passwords in 30 seconds" use case.
 *
 * Deliberately not a Redis token bucket — this is a single-process Next.js
 * dev/prod deploy; one Map keyed by `<scope>:<key>` is enough. If we move
 * to multi-instance hosting, swap this for the same interface backed by
 * Redis (or @vercel/kv) without changing call sites.
 *
 * Usage:
 *
 *   if (!rateLimit("password-reset", String(targetUserId), 5, 60_000)) {
 *     return NextResponse.json({ error: "Too many resets — try later" }, { status: 429 });
 *   }
 *
 * That allows 5 calls per 60s for that target user; the 6th returns false.
 */

interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>();

export function rateLimit(
  scope: string,
  key: string,
  maxRequests: number,
  windowMs: number
): boolean {
  const bucketKey = `${scope}:${key}`;
  const now = Date.now();
  const existing = buckets.get(bucketKey);

  if (!existing || existing.resetAt <= now) {
    buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (existing.count >= maxRequests) {
    return false;
  }
  existing.count++;
  return true;
}

/**
 * Test/admin helper — clear all buckets. Not exported from index; only
 * import directly from this file in the rare case you need it (test tear-
 * downs, manual reset tooling).
 */
export function clearRateLimitBuckets() {
  buckets.clear();
}
