/**
 * Correlation IDs for API responses.
 *
 * Every error response from the data-sources API (and ideally beyond) should
 * carry a short, unique `requestId`. This lets the client report the exact
 * failure to support, and lets server-side log searches anchor on a single
 * request without grepping timestamps.
 */

import { randomUUID } from "crypto";

/** Short ID — first 8 chars of a UUID v4 — enough entropy for a single day's logs. */
export function newRequestId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Wrap a console error with the request id so the log line is searchable.
 * Returns the structured response body the route should return.
 */
export function logAndBuildErrorBody(args: {
  requestId: string;
  scope: string;          // "DataSourcesAPI.POST", etc.
  code: string;           // machine-readable error code
  userMessage: string;    // shown to the user
  error: unknown;
}): { error: string; code: string; requestId: string; details?: string } {
  const detail = args.error instanceof Error ? args.error.message : String(args.error);
  console.error(`[${args.scope}] [${args.requestId}] ${args.code}: ${detail}`, args.error);
  return {
    error: args.userMessage,
    code: args.code,
    requestId: args.requestId,
    details: detail,
  };
}
