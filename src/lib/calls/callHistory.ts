/**
 * Shared call-history query for the "Call Activity" panel, used by both the
 * task-scoped route (agent drawer) and the entity-scoped routes (head's
 * order/appointment drawer) so the two can't drift on shape.
 */
import prisma from "@/lib/db/client";

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

export function fetchCallsForTask(taskId: number) {
  return prisma.callLog.findMany({
    where: { taskId },
    orderBy: { createdAt: "desc" },
    select: CALL_HISTORY_SELECT,
  });
}

/**
 * Every call tied to this entity across ALL of its tasks (an order/
 * appointment can have zero, one, or several tasks over its life) — plus
 * any call placed directly from this entity's own drawer, which has no
 * single task to attribute to (see CallButton call sites in
 * OrderQuickView/AppointmentQuickView).
 */
export function fetchCallsForEntity(entityType: string, entityId: number) {
  return prisma.callLog.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: "desc" },
    select: CALL_HISTORY_SELECT,
  });
}
