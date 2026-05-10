/**
 * Demo verifier — counts tasks the engine created from the demo orders,
 * compares against EXPECTED_TASKS.md, prints pass/fail. Usable as a
 * smoke test in CI or a live demo.
 *
 * Run via:
 *   ./tests/demo/run-demo.sh verify
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface Expectation {
  source: string;          // entityType as stored on Task (NOT the dataSource sourceId)
  entityId: number;
  expectedTasks: number;
  triggers: string;
  description: string;
}

// The legacy poller in src/lib/engine/poller.ts polls only public.Order.
// For Appointments, the demo's poll-appointments.ts helper fetches the
// reserved demo-range Appointment rows and feeds them through the same
// rule engine — covering R6/R7a/R7b/R10 end-to-end. PharmaOrder has no
// rules so produces 0 regardless.
const EXPECTATIONS: Expectation[] = [
  // Lab Orders → engine stores entityType as "ORDER"
  { source: "ORDER", entityId: 8800001, expectedTasks: 2, triggers: "R1+R2",   description: "ORDER_SCHEDULED → Pre-Visit + Confirm New Order" },
  { source: "ORDER", entityId: 8800002, expectedTasks: 2, triggers: "R1+R8",   description: "PHLEBO_ASSIGNED + 2h-past appt → Pre-Visit + Collection Follow-Up" },
  { source: "ORDER", entityId: 8800003, expectedTasks: 2, triggers: "R8+R9",   description: "SAMPLE_COLLECTED + status 45m old → Collection FU + Sample Delivery" },
  { source: "ORDER", entityId: 8800004, expectedTasks: 1, triggers: "R4",      description: "SAMPLE_DELIVERED → Capture ETA" },
  { source: "ORDER", entityId: 8800005, expectedTasks: 1, triggers: "R5",      description: "SAMPLE_PROCESSED → Report Follow-Up & Upload" },
  { source: "ORDER", entityId: 8800006, expectedTasks: 0, triggers: "(none)",  description: "REPORT_DELIVERED — terminal, filtered before evaluation" },
  { source: "ORDER", entityId: 8800007, expectedTasks: 0, triggers: "(none)",  description: "CENTER_VISIT — type mismatch (rules require HOME_SAMPLE)" },
  { source: "ORDER", entityId: 8800008, expectedTasks: 0, triggers: "(none)",  description: "CAMP — type mismatch" },
  { source: "ORDER", entityId: 8800009, expectedTasks: 0, triggers: "(none)",  description: "KIT_BASED — type mismatch" },
  { source: "ORDER", entityId: 8800010, expectedTasks: 0, triggers: "(none)",  description: "CANCELED — terminal, filtered before evaluation" },

  // Appointments → polled by tests/demo/poll-appointments.ts (replicates
  // multi-source poll for the demo ID range). The engine evaluates
  // these the same way it evaluates Order rows, but tags the resulting
  // tasks entityType="APPOINTMENTS".
  { source: "APPOINTMENTS", entityId: 8800001, expectedTasks: 1, triggers: "R6",     description: "CENTER_VISIT + CREATED → Confirm Centre Appointment" },
  { source: "APPOINTMENTS", entityId: 8800002, expectedTasks: 1, triggers: "R6",     description: "CENTER_VISIT + PENDING → Confirm Centre Appointment" },
  { source: "APPOINTMENTS", entityId: 8800003, expectedTasks: 2, triggers: "R7a+R7b",description: "CENTER_VISIT + CONFIRMED → Day-of Check + T-1 Reconfirm" },
  { source: "APPOINTMENTS", entityId: 8800004, expectedTasks: 1, triggers: "R10",    description: "CENTER_VISIT + CHECKED_IN → Post-Visit Confirm Test" },
  { source: "APPOINTMENTS", entityId: 8800005, expectedTasks: 0, triggers: "(none)", description: "COMPLETED — filtered out before evaluation" },
  { source: "APPOINTMENTS", entityId: 8800006, expectedTasks: 1, triggers: "R6",     description: "HOME_VISIT + CREATED → R6 fires (allowedTypes empty = any)" },
  { source: "APPOINTMENTS", entityId: 8800007, expectedTasks: 0, triggers: "(none)", description: "ONLINE — R7 requires CENTER_VISIT" },
  { source: "APPOINTMENTS", entityId: 8800008, expectedTasks: 0, triggers: "(none)", description: "CANCELED — filtered out" },
  { source: "APPOINTMENTS", entityId: 8800009, expectedTasks: 0, triggers: "(none)", description: "DELAYED — no rule listens" },
  { source: "APPOINTMENTS", entityId: 8800010, expectedTasks: 0, triggers: "(none)", description: "RESCHEDULED — no rule listens" },

  // PharmaOrder → registered, but no rules + not polled
  { source: "PharmaOrder", entityId: 8800001, expectedTasks: 0, triggers: "(none)", description: "no rules + not polled" },
  { source: "PharmaOrder", entityId: 8800002, expectedTasks: 0, triggers: "(none)", description: "no rules + not polled" },
  { source: "PharmaOrder", entityId: 8800003, expectedTasks: 0, triggers: "(none)", description: "no rules + not polled" },
];

const c = {
  reset: "\x1b[0m", gray: "\x1b[90m", red: "\x1b[31m", green: "\x1b[32m",
  yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m",
};

async function run() {
  console.log(c.bold + "OpsFlow demo verifier" + c.reset);
  console.log(c.gray + "Comparing actual tasks against EXPECTED_TASKS.md\n" + c.reset);

  const rows = await prisma.task.findMany({
    where: { entityId: { gte: 8800001, lte: 8800099 }, isArchived: false },
    select: {
      id: true, entityType: true, entityId: true, title: true, status: true,
      taskRule: { select: { name: true } },
    },
    orderBy: [{ entityType: "asc" }, { entityId: "asc" }, { id: "asc" }],
  });

  const byKey = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.entityType}:${r.entityId}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(r);
  }

  let pass = 0, fail = 0, totalExpected = 0, totalActual = 0;

  for (const e of EXPECTATIONS) {
    const key = `${e.source}:${e.entityId}`;
    const tasks = byKey.get(key) ?? [];
    const ok = tasks.length === e.expectedTasks;
    totalExpected += e.expectedTasks;
    totalActual += tasks.length;
    const mark = ok ? c.green + "✓" + c.reset : c.red + "✗" + c.reset;
    const cnt = ok
      ? c.gray + `${tasks.length}/${e.expectedTasks}` + c.reset
      : c.red + `${tasks.length}/${e.expectedTasks}` + c.reset;
    console.log(
      `  ${mark} [${e.source.padEnd(13)}] #${e.entityId} ` +
      `${cnt}  ${c.cyan}${e.triggers.padEnd(10)}${c.reset} ${c.gray}${e.description}${c.reset}`
    );
    if (tasks.length > 0) {
      tasks.forEach((t) => console.log(`        ${c.gray}└─ ${t.taskRule?.name ?? "(no rule)"} → "${t.title}"${c.reset}`));
    }
    if (ok) pass++; else fail++;
  }

  console.log("");
  const summary = fail === 0
    ? c.green + c.bold + `✅ ALL ${pass} CHECKS PASSED` + c.reset
    : c.red   + c.bold + `❌ ${fail} of ${pass + fail} checks FAILED (${pass} passed)` + c.reset;
  console.log(summary);
  console.log(c.gray + `   Total tasks expected: ${totalExpected}` + c.reset);
  console.log(c.gray + `   Total tasks actual:   ${totalActual}` + c.reset);

  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => { console.error(err); process.exit(2); });
