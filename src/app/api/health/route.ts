/**
 * Health Check & Initialization Endpoint
 * GET /api/health
 *
 * Purpose:
 * - Provides health status of the application
 * - Initializes polling engine and scheduler on first run
 * - Can be used for monitoring/uptime checks
 *
 * The initialization is idempotent (safe to call multiple times)
 */

import { NextRequest, NextResponse } from "next/server";
import { initializePollingEngine } from "@/lib/polling/init-polling-engine";
import { startPollingSchedulers, getScheduledTasksStatus } from "@/lib/polling/polling-scheduler";
import prisma from "@/lib/db/client";

// Global flag to track if initialization has been done
let initializationInProgress = false;
let initializationComplete = false;

/**
 * Initialize polling system (idempotent - safe to call multiple times)
 */
async function ensurePollingInitialized(): Promise<void> {
  if (initializationComplete) {
    return;
  }

  if (initializationInProgress) {
    // Wait for initialization to complete
    let attempts = 0;
    while (initializationInProgress && attempts < 60) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      attempts++;
    }
    return;
  }

  initializationInProgress = true;

  try {
    console.log("[Health] Starting polling system initialization...");

    // 1. Initialize polling engine with all configured sources
    await initializePollingEngine();

    // 2. Start polling schedulers for all active sources
    await startPollingSchedulers();

    initializationComplete = true;
    console.log("[Health] Polling system initialization complete");
  } catch (error) {
    console.error("[Health] Error initializing polling system:", error);
    initializationInProgress = false;
    throw error;
  } finally {
    initializationInProgress = false;
  }
}

export async function GET(req: NextRequest) {
  try {
    // Ensure polling is initialized
    await ensurePollingInitialized();

    // Check database connectivity
    let dbConnected = false;
    let dbError: string | null = null;

    try {
      await prisma.$queryRaw`SELECT 1`;
      dbConnected = true;
    } catch (error) {
      dbError = error instanceof Error ? error.message : String(error);
    }

    // Get scheduled tasks status
    const scheduledTasks = getScheduledTasksStatus();

    // Get data source count
    const sourcesCount = await prisma.dataSource.count();
    const activeSources = await prisma.dataSource.count({
      where: { isActive: true },
    });

    return NextResponse.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      components: {
        database: {
          status: dbConnected ? "healthy" : "unhealthy",
          error: dbError,
        },
        polling: {
          status: initializationComplete ? "running" : "initializing",
          scheduledTasks: scheduledTasks.length,
          activeSchedules: scheduledTasks.filter((t) => t.isRunning).length,
          tasks: scheduledTasks,
        },
        dataSources: {
          total: sourcesCount,
          active: activeSources,
        },
      },
      initialization: {
        complete: initializationComplete,
        inProgress: initializationInProgress,
      },
    });
  } catch (error) {
    console.error("[Health] Health check failed:", error);

    return NextResponse.json(
      {
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503 }
    );
  }
}
