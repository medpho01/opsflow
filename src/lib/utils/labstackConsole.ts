/**
 * Deep-link generator for the LabStack console — jumps from an OpsFlow task
 * drawer straight to the entity's own record in the source-of-truth system,
 * instead of only showing OpsFlow's read-only copy of it.
 *
 * URL shape: {NEXT_PUBLIC_LABSTACK_CONSOLE_URL}/dashboard/{plural}/{entityId}
 *   e.g. https://console.labstack.in/dashboard/appointments/70217
 *
 * Deliberately generic — one small path map, not one implementation per
 * entity type — so wiring up a new source (Requests, Escalations, …) later
 * is a one-line addition here, not a new component.
 */

const ENTITY_PATH: Record<string, string> = {
  ORDER: "orders",
  APPOINTMENT: "appointments",
  REQUEST: "requests",
};

/**
 * Returns the console URL for an entity, or null if either the console base
 * URL isn't configured (NEXT_PUBLIC_LABSTACK_CONSOLE_URL blank) or the
 * entity type has no known console path yet — callers should hide the link
 * in either case rather than render a dead one.
 */
export function labstackConsoleUrl(entityType: string, entityId: number): string | null {
  // Next.js inlines NEXT_PUBLIC_ vars at build time, and this repo's
  // Dockerfile doesn't pass them through as build args (same situation as
  // NEXT_PUBLIC_EXOTEL_API_BASE_URL) — so .env alone never reaches a Docker
  // build. Falling back to the real default keeps the link working out of
  // the box; the env var still wins if a future build pipeline wires it up.
  const base = process.env.NEXT_PUBLIC_LABSTACK_CONSOLE_URL || "https://console.labstack.in";
  if (!base) return null;

  const segment = ENTITY_PATH[entityType.toUpperCase()];
  if (!segment) return null;

  return `${base.replace(/\/+$/, "")}/dashboard/${segment}/${entityId}`;
}
