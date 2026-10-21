/** Shared bits for the Agents API routes: the role check and the error body. */
import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";
import type { AuthUser } from "@/types";

export type Handler = (request: NextRequest, ctx: { user: AuthUser; requestId: string; params: Record<string, string> }) => Promise<NextResponse>;

/** OPS_HEAD may do everything; OPS_AGENT may read and work the inbox; `headOnly` restricts a route to OPS_HEAD. */
export function agentsRoute(scope: string, handler: Handler, opts: { headOnly?: boolean } = {}) {
  return async (request: NextRequest, context: { params: Promise<Record<string, string>> }) => {
    const requestId = newRequestId();
    try {
      const user = await getSessionFromRequest(request);
      const allowed = user && (user.role === UserRole.OPS_HEAD || (!opts.headOnly && user.role === UserRole.OPS_AGENT));
      if (!allowed) return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
      const params = (await context?.params) ?? {};
      return await handler(request, { user: user!, requestId, params });
    } catch (error) {
      return NextResponse.json(logAndBuildErrorBody({ requestId, scope: `AgentsAPI.${scope}`, code: "AGENTS_FAILED", userMessage: "Something went wrong", error }), { status: 500 });
    }
  };
}

export const bad = (requestId: string, message: string, status = 400) => NextResponse.json({ error: message, code: "BAD_REQUEST", requestId }, { status });
export const tz = () => process.env.TIMEZONE || "Asia/Kolkata";
