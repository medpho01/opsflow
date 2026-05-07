/**
 * Polling Scheduler
 * Handles automatic polling cycles for all active data sources
 * Uses node-cron to run polling at configured intervals
 *
 * Integrates with the PollingEngine to:
 * 1. Fetch entities from each source
 * 2. Match against task rules
 * 3. Create tasks
 * 4. Log results
 */

import cron from "node-cron";
import { getPollingEngine } from "./polling-engine";
import { findMatchingRules } from "@/lib/task-creation/rule-matcher";
import { createTaskFromSourceEntity } from "@/lib/task-creation/create-task-service";
import prisma from "@/lib/db/client";

// Map of source IDs to their cron tasks
const scheduledTasks: Map<string, cron.ScheduledTask> = new Map();

// Lock to prevent concurrent polling of the same source
const pollingLocks: Map<string, boolean> = new Map();

/**
 * Start polling scheduler for a specific source
 * Creates a cron job based on the source's polling interval
 */
export function scheduleSourcePolling(sourceId: string, intervalMinutes: number): cron.ScheduledTask {
  // Convert interval to cron expression
  // For simplicity, we'll use */N * * * * for every N minutes
  // Note: cron only supports minutes >= 1
  const clampedInterval = Math.max(1, intervalMinutes);
  const cronExpression = `*/${clampedInterval} * * * *`;

  console.log(
    `[PollingScheduler] Scheduling polling for source '${sourceId}' with interval ${intervalMinutes}m (cron: '${cronExpression}')`
  );

  const task = cron.schedule(cronExpression, async () => {
    await pollSourceSafely(sourceId);
  });

  scheduledTasks.set(sourceId, task);
  return task;
}

/**
 * Execute a polling cycle for a source with safety checks
 * Prevents concurrent polling and logs results
 */
async function pollSourceSafely(sourceId: string): Promise<void> {
  // Check if already polling this source
  if (pollingLocks.get(sourceId)) {
    console.warn(
      `[PollingScheduler] Polling already in progress for source '${sourceId}', skipping this cycle`
    );
    return;
  }

  // Acquire lock
  pollingLocks.set(sourceId, true);

  try {
    const engine = getPollingEngine();
    const handler = engine.getHandler(sourceId);

    if (!handler) {
      console.error(`[PollingScheduler] No handler registered for source: ${sourceId}`);
      return;
    }

    // Get data source configuration
    const dataSource = await prisma.dataSource.findFirst({
      where: { sourceId, isActive: true },
    });

    if (!dataSource) {
      console.warn(`[PollingScheduler] Data source '${sourceId}' not found or inactive`);
      return;
    }

    console.log(`[PollingScheduler] Starting polling cycle for source: ${sourceId}`);
    const startTime = Date.now();

    // Execute polling cycle
    const result = await engine.pollSource(sourceId, async (entity, sid) => {
      try {
        // Find matching rules for this entity
        const rules = await findMatchingRules(sid, entity);

        if (rules.length === 0) {
          console.debug(
            `[PollingScheduler] No rules match entity ${entity.id} (type: ${entity.type}, status: ${entity.status}) from source ${sid}`
          );
          return null;
        }

        // Create task for the first matching rule
        const rule = rules[0];
        const taskResult = await createTaskFromSourceEntity(
          sid,
          entity,
          rule,
          dataSource.displayName,
          undefined // storeId
        );

        if (taskResult.success) {
          console.log(
            `[PollingScheduler]   ✓ Created task #${taskResult.taskId} from entity ${entity.id}`
          );
          return taskResult.taskId;
        } else {
          console.error(
            `[PollingScheduler]   ✗ Failed to create task for entity ${entity.id}: ${taskResult.error}`
          );
          return null;
        }
      } catch (error) {
        console.error(`[PollingScheduler] Error processing entity ${entity.id}:`, error);
        return null;
      }
    });

    const durationMs = Date.now() - startTime;

    // Log summary
    console.log(`[PollingScheduler] Polling cycle complete for source: ${sourceId}`);
    console.log(
      `[PollingScheduler]   Entities: ${result.entitiesFound}, Tasks created: ${result.tasksCreated}, Failed: ${result.tasksFailed}, Duration: ${durationMs}ms`
    );

    // Log to database
    await prisma.dataSourcePollingLog.create({
      data: {
        dataSourceId: dataSource.id,
        pollStartedAt: new Date(startTime),
        pollCompletedAt: new Date(),
        durationMs,
        entitiesFound: result.entitiesFound,
        entitiesProcessed: result.entitiesProcessed,
        tasksCreated: result.tasksCreated,
        tasksFailed: result.tasksFailed,
        status: result.status,
        details: {
          sourceId,
          taskCreationDetails: [],
        } as any,
      },
    });
  } catch (error) {
    console.error(`[PollingScheduler] Error polling source ${sourceId}:`, error);

    // Log error to database
    try {
      const dataSource = await prisma.dataSource.findFirst({
        where: { sourceId },
      });

      if (dataSource) {
        await prisma.dataSourcePollingLog.create({
          data: {
            dataSourceId: dataSource.id,
            pollStartedAt: new Date(),
            pollCompletedAt: new Date(),
            durationMs: Date.now() - Date.now(),
            status: "ERROR",
            errorMessage: error instanceof Error ? error.message : String(error),
            details: {
              sourceId,
              errorStack: error instanceof Error ? error.stack : undefined,
            } as any,
          },
        });
      }
    } catch (logError) {
      console.error(`[PollingScheduler] Failed to log error for source ${sourceId}:`, logError);
    }
  } finally {
    // Release lock
    pollingLocks.set(sourceId, false);
  }
}

