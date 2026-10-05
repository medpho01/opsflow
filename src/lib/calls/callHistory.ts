/**
 * Shared call-history query for the "Call Activity" panel, used by both the
 * task-scoped route (agent drawer) and the entity-scoped routes (head's
 * order/appointment drawer) so the two can't drift on shape.
 *
 * Call history includes recordings and transcripts — patients' voices and
 * personal details — so the entity-scoped routes must apply the same access
 * rule as the task-scoped one (see canAccessEntityCalls), not just "logged in".
 */
import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { canAccessTask } from "@/lib/auth/taskAccess";

export const CALL_HISTORY_SELECT = {
  id: true,
  status: true,
  targetMobile: true,
  targetUserName: true,
  triggeredFrom: true,
  recordingUrl: true,
  durationSec: true,
  transcript: true,
  createdAt: true,
  user: { select: { id: true, name: true } },
} as const;

/**
 * Entity types are task.entityType values ("ORDER", "APPOINTMENT", or a newer
 * data source's type). Validated by shape rather than a fixed list so a new
 * source works without a code change, while arbitrary client text is refused.
 */
export function normalizeEntityType(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{1,39}$/.test(value) ? value : null;
}

export function fetchCallsForTask(taskId: number) {
  return prisma.callLog.findMany({
    where: { taskId },
    orderBy: { createdAt: "desc" },
    select: CALL_HISTORY_SELECT,
  });
}

function tasksForEntity(entityType: string, entityId: number) {
  return prisma.task.findMany({
    where: { entityType, entityId },
    select: { id: true, assignedToId: true, storeId: true },
  });
}

/**
 * May this user read call history (recordings, transcripts) for an entity?
 * Ops heads/admins: yes. Anyone else: only if the existing task rule lets them
 * see at least one task on that entity (an agent assigned to it, a store admin
 * who owns its store). An entity with no tasks is heads-only.
 */
export async function canAccessEntityCalls(
  user: { id: number; role: UserRole },
  entityType: string,
  entityId: number,
): Promise<boolean> {
  if (user.role === UserRole.OPS_HEAD || user.role === UserRole.OPS_ADMIN) return true;
  for (const task of await tasksForEntity(entityType, entityId)) {
    if (await canAccessTask(user, task)) return true;
  }
  return false;
}

/**
 * Every call tied to this entity: calls placed from its own drawer (tagged
 * with entityType/entityId) AND calls placed from any of its tasks' drawers
 * (tagged with taskId). The taskId arm is what surfaces calls made before
 * entityType/entityId existed, and any call site that doesn't pass them.
 */
export async function fetchCallsForEntity(entityType: string, entityId: number) {
  const taskIds = (await tasksForEntity(entityType, entityId)).map((task) => task.id);
  return prisma.callLog.findMany({
    where: {
      OR: [
        { entityType, entityId },
        ...(taskIds.length > 0 ? [{ taskId: { in: taskIds } }] : []),
      ],
    },
    orderBy: { createdAt: "desc" },
    select: CALL_HISTORY_SELECT,
  });
}

/** Shared GET handler for /api/orders/:id/calls and /api/appointments/:id/calls. */
export async function entityCallsResponse(request: NextRequest, rawEntityType: unknown, rawId: string) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const entityType = normalizeEntityType(rawEntityType);
  const entityId = parseInt(rawId, 10);
  if (!entityType || !Number.isInteger(entityId) || entityId <= 0) {
    return NextResponse.json({ error: "Invalid entity" }, { status: 400 });
  }

  if (!(await canAccessEntityCalls(user, entityType, entityId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({ calls: await fetchCallsForEntity(entityType, entityId) });
}
