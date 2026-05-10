/**
 * Archive Scheduler - Sets up the nightly archive job
 * Runs archiveOldTasks() every day at 2 AM
 *
 * Usage:
 * - Call initializeArchiveScheduler() once on app startup
 * - Or manually trigger via /api/tasks/archive POST endpoint
 */

import { archiveOldTasks } from "./taskArchiver";

// node-cron is imported dynamically so webpack never statically
// analyses it (node-cron v4 uses node:crypto / path which webpack
// can't resolve when bundling server code).

let archiveJobScheduled = false;

/**
 * Initialize the nightly archive scheduler
 * Runs at 2 AM local time every day
 */
export async function initializeArchiveScheduler(): Promise<void> {
  if (archiveJobScheduled) {
    console.log("[ArchiveScheduler] Already initialized");
    return;
  }

  try {
    // webpackIgnore tells webpack to skip static analysis of this import
    // so it never tries to bundle node-cron's ESM files (which use node:crypto).
    const cron = (await import(/* webpackIgnore: true */ "node-cron")).default;

    // Schedule for 2 AM daily (0 2 * * *)
    cron.schedule("0 2 * * *", async () => {
      console.log("[ArchiveScheduler] Running scheduled archive job");
      try {
        await archiveOldTasks();
        console.log("[ArchiveScheduler] Archive job completed successfully");
      } catch (error) {
        console.error("[ArchiveScheduler] Archive job failed:", error);
        // Log error but don't crash the scheduler
      }
    });

    archiveJobScheduled = true;
    console.log("[ArchiveScheduler] Initialized - archive runs daily at 2 AM");
  } catch (error) {
    console.error("[ArchiveScheduler] Failed to initialize:", error);
    throw error;
  }
}

/**
 * For testing: Run the archive job immediately
 */
export async function runArchiveNow(): Promise<void> {
  console.log("[ArchiveScheduler] Running archive job manually");
  await archiveOldTasks();
}
