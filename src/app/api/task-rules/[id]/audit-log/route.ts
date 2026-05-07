/**
 * GET /api/task-rules/{id}/audit-log
 * Returns audit trail for a specific rule
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { getRuleAuditLog } from "@/lib/engine/ruleAudit";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 50), 100);

  const auditLog = await getRuleAuditLog(id, limit);

  return NextResponse.json({
    ruleId: id,
    entries: auditLog.map(entry => ({
      action: entry.action,
      changedBy: entry.changedBy
        ? `${entry.changedBy.name} (${entry.changedBy.email})`
        : "System",
      changesSummary: entry.changesSummary,
      timestamp: entry.createdAt.toISOString(),
      metadata: entry.metadata,
    })),
  });
}
