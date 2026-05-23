/**
 * Wipe all tasks (and dependent rows) from the taskos schema.
 *
 * Why: the next poll cycle will re-create tasks from active orders, but this
 * time with the appointmentTime column populated correctly (engine fix in
 * taskCreator.ts). Wiping first ensures we don't carry over the broken rows.
 *
 * Deletes (in FK-safe order):
 *   - task_history
 *   - task_checklist_items
 *   - tasks
 *
 * Skips:
 *   - escalation_chains, task_rules, users, etc. — pure config / reference data
 *
 * Run inside the app container:
 *   docker cp prisma/wipe_all_tasks.ts taskos-app-1:/app/prisma/
 *   docker compose exec app node node_modules/.bin/tsx prisma/wipe_all_tasks.ts
 *
 * After running, force a poll (or wait ≤5 min for the next cron tick):
 *   curl -X POST http://localhost:3000/api/debug/trigger-poller
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🧹  Wiping all tasks from taskos…");

  // FK-safe order: history + checklist items first, then tasks themselves.
  // Other task-linked rows (escalation_runs, escalation_attempts, etc.) cascade
  // via the FK constraints in the schema. If any do not, add explicit deletes
  // above the tasks line.
  const history    = await prisma.taskHistory.deleteMany({});
  const checklist  = await prisma.taskChecklistItem.deleteMany({});
  const tasks      = await prisma.task.deleteMany({});

  console.log(`  ✔ Deleted ${history.count}  task_history rows`);
  console.log(`  ✔ Deleted ${checklist.count}  task_checklist_items rows`);
  console.log(`  ✔ Deleted ${tasks.count}  tasks rows`);
  console.log("\n✅  Clean slate. Next poll cycle will repopulate from active orders.");
  console.log("   Force a poll now:  curl -X POST http://localhost:3000/api/debug/trigger-poller");
}

main()
  .catch((e) => { console.error("❌ ", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
