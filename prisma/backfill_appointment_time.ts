/**
 * One-time backfill: copy metadata.appointmentTime → Task.appointmentTime.
 *
 * Why: the engine wrote appointmentTime into metadata only and never set the
 * top-level Task column. This is fixed forward in taskCreator.ts, but the
 * tasks already in the DB still have appointmentTime = NULL. This script
 * recovers the value from each task's metadata blob.
 *
 * Run inside the app container:
 *   docker cp prisma/backfill_appointment_time.ts taskos-app-1:/app/prisma/
 *   docker compose exec app node node_modules/.bin/tsx prisma/backfill_appointment_time.ts
 *
 * Idempotent: only touches rows where appointmentTime IS NULL.
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🔧  Backfilling Task.appointmentTime from metadata …");

  // Use raw SQL: jsonb path + safe cast. Schema-qualified for taskos.
  // Note: timestamps in metadata are ISO strings from when the engine wrote
  // them; ::timestamptz parses them as UTC (correct since we cast to UTC at
  // SQL boundary on the way in).
  const result = await prisma.$executeRaw`
    UPDATE taskos.tasks
       SET "appointmentTime" = (metadata->>'appointmentTime')::timestamptz
     WHERE "appointmentTime" IS NULL
       AND metadata ? 'appointmentTime'
       AND metadata->>'appointmentTime' IS NOT NULL
       AND metadata->>'appointmentTime' <> ''
  `;

  console.log(`  ✔ Backfilled ${result} task row(s).`);

  // Quick sanity sample
  const sample = await prisma.task.findMany({
    where: { appointmentTime: { not: null } },
    select: { id: true, title: true, appointmentTime: true },
    orderBy: { appointmentTime: "asc" },
    take: 5,
  });
  console.log("\nSample after backfill:");
  for (const t of sample) {
    console.log(`  #${t.id}  ${t.appointmentTime?.toISOString()}  ${t.title}`);
  }

  const stillNull = await prisma.task.count({
    where: { appointmentTime: null, isArchived: false },
  });
  console.log(`\n  ${stillNull} active task(s) still have NULL appointmentTime`);
  console.log(`  (these either have no metadata.appointmentTime or are non-order tasks — usually MANUAL).`);
}

main()
  .catch((e) => {
    console.error("❌  Backfill error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
