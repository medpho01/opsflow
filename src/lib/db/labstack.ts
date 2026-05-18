/**
 * Labstack read client.
 *
 * Separate PrismaClient instance pointing at the LABSTACK (source-of-truth)
 * database — `public.Order`, `public.Appointment`, `public.User`, etc.
 * Used only for reads; OpsFlow must never write to labstack.
 *
 * Why two clients:
 *   The taskos schema (where OpsFlow writes Tasks, Alerts, etc.) and the
 *   labstack public schema (where orders/appointments live) can be on
 *   different Postgres instances. We want operators to be able to point
 *   OpsFlow at a labstack DB without colocating the taskos schema there,
 *   and vice-versa. Splitting into two clients does that cleanly.
 *
 * Backward compatibility:
 *   When SOURCE_DATABASE_URL is unset, it falls back to DATABASE_URL.
 *   Existing single-DB deployments work unchanged.
 *
 * Lazy initialization:
 *   The client is created on first use, not at module import. Next.js's
 *   build step evaluates module-level code without the runtime env, so
 *   throwing on missing env at import time would break `next build`.
 *
 * Constraints:
 *   - This client must never be used for $executeRaw* against labstack.
 *     Labstack is the source of truth; OpsFlow only observes it.
 *   - Cross-DB JOINs between taskos.* and public.* will fail when the
 *     two clients point at different physical databases. Use two-step
 *     fetches (query each client separately, merge in JS) when you need
 *     data from both schemas.
 */
import { PrismaClient } from "@prisma/client";

function resolveLabstackUrl(): string {
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

function createLabstackClient(): PrismaClient {
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    datasources: { db: { url: resolveLabstackUrl() } },
  });
}

// Lazy singleton — avoids throwing at module load (Next.js build phase
// evaluates module-level code without runtime env). The first real call
// to a query method materialises the client.
const globalForLabstack = globalThis as unknown as {
  __labstackClient: PrismaClient | undefined;
};

function getLabstackClient(): PrismaClient {
  if (!globalForLabstack.__labstackClient) {
    globalForLabstack.__labstackClient = createLabstackClient();
  }
  return globalForLabstack.__labstackClient;
}

/**
 * Proxy that defers PrismaClient construction until first property access.
 * Lets callers `import labstack from "@/lib/db/labstack"` and use it
 * exactly like the regular `prisma` client, without paying init cost at
 * module load or risking a build-time throw on missing env.
 */
export const labstack = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getLabstackClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

/**
 * Convenience helper — `$queryRawUnsafe` against the labstack DB.
 * Existing call sites in the codebase use this pattern.
 */
export async function labstackQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return labstack.$queryRawUnsafe<T[]>(sql, ...params);
}

export default labstack;
