/**
 * Demo helper — manually polls the Appointments source for the demo
 * orders and feeds them through the existing rule engine.
 *
 * The legacy poller in src/lib/engine/poller.ts only polls public.Order;
 * the multi-source engine that would poll public.Appointment is disabled
 * in src/instrumentation.ts. For the demo we replicate what multi-source
 * polling WOULD do, scoped only to the reserved demo ID range so we
 * don't accidentally produce a flood of tasks for live appointment data.
 *
 * Run from inside the OpsFlow container:
 *   docker compose exec -T -e NODE_PATH=/app/node_modules -w /app app \
 *     node node_modules/.bin/tsx /tmp/poll-appointments.ts
 *
 * Invoked indirectly via `./tests/demo/run-demo.sh poll`.
 */

import { PrismaClient } from "@prisma/client";
import { evaluateAndCreateTasks, loadActiveRules } from "@/lib/engine/taskCreator";
import type { RawOrder } from "@/lib/engine/labstack";

const prisma = new PrismaClient();

interface AppointmentRow {
  id: number;
  user_id: number;
  appointmentType: string;
  appointmentStatus: string;
  appointmentDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  internalNotes: string | null;
  patientName: string | null;
}

async function fetchDemoAppointments(): Promise<RawOrder[]> {
  // Demo-scoped fetch — only the reserved ID range. Joins User for
  // patientName so the title template renders correctly.
  const rows = await prisma.$queryRaw<AppointmentRow[]>`
    SELECT
      a.id,
      a.user_id,
      a."appointmentType"::text   AS "appointmentType",
      a."appointmentStatus"::text AS "appointmentStatus",
      (a."appointmentDate" AT TIME ZONE 'Asia/Kolkata') AS "appointmentDate",
      (a."createdAt"       AT TIME ZONE 'Asia/Kolkata') AS "createdAt",
      (a."updatedAt"       AT TIME ZONE 'Asia/Kolkata') AS "updatedAt",
      COALESCE(a."internalNotes", '') AS "internalNotes",
      u.name AS "patientName"
    FROM public."Appointment" a
    JOIN public."User" u ON u.id = a.user_id
    WHERE a.id BETWEEN 8800001 AND 8800099
      AND a."appointmentStatus" NOT IN ('CANCELED', 'COMPLETED')
  `;

  // Map Appointment rows to the engine's RawOrder shape. Map
  //   appointmentType   → orderType
  //   appointmentStatus → orderStatus
  //   appointmentDate   → appointmentTime
  // and tag entityType="APPOINTMENTS" so dedup keys correctly.
  return rows.map((a) => ({
    id: a.id,
    orderType: a.appointmentType,
    orderStatus: a.appointmentStatus,
    appointmentTime: a.appointmentDate ?? a.createdAt,
    storeId: null,
    labId: null,
    userId: a.user_id,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    // Appointments don't have a statusUpdatedAt column, so we use
    // updatedAt — same value the multi-source DB handler would use.
    statusUpdatedAt: a.updatedAt,
    internalNotes: a.internalNotes ?? "",
    notes: "",
    phleboName: "",
    phleboNumber: "",
    patientName: a.patientName ?? "Demo Patient",
    labName: null,
    storeName: null,
    entityType: "APPOINTMENTS",
  }));
}

async function main() {
  const appointments = await fetchDemoAppointments();
  console.log(`[demo] Fetched ${appointments.length} demo appointments`);
  if (appointments.length === 0) {
    console.log(`[demo] (no demo appointments to evaluate — did you run 'seed' first?)`);
    await prisma.$disconnect();
    return;
  }

  const rules = await loadActiveRules();
  console.log(`[demo] Loaded ${rules.length} active rules`);

  const result = await evaluateAndCreateTasks(appointments, rules);
  console.log(`[demo] Tasks created: ${result.created}, skipped: ${result.skipped}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[demo] poll-appointments failed:", err);
  process.exit(1);
});
