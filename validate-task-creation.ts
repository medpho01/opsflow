/**
 * Task Creation Validation Script
 * Executes validation queries to identify:
 * 1. Orders that SHOULD have tasks based on SOP logic
 * 2. Orders that actually HAVE tasks
 * 3. Gaps between expected and actual tasks
 */

import prisma from "@/lib/db/client";

async function runValidation() {
  console.log("=".repeat(80));
  console.log("TASK CREATION VALIDATION ANALYSIS");
  console.log("=".repeat(80));

  try {
    // ===== HOME SAMPLE COLLECTION (HSC) VALIDATION =====
    console.log("\n📋 PART 1: HOME SAMPLE COLLECTION (HSC)");
    console.log("-".repeat(80));

    // HSC-R1: 30-minute confirmation
    console.log("\n1.1 HSC-R1: 30-Minute Confirmation Task");
    const hsc_r1 = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        o.id as order_id,
        o."orderStatus" as current_status,
        o."createdAt" as order_created_at,
        EXTRACT(MINUTE FROM (NOW() - o."createdAt")) as mins_since_creation,
        o."appointmentTime",
        o."patientName",
        o."orderType"
      FROM
        source_schema."Order" o
      WHERE
        o."orderType" = 'HOME_SAMPLE_COLLECTION'
        AND o."orderStatus" = 'ORDER_SCHEDULED'
        AND (NOW() - o."createdAt") >= INTERVAL '30 minutes'
        AND o."deletedAt" IS NULL
      ORDER BY
        o."createdAt" DESC
      LIMIT 20
    `);
    console.log(`Orders needing HSC-R1 task: ${hsc_r1.length}`);
    if (hsc_r1.length > 0) {
      console.log(`Sample orders:`, hsc_r1.slice(0, 3));
    }

    // HSC-R2: T-1 confirmation
    console.log("\n1.2 HSC-R2: T-1 Confirmation Task");
    const hsc_r2 = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        o.id as order_id,
        o."orderStatus" as current_status,
        o."appointmentTime" as scheduled_appointment,
        o."createdAt",
        o."patientName",
        (o."appointmentTime"::date - CURRENT_DATE) as days_until_appointment
      FROM
        source_schema."Order" o
      WHERE
        o."orderType" = 'HOME_SAMPLE_COLLECTION'
        AND o."appointmentTime"::date = CURRENT_DATE + INTERVAL '1 day'
        AND o."orderStatus" IN ('ORDER_SCHEDULED', 'PHLEBO_ASSIGNED')
        AND o."deletedAt" IS NULL
      ORDER BY
        o."appointmentTime" ASC
      LIMIT 20
    `);
    console.log(`Orders needing HSC-R2 task: ${hsc_r2.length}`);

    // HSC-R3: Pre-visit tracking
    console.log("\n1.3 HSC-R3: Pre-Visit Tracking Task");
    const hsc_r3 = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        o.id as order_id,
        o."orderStatus" as current_status,
        o."appointmentTime" as appointment,
        EXTRACT(MINUTE FROM (o."appointmentTime" - NOW())) as mins_until_appointment,
        o."patientName"
      FROM
        source_schema."Order" o
      WHERE
        o."orderType" = 'HOME_SAMPLE_COLLECTION'
        AND o."appointmentTime" BETWEEN NOW() AND NOW() + INTERVAL '30 minutes'
        AND o."orderStatus" NOT IN ('PHLEBO_ASSIGNED', 'SAMPLE_COLLECTED', 'SAMPLE_DELIVERED', 'REPORT_DELIVERED')
        AND o."deletedAt" IS NULL
      ORDER BY
        o."appointmentTime" ASC
      LIMIT 20
    `);
    console.log(`Orders needing HSC-R3 task: ${hsc_r3.length}`);

    // HSC-R4: Collection tracking
    console.log("\n1.4 HSC-R4: Collection Tracking Task");
    const hsc_r4 = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        o.id as order_id,
        o."orderStatus" as current_status,
        o."appointmentTime",
        oh."createdAt" as phlebo_assigned_at,
        EXTRACT(MINUTE FROM (NOW() - oh."createdAt")) as mins_since_phlebo_assignment,
        o."patientName"
      FROM
        source_schema."Order" o
      LEFT JOIN source_schema."OrderHistory" oh ON o.id = oh."orderId" AND oh."status" = 'PHLEBO_ASSIGNED'
      WHERE
        o."orderType" = 'HOME_SAMPLE_COLLECTION'
        AND o."orderStatus" = 'PHLEBO_ASSIGNED'
        AND (NOW() - oh."createdAt") >= INTERVAL '60 minutes'
        AND o."deletedAt" IS NULL
      ORDER BY
        oh."createdAt" ASC
      LIMIT 20
    `);
    console.log(`Orders needing HSC-R4 task: ${hsc_r4.length}`);

    // HSC-R5: Sample movement tracking
    console.log("\n1.5 HSC-R5: Sample Movement Tracking Task");
    const hsc_r5 = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        o.id as order_id,
        o."orderStatus" as current_status,
        oh."createdAt" as sample_collected_at,
        EXTRACT(MINUTE FROM (NOW() - oh."createdAt")) as mins_since_collection,
        o."patientName"
      FROM
        source_schema."Order" o
      LEFT JOIN source_schema."OrderHistory" oh ON o.id = oh."orderId" AND oh."status" = 'SAMPLE_COLLECTED'
      WHERE
        o."orderType" = 'HOME_SAMPLE_COLLECTION'
        AND o."orderStatus" = 'SAMPLE_COLLECTED'
        AND (NOW() - oh."createdAt") >= INTERVAL '2 hours'
        AND o."deletedAt" IS NULL
      ORDER BY
        oh."createdAt" ASC
      LIMIT 20
    `);
    console.log(`Orders needing HSC-R5 task: ${hsc_r5.length}`);

    // HSC-R6: Report tracking
    console.log("\n1.6 HSC-R6: Report Tracking Task");
    const hsc_r6 = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        o.id as order_id,
        o."orderStatus" as current_status,
        o."metadata"->>'reportETA' as report_eta,
        EXTRACT(MINUTE FROM (NOW() - (o."metadata"->>'sampleDeliveredAt')::timestamp)) as mins_since_delivery,
        o."patientName"
      FROM
        source_schema."Order" o
      WHERE
        o."orderType" = 'HOME_SAMPLE_COLLECTION'
        AND o."orderStatus" = 'SAMPLE_DELIVERED'
        AND o."deletedAt" IS NULL
        AND o."metadata"->>'reportETA' IS NOT NULL
      ORDER BY
        (o."metadata"->>'reportETA')::timestamp ASC
      LIMIT 20
    `);
    console.log(`Orders needing HSC-R6 task: ${hsc_r6.length}`);

    // HSC-R8: Escalation monitoring
    console.log("\n1.7 HSC-R8: Escalation Monitoring Task");
    const hsc_r8 = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        o.id as order_id,
        o."orderStatus" as current_status,
        MAX(oh."createdAt") as last_status_update,
        EXTRACT(MINUTE FROM (NOW() - MAX(oh."createdAt"))) as mins_since_last_update,
        o."patientName"
      FROM
        source_schema."Order" o
      LEFT JOIN source_schema."OrderHistory" oh ON o.id = oh."orderId"
      WHERE
        o."orderType" = 'HOME_SAMPLE_COLLECTION'
        AND o."orderStatus" IN ('PHLEBO_ASSIGNED', 'SAMPLE_COLLECTED')
        AND o."deletedAt" IS NULL
      GROUP BY
        o.id, o."orderStatus", o."patientName"
      HAVING
        (NOW() - MAX(oh."createdAt")) >= INTERVAL '2 hours'
      ORDER BY
        MAX(oh."createdAt") ASC
      LIMIT 20
    `);
    console.log(`Orders needing HSC-R8 task: ${hsc_r8.length}`);

    // ===== CENTRE VISIT (CV) VALIDATION =====
    console.log("\n📋 PART 2: CENTRE VISIT (CV)");
    console.log("-".repeat(80));

    // CV-R1: 30-minute confirmation
    console.log("\n2.1 CV-R1: Confirm Centre Appointment Task");
    const cv_r1 = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        o.id as order_id,
        o."orderStatus" as current_status,
        o."createdAt" as order_created_at,
        EXTRACT(MINUTE FROM (NOW() - o."createdAt")) as mins_since_creation,
        o."appointmentTime",
        o."patientName"
      FROM
        source_schema."Order" o
      WHERE
        o."orderType" = 'CENTRE_VISIT'
        AND o."orderStatus" = 'ORDER_SCHEDULED'
        AND (NOW() - o."createdAt") >= INTERVAL '30 minutes'
        AND o."deletedAt" IS NULL
      ORDER BY
        o."createdAt" DESC
      LIMIT 20
    `);
    console.log(`Orders needing CV-R1 task: ${cv_r1.length}`);

    // CV-R3: Pre-appointment check
    console.log("\n2.2 CV-R3: Pre-Appointment Check Task");
    const cv_r3 = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        o.id as order_id,
        o."orderStatus" as current_status,
        o."appointmentTime" as appointment,
        EXTRACT(MINUTE FROM (o."appointmentTime" - NOW())) as mins_until_appointment,
        o."patientName"
      FROM
        source_schema."Order" o
      WHERE
        o."orderType" = 'CENTRE_VISIT'
        AND o."appointmentTime" BETWEEN NOW() + INTERVAL '120 minutes' AND NOW() + INTERVAL '150 minutes'
        AND o."orderStatus" NOT IN ('REPORT_DELIVERED', 'COMPLETED', 'CANCELLED')
        AND o."deletedAt" IS NULL
      ORDER BY
        o."appointmentTime" ASC
      LIMIT 20
    `);
    console.log(`Orders needing CV-R3 task: ${cv_r3.length}`);

    // CV-R4: Post-appointment check
    console.log("\n2.3 CV-R4: Post-Appointment Check Task");
    const cv_r4 = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        o.id as order_id,
        o."orderStatus" as current_status,
        o."appointmentTime" as appointment,
        EXTRACT(MINUTE FROM (NOW() - o."appointmentTime")) as mins_after_appointment,
        o."patientName"
      FROM
        source_schema."Order" o
      WHERE
        o."orderType" = 'CENTRE_VISIT'
        AND o."appointmentTime" BETWEEN NOW() - INTERVAL '90 minutes' AND NOW() - INTERVAL '60 minutes'
        AND o."orderStatus" NOT IN ('REPORT_DELIVERED', 'COMPLETED', 'CANCELLED')
        AND o."deletedAt" IS NULL
      ORDER BY
        o."appointmentTime" ASC
      LIMIT 20
    `);
    console.log(`Orders needing CV-R4 task: ${cv_r4.length}`);

    // ===== INJECTION ADMINISTRATION (IA) VALIDATION =====
    console.log("\n📋 PART 3: INJECTION ADMINISTRATION (IA)");
    console.log("-".repeat(80));

    // IA-R1: Medic assignment
    console.log("\n3.1 IA-R1: Assign Medic Task");
    const ia_r1 = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        o.id as order_id,
        o."orderStatus" as current_status,
        o."createdAt" as order_created_at,
        EXTRACT(MINUTE FROM (NOW() - o."createdAt")) as mins_since_creation,
        o."appointmentTime",
        o."patientName"
      FROM
        source_schema."Order" o
      WHERE
        o."orderType" = 'INJECTION_AT_HOME'
        AND o."orderStatus" = 'ORDER_SCHEDULED'
        AND (NOW() - o."createdAt") >= INTERVAL '30 minutes'
        AND o."deletedAt" IS NULL
      ORDER BY
        o."createdAt" DESC
      LIMIT 20
    `);
    console.log(`Orders needing IA-R1 task: ${ia_r1.length}`);

    // IA-R2: Pre-visit confirmation
    console.log("\n3.2 IA-R2: Pre-Visit Medic Confirmation Task");
    const ia_r2 = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        o.id as order_id,
        o."orderStatus" as current_status,
        o."appointmentTime" as appointment,
        EXTRACT(MINUTE FROM (o."appointmentTime" - NOW())) as mins_until_appointment,
        o."patientName"
      FROM
        source_schema."Order" o
      WHERE
        o."orderType" = 'INJECTION_AT_HOME'
        AND o."appointmentTime" BETWEEN NOW() AND NOW() + INTERVAL '60 minutes'
        AND o."orderStatus" NOT IN ('MEDIC_REACHED', 'INJECTION_ADMINISTERED', 'COMPLETED', 'CANCELLED')
        AND o."deletedAt" IS NULL
      ORDER BY
        o."appointmentTime" ASC
      LIMIT 20
    `);
    console.log(`Orders needing IA-R2 task: ${ia_r2.length}`);

    // IA-R3: Medic arrival tracking
    console.log("\n3.3 IA-R3: Track Medic Arrival Task");
    const ia_r3 = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        o.id as order_id,
        o."orderStatus" as current_status,
        o."appointmentTime" as appointment,
        EXTRACT(MINUTE FROM (NOW() - o."appointmentTime")) as mins_after_appointment,
        o."patientName"
      FROM
        source_schema."Order" o
      WHERE
        o."orderType" = 'INJECTION_AT_HOME'
        AND o."orderStatus" = 'MEDIC_ASSIGNED'
        AND o."appointmentTime" <= NOW()
        AND (NOW() - o."appointmentTime") >= INTERVAL '5 minutes'
        AND o."deletedAt" IS NULL
      ORDER BY
        o."appointmentTime" ASC
      LIMIT 20
    `);
    console.log(`Orders needing IA-R3 task: ${ia_r3.length}`);

    // ===== CRITICAL GAP ANALYSIS =====
    console.log("\n🚨 PART 4: GAP ANALYSIS - COMPLETED ORDERS WITH OPEN TASKS");
    console.log("-".repeat(80));

    const completedWithOpenTasks = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        o.id as order_id,
        o."orderStatus" as order_final_status,
        o."orderType",
        COUNT(t.id) as open_task_count,
        STRING_AGG(t."title", '; ') as task_titles,
        STRING_AGG(t."status"::text, ', ') as task_statuses,
        MAX(t."createdAt") as oldest_open_task_created
      FROM
        source_schema."Order" o
      LEFT JOIN taskos.tasks t ON t."entityId" = o.id AND t."entityType" = 'ORDER'
      WHERE
        o."orderStatus" IN ('REPORT_DELIVERED', 'COMPLETED')
        AND o."deletedAt" IS NULL
        AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
      GROUP BY
        o.id, o."orderStatus", o."orderType"
      HAVING
        COUNT(t.id) > 0
      ORDER BY
        MAX(t."createdAt") DESC
      LIMIT 30
    `);
    console.log(`\n⚠️ Completed orders with open tasks: ${completedWithOpenTasks.length}`);
    if (completedWithOpenTasks.length > 0) {
      console.log("Sample completed orders with gaps:");
      completedWithOpenTasks.slice(0, 5).forEach((row: any) => {
        console.log(`  Order ${row.order_id} (${row.orderType}): ${row.open_task_count} open task(s)`);
        console.log(`    Tasks: ${row.task_titles}`);
      });
    }

    // ===== SUMMARY STATISTICS =====
    console.log("\n📊 SUMMARY STATISTICS");
    console.log("-".repeat(80));

    const stats = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        'TOTAL ORDERS' as metric,
        COUNT(*) as count
      FROM source_schema."Order"
      WHERE "deletedAt" IS NULL
      UNION ALL
      SELECT 'ORDER_SCHEDULED', COUNT(*)
      FROM source_schema."Order"
      WHERE "orderStatus" = 'ORDER_SCHEDULED' AND "deletedAt" IS NULL
      UNION ALL
      SELECT 'PHLEBO_ASSIGNED', COUNT(*)
      FROM source_schema."Order"
      WHERE "orderStatus" = 'PHLEBO_ASSIGNED' AND "deletedAt" IS NULL
      UNION ALL
      SELECT 'SAMPLE_COLLECTED', COUNT(*)
      FROM source_schema."Order"
      WHERE "orderStatus" = 'SAMPLE_COLLECTED' AND "deletedAt" IS NULL
      UNION ALL
      SELECT 'SAMPLE_DELIVERED', COUNT(*)
      FROM source_schema."Order"
      WHERE "orderStatus" = 'SAMPLE_DELIVERED' AND "deletedAt" IS NULL
      UNION ALL
      SELECT 'REPORT_DELIVERED', COUNT(*)
      FROM source_schema."Order"
      WHERE "orderStatus" = 'REPORT_DELIVERED' AND "deletedAt" IS NULL
      UNION ALL
      SELECT 'COMPLETED', COUNT(*)
      FROM source_schema."Order"
      WHERE "orderStatus" = 'COMPLETED' AND "deletedAt" IS NULL
      UNION ALL
      SELECT 'CANCELLED', COUNT(*)
      FROM source_schema."Order"
      WHERE "orderStatus" = 'CANCELLED' AND "deletedAt" IS NULL
      UNION ALL
      SELECT 'All Open Tasks', COUNT(*)
      FROM taskos.tasks
      WHERE "status" NOT IN ('COMPLETED', 'CANCELLED')
      UNION ALL
      SELECT 'Tasks on Completed Orders', COUNT(*)
      FROM taskos.tasks t
      LEFT JOIN source_schema."Order" o ON t."entityId" = o.id AND t."entityType" = 'ORDER'
      WHERE o."orderStatus" IN ('REPORT_DELIVERED', 'COMPLETED')
        AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
        AND o."deletedAt" IS NULL
    `);

    stats.forEach((row: any) => {
      console.log(`${row.metric.padEnd(30)}: ${row.count}`);
    });

    console.log("\n" + "=".repeat(80));
    console.log("✅ Validation Complete");
    console.log("=".repeat(80));
  } catch (error) {
    console.error("❌ Validation Error:", error);
  } finally {
    await prisma.$disconnect();
  }
}

runValidation();
