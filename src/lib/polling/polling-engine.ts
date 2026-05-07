/**
 * Polling Engine
 * Orchestrates multi-source polling cycles
 * Manages registered source handlers and coordinates task creation from multiple sources
 */

import prisma from "@/lib/db/client";
import {
  ISourceHandler,
  PollingConfig,
  PollingCycleResult,
  SourceEntity,
} from "@/types/multi-source";

export class PollingEngine {
  private handlers: Map<string, ISourceHandler> = new Map();
  private pollingConfigs: Map<string, PollingConfig> = new Map();
  private isPolling = false;

  /**
   * Register a source handler
   */
  registerHandler(sourceId: string, handler: ISourceHandler): void {
    this.handlers.set(sourceId, handler);
    console.log(`[PollingEngine] Registered handler for source: ${sourceId}`);
  }

  /**
   * Get a registered handler
   */
  getHandler(sourceId: string): ISourceHandler | undefined {
    return this.handlers.get(sourceId);
  }

  /**
   * Configure polling for a source
   */
  async configureSource(config: PollingConfig): Promise<void> {
    this.pollingConfigs.set(config.sourceId, config);
    console.log(
      `[PollingEngine] Configured source: ${config.sourceId} with interval: ${config.intervalMinutes}m`
    );
  }

  /**
   * Get all registered sources
   */
  getAllSources(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Get all active sources
   */
  getActiveSources(): string[] {
    return Array.from(this.pollingConfigs.values())
      .filter((config) => config.isActive)
      .map((config) => config.sourceId);
  }

  /**
   * Execute a single polling cycle for a specific source
   * Fetches entities and creates tasks
   */
  async pollSource(
    sourceId: string,
    taskCreationFn: (entity: SourceEntity, sourceId: string) => Promise<number | null>
  ): Promise<PollingCycleResult> {
    const startTime = Date.now();
    const handler = this.handlers.get(sourceId);

    if (!handler) {
      return {
        sourceId,
        status: "ERROR",
        entitiesFound: 0,
        entitiesProcessed: 0,
        tasksCreated: 0,
        tasksFailed: 0,
        durationMs: 0,
        errorMessage: `Handler not registered for source: ${sourceId}`,
      };
    }

    try {
      // Get the last polling time for this source
      const lastPoll = await prisma.dataSourcePollingLog.findFirst({
        where: {
          dataSourceId: sourceId,
          status: "SUCCESS",
        },
        orderBy: {
          pollCompletedAt: "desc",
        },
      });

      // Default to 24 hours ago if no successful poll
      const since = lastPoll?.pollCompletedAt
        ? new Date(lastPoll.pollCompletedAt)
        : new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Fetch entities from source
      const entities = await handler.fetchEntitiesNeedingTasks(since, 100);

      let tasksCreated = 0;
      let tasksFailed = 0;

      // Process each entity and create tasks
      for (const entity of entities) {
        try {
          const taskId = await taskCreationFn(entity, sourceId);
          if (taskId) {
            tasksCreated++;
          }
        } catch (error) {
          tasksFailed++;
          console.error(
            `[PollingEngine] Failed to create task for entity ${entity.id} from source ${sourceId}:`,
            error
          );
        }
      }

      const durationMs = Date.now() - startTime;

      // Log the polling cycle
      await prisma.dataSourcePollingLog.create({
        data: {
          dataSourceId: sourceId,
          pollStartedAt: new Date(startTime),
          pollCompletedAt: new Date(),
          durationMs,
          entitiesFound: entities.length,
          entitiesProcessed: entities.length,
          tasksCreated,
          tasksFailed,
          status: tasksFailed > 0 && tasksCreated === 0 ? "PARTIAL" : "SUCCESS",
          details: {
            entityIds: entities.map((e) => e.id),
            failureCount: tasksFailed,
          } as any,
        },
      });

      return {
        sourceId,
        status: tasksFailed > 0 && tasksCreated === 0 ? "PARTIAL" : "SUCCESS",
        entitiesFound: entities.length,
        entitiesProcessed: entities.length,
        tasksCreated,
        tasksFailed,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      // Log the failed polling cycle
      await prisma.dataSourcePollingLog.create({
        data: {
          dataSourceId: sourceId,
          pollStartedAt: new Date(startTime),
          pollCompletedAt: new Date(),
          durationMs,
          status: "ERROR",
          errorMessage,
          entitiesFound: 0,
          entitiesProcessed: 0,
          tasksCreated: 0,
          tasksFailed: 0,
        },
      });

      console.error(
        `[PollingEngine] Error polling source ${sourceId}:`,
        error
      );

      return {
        sourceId,
        status: "ERROR",
        entitiesFound: 0,
        entitiesProcessed: 0,
        tasksCreated: 0,
        tasksFailed: 0,
        durationMs,
        errorMessage,
      };
    }
  }

  /**
   * Execute polling cycles for all active sources
   * Runs in parallel for efficiency
   */
  async pollAllActiveSources(
    taskCreationFn: (entity: SourceEntity, sourceId: string) => Promise<number | null>
  ): Promise<PollingCycleResult[]> {
    if (this.isPolling) {
      console.warn("[PollingEngine] Polling already in progress, skipping");
      return [];
    }

    this.isPolling = true;

    try {
      const activeSources = this.getActiveSources();

      if (activeSources.length === 0) {
        console.log("[PollingEngine] No active sources to poll");
        return [];
      }

      console.log(
        `[PollingEngine] Starting polling cycle for ${activeSources.length} sources`
      );

      // Poll all sources in parallel
      const results = await Promise.all(
        activeSources.map((sourceId) => this.pollSource(sourceId, taskCreationFn))
      );

      const successCount = results.filter((r) => r.status === "SUCCESS").length;
      const totalEntities = results.reduce((sum, r) => sum + r.entitiesFound, 0);
      const totalTasks = results.reduce((sum, r) => sum + r.tasksCreated, 0);

      console.log(
        `[PollingEngine] Polling cycle completed: ${successCount}/${activeSources.length} successful, ${totalEntities} entities, ${totalTasks} tasks created`
      );

      return results;
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Validate all registered sources
   */
  async validateAllSources(): Promise<
    Array<{ sourceId: string; ok: boolean; message: string }>
  > {
    const results = [];

    for (const [sourceId, handler] of this.handlers) {
      try {
        const validation = await handler.validateConnection();
        results.push({
          sourceId,
          ok: validation.ok,
          message: validation.message,
        });
      } catch (error) {
        results.push({
          sourceId,
          ok: false,
          message:
            error instanceof Error ? error.message : "Validation failed",
        });
      }
    }

    return results;
  }

  /**
   * Get polling status for all sources
   */
  async getPollingStatus(): Promise<
    Array<{
      sourceId: string;
      handler: ISourceHandler;
      config?: PollingConfig;
      lastPollResult?: PollingCycleResult;
    }>
  > {
    const status = [];

    for (const [sourceId, handler] of this.handlers) {
      const config = this.pollingConfigs.get(sourceId);
      const lastLog = await prisma.dataSourcePollingLog.findFirst({
        where: { dataSourceId: sourceId },
        orderBy: { pollCompletedAt: "desc" },
      });

      status.push({
        sourceId,
        handler,
        config,
        lastPollResult: lastLog
          ? {
              sourceId,
              status: lastLog.status as
                | "SUCCESS"
                | "ERROR"
                | "PARTIAL",
              entitiesFound: lastLog.entitiesFound,
              entitiesProcessed: lastLog.entitiesProcessed,
              tasksCreated: lastLog.tasksCreated,
              tasksFailed: lastLog.tasksFailed,
              durationMs: lastLog.durationMs || 0,
              errorMessage: lastLog.errorMessage || undefined,
            }
          : undefined,
      });
    }

    return status;
  }

  /**
   * Clear all registered handlers and configs (for testing/reset)
   */
  clear(): void {
    this.handlers.clear();
    this.pollingConfigs.clear();
    console.log("[PollingEngine] Cleared all handlers and configs");
  }
}

/**
 * Global polling engine instance
 */
let globalPollingEngine: PollingEngine | null = null;

/**
 * Get or create the global polling engine instance
 */
export function getPollingEngine(): PollingEngine {
  if (!globalPollingEngine) {
    globalPollingEngine = new PollingEngine();
  }
  return globalPollingEngine;
}

/**
 * Reset the global polling engine (for testing)
 */
export function resetPollingEngine(): void {
  if (globalPollingEngine) {
    globalPollingEngine.clear();
  }
  globalPollingEngine = null;
}
