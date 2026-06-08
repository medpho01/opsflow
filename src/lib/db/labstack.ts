/**
 * Labstack read client(s).
 *
 * Separate PrismaClient instances pointing at the LABSTACK (source-of-truth)
 * database — `public.Order`, `public.Appointment`, `public.User`, etc.
 * Used only for reads; OpsFlow must never write to labstack.
 *
 * Two clients with isolated connection pools:
 *
 *   labstack         — for API request handlers (drawers, dashboard,
 *                      store joins). Default 10-conn pool.
 *
 *   labstackWorker   — for the polling engine + retirer + any background
 *                      job. Default 5-conn pool.
 *
 * Why split: an outage in the poller (e.g. queries hanging on a labstack
 * lock storm) used to exhaust the shared pool and take API requests down
 * with it. With isolated pools, the worker can be wedged for hours and
 * the API still has its full 10 slots to serve users. See the June 2026
 * MultiXactSLRU incident for the original motivation.
 *
 * Connection limits are encoded by appending `?connection_limit=N` to the
 * resolved URL. If SOURCE_DATABASE_URL already has a `connection_limit`
 * we override it (the env value applies to the original single-pool
 * world; we now want per-pool caps). Other query params (pool_timeout,
 * sslmode, schema, etc.) are preserved.
 *
 * Backward compatibility:
 *   When SOURCE_DATABASE_URL is unset, both clients fall back to
 *   DATABASE_URL. Existing single-DB deployments work unchanged.
 *
 * Lazy initialization:
 *   Clients are created on first use, not at module import. Next.js's
 *   build step evaluates module-level code without the runtime env, so
 *   throwing on missing env at import time would break `next build`.
 *
 * Constraints:
 *   - These clients must never be used for $executeRaw* against labstack.
 *     Labstack is the source of truth; OpsFlow only observes it.
 *   - Cross-DB JOINs between taskos.* and public.* will fail when the
 *     two clients point at different physical databases. Use two-step
 *     fetches (query each client separately, merge in JS) when you need
 *     data from both schemas.
 */
import { PrismaClient } from "@prisma/client";

const API_POOL_LIMIT = parseInt(process.env.LABSTACK_API_POOL ?? "10", 10);
const WORKER_POOL_LIMIT = parseInt(process.env.LABSTACK_WORKER_POOL ?? "5", 10);
const DEFAULT_POOL_TIMEOUT_S = parseInt(process.env.LABSTACK_POOL_TIMEOUT_S ?? "20", 10);
const DEFAULT_QUERY_TIMEOUT_MS = parseInt(process.env.LABSTACK_QUERY_TIMEOUT_MS ?? "5000", 10);

function resolveLabstackBaseUrl(): string {
  const explicit = process.env.SOURCE_DATABASE_URL;
  if (explicit && explicit.length > 0) return explicit;

  const fallback = process.env.DATABASE_URL;
  if (!fallback) {
    throw new Error(
      "Neither SOURCE_DATABASE_URL nor DATABASE_URL is set. " +
      "Set SOURCE_DATABASE_URL when the labstack source DB is separate " +
      "from the taskos DB, or set DATABASE_URL to a single shared DB."
    );
  }
  return fallback;
}

/**
 * Apply per-pool overrides on top of the resolved base URL. Strips any
 * existing `connection_limit` so the caller-supplied N wins. Preserves
 * all other query params.
 */
