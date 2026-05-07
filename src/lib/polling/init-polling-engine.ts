/**
 * Polling Engine Initialization
 * Sets up all source handlers dynamically from database configuration
 * Call this once at application startup
 *
 * SCALABLE DESIGN:
 * - Handlers are created dynamically from DataSource configurations
 * - Add new sources by inserting DataSource records - no code changes needed
 * - Single DatabaseSourceHandler works for any table structure
 */

import { getPollingEngine } from "./polling-engine";
import { createDatabaseSourceHandler } from "./handlers/database-source-handler";
import prisma from "@/lib/db/client";

/**
 * Initialize the polling engine with all configured sources
 * Should be called once at application startup
 *
 * This is FULLY SCALABLE:
 * - Loads ALL data sources from database
 * - Creates handlers dynamically for each source
 * - No hardcoded handlers needed for new sources
 */
export async function initializePollingEngine(): Promise<void> {
  const engine = getPollingEngine();

  try {
    console.log("[InitPollingEngine] Starting polling engine initialization...");

    // Load all active data sources from database
    console.log("[InitPollingEngine] Loading data sources from database...");
    const dataSources = await prisma.dataSource.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "asc" },
    });

    if (dataSources.length === 0) {
      console.warn("[InitPollingEngine] No active data sources found");
      return;
    }

    console.log(`[InitPollingEngine] Found ${dataSources.length} active data source(s)`);

    // Dynamically create and register handlers for each source
    console.log("[InitPollingEngine] Creating handlers for each source...");
    for (const dataSource of dataSources) {
      try {
        const handler = await createDatabaseSourceHandler(dataSource.id);
        engine.registerHandler(dataSource.sourceId, handler);
        console.log(
          `[InitPollingEngine]   ✓ Handler created for: ${dataSource.sourceId} (${dataSource.displayName})`
        );
      } catch (error) {
        console.error(
          `[InitPollingEngine]   ✗ Failed to create handler for ${dataSource.sourceId}:`,
          error
        );
      }
    }

    // Configure polling for each source
    console.log("[InitPollingEngine] Configuring polling for each source...");
    for (const dataSource of dataSources) {
      const handler = engine.getHandler(dataSource.sourceId);
      if (!handler) {
        console.warn(
          `[InitPollingEngine]   ⚠ Handler not registered for ${dataSource.sourceId}`
        );
        continue;
      }

      await engine.configureSource({
        sourceId: dataSource.sourceId,
        handler,
        intervalMinutes: dataSource.pollingIntervalMinutes,
        isActive: dataSource.isActive,
      });

      console.log(
        `[InitPollingEngine]   ✓ Polling configured for ${dataSource.sourceId} (interval: ${dataSource.pollingIntervalMinutes}m)`
      );
    }

    // Validate all sources
    console.log("[InitPollingEngine] Validating source connections...");
    const validations = await engine.validateAllSources();

    let successCount = 0;
    for (const validation of validations) {
      if (validation.ok) {
        console.log(`[InitPollingEngine]   ✓ ${validation.sourceId}: ${validation.message}`);
        successCount++;
      } else {
        console.warn(`[InitPollingEngine]   ⚠ ${validation.sourceId}: ${validation.message}`);
      }
    }

    console.log(
      `[InitPollingEngine] Initialization complete: ${successCount}/${validations.length} sources validated`
    );
  } catch (error) {
    console.error("[InitPollingEngine] Error initializing polling engine:", error);
    throw error;
  }
}

/**
 * Get polling engine status
 */
export async function getPollingStatus() {
  const engine = getPollingEngine();
  return await engine.getPollingStatus();
}

/**
 * Validate all sources
 */
export async function validateAllSources() {
  const engine = getPollingEngine();
  return await engine.validateAllSources();
}

/**
 * Get all registered source IDs
 */
export function getAllSourceIds(): string[] {
  const engine = getPollingEngine();
  return engine.getAllSources();
}

/**
 * Get all active source IDs
 */
export function getActiveSourceIds(): string[] {
  const engine = getPollingEngine();
  return engine.getActiveSources();
}
