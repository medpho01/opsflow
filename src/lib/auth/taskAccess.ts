/**
 * Shared task-level access check, used by every route that reads or acts on
 * a single task (GET/PATCH /api/tasks/:id, /api/tasks/:id/calls, ...).
 * Centralised so they can't drift on the role-scoping rule (audit P0 #4 —
 * PATCH previously only checked OPS_AGENT-not-own and let STORE_ADMINs touch
 * any task).
 */
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

async function getAdminStoreIds(userId: number): Promise<number[]> {
  const member = await prisma.teamMember.findFirst({
    where: { userId },
    include: { storeAssignments: { select: { storeId: true } } },
  });
  return member?.storeAssignments.map((a) => a.storeId) ?? [];
}

/** Returns true iff the user is allowed to read/write this task. */
export async function canAccessTask(
  user: { id: number; role: UserRole },
  task: { assignedToId: number | null; storeId: number | null }
): Promise<boolean> {
  if (user.role === UserRole.OPS_HEAD) return true;
  if (user.role === UserRole.OPS_AGENT) return task.assignedToId === user.id;
  // STORE_ADMIN: must own the task's store
  if (task.storeId == null) return false;
  const storeIds = await getAdminStoreIds(user.id);
  return storeIds.includes(task.storeId);
}
