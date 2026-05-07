/**
 * Sync Service
 * Handles syncing task status changes back to source systems
 * Supports: API webhooks, database updates, custom strategies
 */

import prisma from "@/lib/db/client";
import { getPollingEngine } from "./polling-engine";
import { SourceSyncStrategy } from "@prisma/client";

export interface SyncResult {
  taskId: number;
  sourceEntityId: number | string;
  success: boolean;
  strategy: string;
  syncedAt?: Date;
  error?: string;
  retryCount?: number;
}

/**
 * Sync task status to source
 * Gets handler and calls syncTaskStatusToSource method
 */
export async function syncTaskStatusToSource(
  taskId: number
): Promise<SyncResult> {
  try {
    // Get task
    const task = await prisma.task.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      return {
        taskId,
        sourceEntityId: 0,
        success: false,
        strategy: "UNKNOWN",
        error: "Task not found",
      };
    }

    if (!task.source || !task.sourceEntityId) {
      console.warn(
        `[SyncService] Task ${taskId} has no source information - skipping sync`
      );
      return {
        taskId,
        sourceEntityId: 0,
        success: false,
        strategy: "NONE",
        error: "No source information",
      };
    }

    // Get data source configuration
    const dataSource = await prisma.dataSource.findUnique({
      where: { sourceId: task.source },
    });

    if (!dataSource) {
      return {
        taskId,
        sourceEntityId: task.sourceEntityId,
        success: false,
        strategy: "UNKNOWN",
        error: `Source not found: ${task.source}`,
      };
    }

    // Get source handler
    const engine = getPollingEngine();
    const handler = engine.getHandler(task.source);

    if (!handler) {
      return {
        taskId,
        sourceEntityId: task.sourceEntityId,
        success: false,
        strategy: dataSource.syncStrategy,
        error: `Handler not registered for source: ${task.source}`,
      };
    }

    // Sync based on strategy
    await handler.syncTaskStatusToSource(
      taskId,
      task.sourceEntityId,
      task.status,
      task.sourceHandlerContext || {}
    );

    // Update task sync timestamp
    await prisma.task.update({
      where: { id: taskId },
      data: { sourceLastSyncedAt: new Date() },
    });

    console.log(
      `[SyncService] ✓ Synced task #${taskId} status (${task.status}) to source ${task.source}`
    );

    return {
      taskId,
      sourceEntityId: task.sourceEntityId,
      success: true,
      strategy: dataSource.syncStrategy,
      syncedAt: new Date(),
    };
  } catch (error) {
    console.error(`[SyncService] Error syncing task ${taskId}:`, error);

    return {
      taskId,
      sourceEntityId: 0,
      success: false,
      strategy: "ERROR",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Sync multiple tasks
 */
export async function syncMultipleTasksToSource(
  taskIds: number[]
): Promise<SyncResult[]> {
  const results = await Promise.all(
    taskIds.map((id) => syncTaskStatusToSource(id))
  );

  return results;
}

/**
 * Sync all tasks for a specific source
 * Useful for periodic sync operations
 */
export async function syncSourceTasks(sourceId: string): Promise<SyncResult[]> {
  console.log(`[SyncService] Syncing all tasks for source: ${sourceId}`);

  try {
    // Get all tasks for this source that haven't been synced recently
    const tasksToSync = await prisma.task.findMany({
      where: {
        source: sourceId,
        status: { notIn: ["CREATED"] }, // Don't sync newly created tasks
        OR: [
          { sourceLastSyncedAt: null }, // Never synced
          {
            sourceLastSyncedAt: {
              lt: new Date(Date.now() - 5 * 60 * 1000), // Not synced in last 5 minutes
            },
          },
        ],
      },
      select: { id: true },
      take: 100, // Limit to prevent overwhelming sync
    });

    console.log(
      `[SyncService] Found ${tasksToSync.length} tasks to sync for ${sourceId}`
    );

    const results = await syncMultipleTasksToSource(
      tasksToSync.map((t) => t.id)
    );

    const successCount = results.filter((r) => r.success).length;
    console.log(
      `[SyncService] Sync complete for ${sourceId}: ${successCount}/${results.length} successful`
    );

    return results;
  } catch (error) {
    console.error(`[SyncService] Error syncing source ${sourceId}:`, error);
    return [];
  }
}

/**
 * Sync tasks when status changes
 * Hook this into task status update logic
 */
export async function onTaskStatusChanged(taskId: number): Promise<void> {
  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { source: true, status: true },
    });

    if (!task || !task.source) {
      return;
    }

    // Skip sync for newly created tasks
    if (task.status === "CREATED") {
      return;
    }

    // Attempt sync (async, don't block)
    syncTaskStatusToSource(taskId).catch((error) => {
      console.error(`[SyncService] Background sync failed for task ${taskId}:`, error);
      // Could add to retry queue here
    });
  } catch (error) {
    console.error(`[SyncService] Error processing status change for task ${taskId}:`, error);
  }
}

/**
 * Get sync status for a task
 */
export async function getTaskSyncStatus(taskId: number) {
  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        source: true,
        sourceEntityId: true,
        sourceLastSyncedAt: true,
        status: true,
      },
    });

    if (!task) {
      return null;
    }

    const dataSource = task.source
      ? await prisma.dataSource.findUnique({
          where: { sourceId: task.source },
          select: { syncStrategy: true },
        })
      : null;

    return {
      taskId: task.id,
      source: task.source,
      sourceEntityId: task.sourceEntityId,
      status: task.status,
      lastSyncedAt: task.sourceLastSyncedAt,
      syncStrategy: dataSource?.syncStrategy || "NONE",
      needsSync:
        !task.sourceLastSyncedAt ||
        (task.sourceLastSyncedAt &&
          Date.now() - task.sourceLastSyncedAt.getTime() > 5 * 60 * 1000),
    };
  } catch (error) {
    console.error(`[SyncService] Error getting sync status for task ${taskId}:`, error);
    return null;
  }
}

/**
 * Initialize sync watchers
 * Called at startup to watch for task status changes
 * Note: In production, use database triggers or event bus for this
 */
export function initializeSyncWatchers(): void {
  console.log("[SyncService] Sync watchers initialized");

  // In a real system, you'd:
  // 1. Listen for task status change events
  // 2. Subscribe to task update webhook
  // 3. Use database triggers (PostgreSQL LISTEN/NOTIFY)
  // 4. Use an event bus (Redis, Kafka, etc.)

  // For now, this is a placeholder that can be enhanced
}
