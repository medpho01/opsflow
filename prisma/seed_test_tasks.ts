/**
 * Seed a realistic spread of test tasks for /head/my-work verification.
 *
 *   ~6 Today tasks   (appointmentTime spread across the day in IST)
 *   ~5 Tomorrow tasks (3 of them before 10 AM IST → trigger TONIGHT'S PREP)
 *   ~4 Stuck tasks   (appointmentTime yesterday / older, non-terminal status)
 *   ~3 Done tasks    (status COMPLETED, appointmentTime today)
 *
 * Run inside the app container:
 *   docker compose exec app node node_modules/.bin/tsx prisma/seed_test_tasks.ts
 *
 * Idempotent: wipes any previously-created seed_test tasks (tagged via
 * metadata._seedTest=true) before re-inserting, so you can run it repeatedly.
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient, TaskPriority, TaskStatus } from "@prisma/client";

const prisma = new PrismaClient();

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Construct a Date that represents `hours:minutes` IST on a given day offset.
 * E.g. istTime(15, 30, 0) = 3:30 PM IST today.
 */
function istTime(hours: number, minutes: number, daysOffset: number): Date {
  const now = new Date();
  // Shift to IST wall-clock, set the desired time, shift back to UTC
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  ist.setUTCDate(ist.getUTCDate() + daysOffset);
  ist.setUTCHours(hours, minutes, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

interface SeedTask {
  title: string;
  orderType: string;
  appointmentTime: Date | null;
  slaDeadline: Date;
  priority: TaskPriority;
  status: TaskStatus;
  entityId: number;
}

async function main() {
  console.log("🌱  Seeding test tasks for /head/my-work …");

  // ── Find a task rule + type to attach the tasks to ──────────────
  const rule = await prisma.taskRule.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
  });
  const taskType = await prisma.taskType.findFirst({
    orderBy: { id: "asc" },
  });
  if (!rule || !taskType) {
    throw new Error(
      "Need at least one active TaskRule and one TaskType. Run `npm run db:seed` first."
    );
  }
  console.log(`  ✔ Using rule "${rule.name}" (id=${rule.id}) and taskType "${taskType.name}"`);

  // ── Wipe previously-seeded test tasks ───────────────────────────
  const wiped = await prisma.task.deleteMany({
    where: { metadata: { path: ["_seedTest"], equals: true } },
  });
  if (wiped.count > 0) console.log(`  ✔ Wiped ${wiped.count} previously-seeded tasks`);

  // ── Build the task spread ───────────────────────────────────────
  const now = new Date();

  // SLA helper: "due in N min from now"
  const slaIn = (mins: number) => new Date(now.getTime() + mins * 60_000);

  const tasks: SeedTask[] = [
    // ── TODAY (appointmentTime today, various hours) ──────────────
    { title: "Confirm booking — Aarav Sharma (Order #91001)",       orderType: "HOME_SAMPLE",  appointmentTime: istTime(11, 0,  0), slaDeadline: slaIn(60),  priority: "HIGH",   status: "CREATED",   entityId: 91001 },
    { title: "Send video link — Priya Nair (Order #91002)",         orderType: "CONSULTATION", appointmentTime: istTime(13, 30, 0), slaDeadline: slaIn(120), priority: "MEDIUM", status: "ASSIGNED",  entityId: 91002 },
    { title: "Confirm delivery dispatched — Mohan Lal (Order #91003)", orderType: "PHARMACY",  appointmentTime: istTime(15, 0,  0), slaDeadline: slaIn(180), priority: "MEDIUM", status: "CREATED",   entityId: 91003 },
    { title: "Phlebo dispatch check — Vikram J (Order #91004)",     orderType: "HOME_SAMPLE",  appointmentTime: istTime(16, 30, 0), slaDeadline: slaIn(240), priority: "HIGH",   status: "ASSIGNED",  entityId: 91004 },
    { title: "Send prep instructions — Kavita Joshi (Order #91005)", orderType: "RADIOLOGY",   appointmentTime: istTime(18, 0,  0), slaDeadline: slaIn(360), priority: "LOW",    status: "CREATED",   entityId: 91005 },
    { title: "Confirm sample collected — Lakshmi R (Order #91006)", orderType: "HOME_SAMPLE",  appointmentTime: istTime(19, 30, 0), slaDeadline: slaIn(480), priority: "MEDIUM", status: "CREATED",   entityId: 91006 },

    // ── TOMORROW (3 early-morning → triggers TONIGHT'S PREP after 4 PM IST) ──
    { title: "Confirm tomorrow 7 AM appt — Dilshaad M (Order #91010)", orderType: "HOME_SAMPLE", appointmentTime: istTime(7, 0,   1), slaDeadline: slaIn(720),  priority: "HIGH",   status: "CREATED", entityId: 91010 },
    { title: "Confirm tomorrow 7:30 AM appt — Asha M (Order #91011)",  orderType: "HOME_SAMPLE", appointmentTime: istTime(7, 30,  1), slaDeadline: slaIn(720),  priority: "HIGH",   status: "CREATED", entityId: 91011 },
    { title: "Confirm tomorrow 8:30 AM appt — Kiran P (Order #91012)", orderType: "HOME_SAMPLE", appointmentTime: istTime(8, 30,  1), slaDeadline: slaIn(720),  priority: "MEDIUM", status: "CREATED", entityId: 91012 },
    { title: "Confirm tomorrow 11 AM consult — Riya M (Order #91013)", orderType: "CONSULTATION", appointmentTime: istTime(11, 0,  1), slaDeadline: slaIn(900),  priority: "MEDIUM", status: "CREATED", entityId: 91013 },
    { title: "Confirm tomorrow 3 PM delivery — Anjali V (Order #91014)", orderType: "PHARMACY",  appointmentTime: istTime(15, 0,  1), slaDeadline: slaIn(1200), priority: "LOW",    status: "CREATED", entityId: 91014 },

    // ── STUCK (yesterday or older, non-terminal) ──────────────────
    { title: "Sample handover — Asha Menon (Order #91020) [stuck]", orderType: "HOME_SAMPLE", appointmentTime: istTime(15, 0,  -1), slaDeadline: slaIn(-300), priority: "URGENT", status: "ASSIGNED",  entityId: 91020 },
    { title: "Report follow-up — Vikram T (Order #91021) [stuck]",  orderType: "HOME_SAMPLE", appointmentTime: istTime(9, 0,   -2), slaDeadline: slaIn(-600), priority: "HIGH",   status: "IN_PROGRESS", entityId: 91021 },
    { title: "Missed delivery — Mehul S (Order #91022) [stuck]",    orderType: "PHARMACY",    appointmentTime: istTime(14, 0,  -1), slaDeadline: slaIn(-400), priority: "MEDIUM", status: "ASSIGNED",  entityId: 91022 },
    { title: "Patient no-show — Ravi K (Order #91023) [stuck]",     orderType: "CONSULTATION", appointmentTime: istTime(11, 0,  -1), slaDeadline: slaIn(-500), priority: "HIGH",   status: "CREATED",   entityId: 91023 },

    // ── DONE today ────────────────────────────────────────────────
    { title: "Confirmed booking — Prerana G (Order #91030) ✓",       orderType: "HOME_SAMPLE",  appointmentTime: istTime(9, 30, 0),  slaDeadline: slaIn(-60), priority: "MEDIUM", status: "COMPLETED", entityId: 91030 },
    { title: "Dispatched phlebo — Dhruvak A (Order #91031) ✓",       orderType: "HOME_SAMPLE",  appointmentTime: istTime(10, 0, 0),  slaDeadline: slaIn(-30), priority: "MEDIUM", status: "COMPLETED", entityId: 91031 },
    { title: "Sent video link — Arjun R (Order #91032) ✓",           orderType: "CONSULTATION", appointmentTime: istTime(10, 30, 0), slaDeadline: slaIn(-15), priority: "LOW",    status: "COMPLETED", entityId: 91032 },
  ];

  let created = 0;
  for (const t of tasks) {
    await prisma.task.create({
      data: {
        taskRuleId: rule.id,
        taskTypeId: taskType.id,
        title: t.title,
        entityType: "ORDER",
        entityId: t.entityId,
        orderType: t.orderType,
        priority: t.priority,
        status: t.status,
        appointmentTime: t.appointmentTime,
        slaDeadline: t.slaDeadline,
        metadata: { _seedTest: true, manual: true },
      },
    });
    created++;
  }

  console.log(`  ✔ Created ${created} test tasks`);
  console.log("\n✅  Done. Refresh /head/my-work to see them bucketed.\n");
}

main()
  .catch((e) => {
    console.error("❌  Seed error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
