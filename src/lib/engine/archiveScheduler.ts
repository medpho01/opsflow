/**
 * Archive Scheduler - Sets up the nightly archive job
 * Runs archiveOldTasks() every day at 2 AM
 *
 * Usage:
 * - Call initializeArchiveScheduler() once on app startup
 * - Or manually trigger via /api/tasks/archive POST endpoint
 */

import { archiveOldTasks } from "./taskArchiver";
import cron from "node-cron";

let archiveJobScheduled = false;

/**
 * Initialize the nightly archive scheduler
 * Runs at 2 AM local time every day
 */
export function initializeArchiveScheduler(): void {
  if (archiveJobScheduled) {
    console.log("[ArchiveScheduler] Already initialized");
    return;
  }

  try {
    // Schedule for 2 AM daily (0 2 * * *)
    // Format: minute hour day month dayOfWeek
    const job = cron.schedule("0 2 * * *", async () => {
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

    return job;
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