function urlWithPool(baseUrl: string, connLimit: number): string {
  try {
    const u = new URL(baseUrl);
    u.searchParams.delete("connection_limit");
    u.searchParams.set("connection_limit", String(connLimit));
    // Add a generous pool_timeout if none set, so a brief spike doesn't
    // immediately throw P2024.
    if (!u.searchParams.has("pool_timeout")) {
      u.searchParams.set("pool_timeout", String(DEFAULT_POOL_TIMEOUT_S));
    }
    return u.toString();
  } catch {
    // URL parsing failed (e.g. malformed env). Best-effort append.
    const sep = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${sep}connection_limit=${connLimit}&pool_timeout=${DEFAULT_POOL_TIMEOUT_S}`;
  }
}

function createClient(connLimit: number): PrismaClient {
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    datasources: { db: { url: urlWithPool(resolveLabstackBaseUrl(), connLimit) } },
  });
}

// Lazy singletons — both clients defer construction until first use.
const globalForLabstack = globalThis as unknown as {
  __labstackApiClient: PrismaClient | undefined;
  __labstackWorkerClient: PrismaClient | undefined;
};

function getApiClient(): PrismaClient {
  if (!globalForLabstack.__labstackApiClient) {
    globalForLabstack.__labstackApiClient = createClient(API_POOL_LIMIT);
  }
  return globalForLabstack.__labstackApiClient;
}

function getWorkerClient(): PrismaClient {
  if (!globalForLabstack.__labstackWorkerClient) {
    globalForLabstack.__labstackWorkerClient = createClient(WORKER_POOL_LIMIT);
  }
  return globalForLabstack.__labstackWorkerClient;
}

/**
 * Proxy factory — defers PrismaClient construction until first property
 * access. Lets callers `import labstack from "@/lib/db/labstack"` and use
 * it exactly like the regular `prisma` client, without paying init cost
 * at module load or risking a build-time throw on missing env.
 */
function makeProxy(resolver: () => PrismaClient): PrismaClient {
  return new Proxy({} as PrismaClient, {
    get(_target, prop, receiver) {
      const client = resolver();
      const value = Reflect.get(client, prop, receiver);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });
}

/** API-side client — for request handlers, drawers, dashboards. */
export const labstack = makeProxy(getApiClient);

/** Worker-side client — for polling engine, retirer, background jobs. */
export const labstackWorker = makeProxy(getWorkerClient);

/**
 * Convenience helper — `$queryRawUnsafe` against the labstack API client.
 * Existing call sites in the codebase use this pattern. Worker code that
 * wants the raw helper should call labstackWorker.$queryRawUnsafe directly.
 */
export async function labstackQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return labstack.$queryRawUnsafe<T[]>(sql, ...params);
}

/**
 * Worker-side counterpart to labstackQuery. Use from the polling engine
 * and any background job so worker queries don't compete with API
 * requests for the same pool slots.
 */
export async function labstackWorkerQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return labstackWorker.$queryRawUnsafe<T[]>(sql, ...params);
}

// ── Circuit breaker ───────────────────────────────────────────────────
//
// After N failures (timeout OR rejection) within WINDOW, the breaker
// trips and every subsequent labstackOr call returns its fallback
// immediately for OPEN_DURATION — no further labstack traffic.
//
// Why: during the June 2026 SLRU storm, every dashboard request
// continued retrying labstack and piling new doomed queries onto the
// already-stuck table. A breaker would have noticed after 5 timeouts
// and stopped contributing load until labstack recovered.
//
// Tunables (env-overridable for ops control during incidents):
//   LABSTACK_BREAKER_FAILURE_THRESHOLD   default 5
//   LABSTACK_BREAKER_WINDOW_MS           default 30_000
//   LABSTACK_BREAKER_OPEN_DURATION_MS    default 30_000
//
// One breaker per pool name ("api" / "worker") so an API breaker doesn't
// disable the poller and vice versa.
const BREAKER_FAILURE_THRESHOLD = parseInt(
  process.env.LABSTACK_BREAKER_FAILURE_THRESHOLD ?? "5", 10,
);
const BREAKER_WINDOW_MS = parseInt(
  process.env.LABSTACK_BREAKER_WINDOW_MS ?? "30000", 10,
);
const BREAKER_OPEN_DURATION_MS = parseInt(
  process.env.LABSTACK_BREAKER_OPEN_DURATION_MS ?? "30000", 10,
);

interface BreakerState {
  failures: number[];      // ms epoch timestamps of recent failures
  trippedUntil: number;    // ms epoch; 0 = closed
}
const breakers = new Map<string, BreakerState>();

function getBreaker(key: string): BreakerState {
  let s = breakers.get(key);
  if (!s) {
    s = { failures: [], trippedUntil: 0 };
    breakers.set(key, s);
  }
  return s;
}

function isBreakerOpen(key: string): boolean {
  const s = breakers.get(key);
  if (!s || s.trippedUntil === 0) return false;
  if (Date.now() >= s.trippedUntil) {
    // Half-open: clear trip, allow next call to test recovery. If it
    // fails the failure counter trips again immediately.
    s.trippedUntil = 0;
    s.failures = [];
    return false;
  }
  return true;
}

function recordFailure(key: string): void {
  const now = Date.now();
  const s = getBreaker(key);
  s.failures = s.failures.filter((t) => now - t < BREAKER_WINDOW_MS);
  s.failures.push(now);
  if (s.failures.length >= BREAKER_FAILURE_THRESHOLD && s.trippedUntil === 0) {
    s.trippedUntil = now + BREAKER_OPEN_DURATION_MS;
    s.failures = [];
    console.warn(
      `[labstack] circuit breaker '${key}' tripped — skipping labstack for ${BREAKER_OPEN_DURATION_MS / 1000}s`,
    );
  }
}

function recordSuccess(key: string): void {
  const s = breakers.get(key);
  if (!s) return;
  // A successful call clears the failure window — recovery is fast
  // once labstack is healthy.
  if (s.failures.length > 0) s.failures = [];
}

/** Expose breaker state for /api/health-style probes. */
export function getLabstackBreakerState(): Record<string, { open: boolean; reopensInMs: number; recentFailures: number }> {
  const out: Record<string, { open: boolean; reopensInMs: number; recentFailures: number }> = {};
  const now = Date.now();
  for (const [key, s] of breakers) {
    out[key] = {
      open: s.trippedUntil > now,
      reopensInMs: Math.max(0, s.trippedUntil - now),
      recentFailures: s.failures.filter((t) => now - t < BREAKER_WINDOW_MS).length,
    };
  }
  return out;
}

/**
 * Race a labstack query against a timeout AND a circuit breaker.
 * Returns the fallback when:
 *   - the breaker is open for this pool (no actual labstack call made)
 *   - the query doesn't complete within `ms` (default 5000)
 *   - the query rejects with any error
 *
 * Use at every labstack call site in API routes — when labstack is slow,
 * stuck, or unreachable, the request degrades gracefully instead of
 * pinning a connection slot and cascading into pool exhaustion. The
 * original promise keeps running in the background and eventually
 * settles; we just stop waiting for it.
 *
 * The breaker key defaults to "api". Worker-pool callers should pass
 * { breakerKey: "worker" } so an API failure storm doesn't disable the
 * poller (and vice versa).
 *
 * Example:
 *   const order = await labstackOr(
 *     labstack.$queryRaw`SELECT * FROM ...`,
 *     null,
 *   );
 *   if (!order) return NextResponse.json({ error: "labstack unavailable" }, { status: 503 });
 */
export async function labstackOr<T>(
  promise: Promise<T>,
  fallback: T,
  ms: number = DEFAULT_QUERY_TIMEOUT_MS,
  opts: { breakerKey?: string } = {},
): Promise<T> {
  const breakerKey = opts.breakerKey ?? "api";

  if (isBreakerOpen(breakerKey)) {
    // Don't even start the call. The promise the caller passed has
    // already been created (we can't stop that), but we drop our wait
    // immediately and let it settle into the void.
    promise.catch(() => {}); // suppress unhandled-rejection warnings
    return fallback;
  }

  const TIMEOUT = Symbol("labstack-timeout");
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });

  try {
    const result = await Promise.race([promise, timeout]);
    if (result === TIMEOUT) {
      recordFailure(breakerKey);
      // Original promise still running — swallow whatever it eventually does.
      promise.catch(() => {});
      return fallback;
    }
    recordSuccess(breakerKey);
    return result as T;
  } catch {
    recordFailure(breakerKey);
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default labstack;
