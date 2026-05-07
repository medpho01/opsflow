/**
 * Task Archiver - Archives old tasks automatically
 * Runs nightly to move 10+ day old tasks out of active view
 * Keeps them for audit trail but ops focus stays on live tasks
 *
 * Archive Criteria:
 * - Task has appointmentTime > 10 days in the past (stored in metadata)
 * - Archived regardless of completion status
 * - Task has not already been archived
 */

import prisma from "@/lib/db/client";

const DAYS_THRESHOLD = 10; // Archive tasks on orders 10+ days old

export async function archiveOldTasks(): Promise<void> {
  console.log("[TaskArchiver] Starting archive cycle");

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - DAYS_THRESHOLD);

  console.log(
    `[TaskArchiver] Archiving tasks on orders with appointment before ${cutoffDate.toISOString()}`
  );

  try {
    // Find all tasks where appointment was 10+ days ago
    // Regardless of completion status
    // AND not already archived
    const cutoffDateStr = cutoffDate.toISOString();
    console.log(`[TaskArchiver] Cutoff date: ${cutoffDateStr}`);

    const result = await prisma.$executeRaw`
      UPDATE taskos."tasks"
      SET "isArchived" = true
      WHERE "isArchived" = false
      AND ("metadata"->>'appointmentTime')::timestamp < ${cutoffDateStr}::timestamp
    `;

    console.log(`[TaskArchiver] Archived ${result} old tasks`);

    // Log archive action for audit trail
    if (result.count > 0) {
      await logArchiveAction(result.count, cutoffDate);
    }
  } catch (err) {
    console.error("[TaskArchiver] Error archiving tasks:", err);
    throw err;
  }
}

async function logArchiveAction(count: number, cutoffDate: Date): Promise<void> {
  // Optional: Create audit log entry
  console.log(
    `[TaskArchiver] ${count} tasks archived - cutoff date: ${cutoffDate.toISOString()}`
  );

  // TODO: If audit logging is implemented, add entry here
  // await prisma.auditLog.create({
  //   data: {
  //     action: 'TASK_ARCHIVE_BATCH',
  //     count: count,
  //     cutoffDate: cutoffDate,
  //     timestamp: new Date()
  //   }
  // });
}

/**
 * Manual unarchive - for ops to restore a specific task if needed
 * @param taskId Task ID to unarchive
 * @returns Updated task
 */
export async function unarchiveTask(taskId: number): Promise<any> {
  console.log(`[TaskArchiver] Unarchiving task ${taskId}`);

  const updated = await prisma.task.update({
    where: { id: taskId },
    data: { isArchived: false }
  });

  console.log(`[TaskArchiver] Task ${taskId} restored to active view`);
  return updated;
}

/**
 * Manual unarchive all tasks for an order - if order needs reopening
 * @param orderId Order ID
 * @returns Count of tasks restored
 */
export async function unarchiveOrderTasks(orderId: number): Promise<number> {
  console.log(`[TaskArchiver] Unarchiving all tasks for order ${orderId}`);

  const result = await prisma.task.updateMany({
    where: { entityId: orderId, isArchived: true },
    data: { isArchived: false }
  });

  console.log(
    `[TaskArchiver] Restored ${result.count} tasks for order ${orderId}`
  );
  return result.count;
}
