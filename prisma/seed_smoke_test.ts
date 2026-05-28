/**
 * Smoke-test seed: recreate the prod state where Smart View was hiding
 * BREACHED tasks because today's mass retirement filled the 500-task cap.
 *
 * Produces:
 *   - 500 CANCELLED tasks (status terminal, metadata.autoRetiredByEngine,
 *     completedAt=now, appointmentTime in the recent past) — mimics today's
 *     engine retirement pile
 *   - 133 BREACHED tasks (non-terminal, appointmentTime today morning,
 *     slaDeadline in the past)
 *   - 11 CREATED tasks (non-terminal, appointmentTime later today)
 *   - 3 COMPLETED tasks (terminal, completedAt=now, NO autoRetired flag)
 *     — represents human-completed work for the day
 *
 * After seeding, hit /api/tasks with the two MyWorkBoard fetches and verify
 * we see the right counts: Stuck ~ 133, NOW/LATER ~ 11, done-by-team ~ 3,
 * done-by-engine ~ 500.
 *
 * Idempotent: deletes any existing smoke-test tasks (entityType="SMOKE")
 * before re-seeding.
 */
import { PrismaClient, TaskStatus, TaskPriority } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("[Smoke] Wiping existing smoke-test tasks…");
  await prisma.task.deleteMany({ where: { entityType: "SMOKE" } });

  // Pick any active rule we can attach the synthetic tasks to. The rule's
  // own statusIn doesn't matter for these tests because they live or die
  // by their Task.status / completedAt / appointmentTime alone.
  const rule = await prisma.taskRule.findFirst({
    where: { isActive: true, id: { not: "MANUAL" } },
    select: { id: true, name: true, taskTypeId: true },
  });
  if (!rule || !rule.taskTypeId) {
    throw new Error("No active rule with a taskTypeId found — seed normal data first.");
  }
  console.log(`[Smoke] Attaching to rule: ${rule.name}`);

  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = now.getTime() + istOffsetMs;
  const istMidnight = Math.floor(istNow / 86_400_000) * 86_400_000 - istOffsetMs;
  const todayMidnight = new Date(istMidnight); // today 00:00 IST

  // Helper to build a base task row.
  const base = (i: number) => ({
    taskRuleId: rule.id,
    taskTypeId: rule.taskTypeId!,
    title: `Smoke task ${i}`,
    entityType: "SMOKE",
    entityId: 900_000 + i, // synthetic ids well above real labstack orders
    storeId: null,
    orderType: "HOME_SAMPLE",
    priority: TaskPriority.MEDIUM,
    slaDeadline: now, // overridden per-bucket below
    metadata: {} as Record<string, unknown>,
    isArchived: false,
  });

  // 1. CANCELLED — today's engine retirement pile (500 tasks).
  //    appointmentTime is in the past (these were old tasks that got
  //    closed today). completedAt = now to hit completedAfter=today.
  console.log("[Smoke] Inserting 500 CANCELLED (engine-retired today)…");
  const cancelledRows = Array.from({ length: 500 }, (_, i) => ({
    ...base(i),
    status: TaskStatus.CANCELLED,
    appointmentTime: new Date(now.getTime() - (5 + (i % 30)) * 24 * 60 * 60_000), // 5-35 days ago
    completedAt: new Date(now.getTime() - i * 1000), // staggered now-ish
    lastStatusUpdate: now,
    metadata: { autoRetiredByEngine: true, smokeTest: true },
  }));
  await prisma.task.createMany({ data: cancelledRows });

  // 2. BREACHED — today's broken work (133 tasks).
  //    appointmentTime today AM, slaDeadline before now → SLA breach.
  console.log("[Smoke] Inserting 133 BREACHED (today, past appt)…");
  const breachedRows = Array.from({ length: 133 }, (_, i) => ({
    ...base(500 + i),
    status: TaskStatus.BREACHED,
    appointmentTime: new Date(todayMidnight.getTime() + (8 + (i % 4)) * 60 * 60_000), // today 8-11 AM IST
    slaBreachedAt: new Date(now.getTime() - 60 * 60_000),
    slaDeadline: new Date(now.getTime() - 30 * 60_000),
    metadata: { smokeTest: true },
  }));
  await prisma.task.createMany({ data: breachedRows });

  // 3. CREATED — today's still-fresh work (11 tasks).
  //    appointmentTime later today, slaDeadline in the future.
  console.log("[Smoke] Inserting 11 CREATED (today, upcoming appt)…");
  const createdRows = Array.from({ length: 11 }, (_, i) => ({
    ...base(700 + i),
    status: TaskStatus.CREATED,
    appointmentTime: new Date(todayMidnight.getTime() + (18 + (i % 4)) * 60 * 60_000), // today 6-9 PM IST
    slaDeadline: new Date(now.getTime() + (60 + i * 5) * 60_000),
    metadata: { smokeTest: true },
  }));
  await prisma.task.createMany({ data: createdRows });

  // 4. COMPLETED by team — 3 tasks closed by humans today (no engine flag).
  console.log("[Smoke] Inserting 3 COMPLETED (by team today)…");
  const completedRows = Array.from({ length: 3 }, (_, i) => ({
    ...base(800 + i),
    status: TaskStatus.COMPLETED,
    appointmentTime: new Date(todayMidnight.getTime() + (10 + i) * 60 * 60_000),
    completedAt: new Date(now.getTime() - (i + 1) * 30 * 60_000),
    lastStatusUpdate: now,
    metadata: { smokeTest: true },
  }));
  await prisma.task.createMany({ data: completedRows });

  const counts = await prisma.task.groupBy({
    by: ["status"],
    where: { entityType: "SMOKE" },
    _count: true,
  });
  console.log("[Smoke] Seed complete. By status:");
  for (const c of counts) console.log(`  ${c.status}: ${c._count}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[Smoke] Error:", e);
  process.exit(1);
});