/**
 * Start all polling schedulers for active sources
 * Should be called once at application startup
 */
export async function startPollingSchedulers(): Promise<void> {
  try {
    console.log("[PollingScheduler] Starting polling schedulers for all active sources...");

    const activeSources = await prisma.dataSource.findMany({
      where: { isActive: true },
      select: {
        sourceId: true,
        displayName: true,
        pollingIntervalMinutes: true,
      },
      orderBy: { createdAt: "asc" },
    });

    if (activeSources.length === 0) {
      console.warn("[PollingScheduler] No active sources found");
      return;
    }

    console.log(`[PollingScheduler] Found ${activeSources.length} active source(s)`);

    for (const source of activeSources) {
      try {
        scheduleSourcePolling(source.sourceId, source.pollingIntervalMinutes);
        console.log(
          `[PollingScheduler] ✓ Scheduled polling for: ${source.sourceId} (${source.displayName})`
        );
      } catch (error) {
        console.error(
          `[PollingScheduler] ✗ Failed to schedule polling for ${source.sourceId}:`,
          error
        );
      }
    }

    console.log(`[PollingScheduler] All polling schedulers started successfully`);
  } catch (error) {
    console.error("[PollingScheduler] Error starting polling schedulers:", error);
    throw error;
  }
}

/**
 * Stop polling scheduler for a specific source
 */
export function stopSourcePolling(sourceId: string): void {
  const task = scheduledTasks.get(sourceId);
  if (task) {
    task.stop();
    scheduledTasks.delete(sourceId);
    console.log(`[PollingScheduler] Stopped polling for source: ${sourceId}`);
  }
}

/**
 * Stop all polling schedulers
 */
export function stopAllPollingSchedulers(): void {
  console.log("[PollingScheduler] Stopping all polling schedulers...");
  for (const [sourceId, task] of scheduledTasks.entries()) {
    task.stop();
    console.log(`[PollingScheduler] ✓ Stopped: ${sourceId}`);
  }
  scheduledTasks.clear();
  console.log("[PollingScheduler] All polling schedulers stopped");
}

/**
 * Get status of all scheduled tasks
 */
export function getScheduledTasksStatus(): Array<{
  sourceId: string;
  isRunning: boolean;
}> {
  return Array.from(scheduledTasks.entries()).map(([sourceId, task]) => ({
    sourceId,
    isRunning: !task._destroyed && task.status === 1,
  }));
}

/**
 * Manually trigger polling for a source (useful for admin testing)
 */
export async function triggerManualPolling(sourceId: string): Promise<void> {
  console.log(`[PollingScheduler] Manual polling triggered for source: ${sourceId}`);
  await pollSourceSafely(sourceId);
}
