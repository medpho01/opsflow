/**
 * Seed — populates taskos schema with:
 *   - Skill tags
 *   - Task types (with checklist templates)
 *   - Task rules (8 Home Sample Collection rules)
 *   - A default escalation chain
 *   - A default OPS_HEAD admin user (password: changeme123)
 *
 * Run: npx tsx prisma/seed.ts
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient, OrderType, TaskPriority, UserRole } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱  Seeding taskos schema...");

  // ── 1. Skill tags ────────────────────────────────────────────────
  const skills = await Promise.all(
    [
      { name: "HOME_SAMPLE", label: "Home Sample Collection" },
      { name: "PHLEBOTOMY", label: "Phlebotomy / Blood Draw" },
      { name: "CUSTOMER_CARE", label: "Customer Care" },
      { name: "LOGISTICS", label: "Logistics & Coordination" },
      { name: "ESCALATION", label: "Escalation Handling" },
    ].map((s) =>
      prisma.skillTag.upsert({
        where: { name: s.name },
        update: {},
        create: s,
      })
    )
  );

  const skillMap = Object.fromEntries(skills.map((s) => [s.name, s.id]));
  console.log("  ✔  Skill tags:", skills.map((s) => s.name).join(", "));

  // ── 2. Task types + checklist templates ──────────────────────────
  const taskTypes = [
    {
      name: "HSC_CONFIRM_BOOKING",
      label: "Confirm Booking",
      checklistItems: [
        { stepOrder: 1, stepText: "Call patient to confirm appointment time", isRequired: true },
        { stepOrder: 2, stepText: "Verify patient address and any access instructions", isRequired: true },
        { stepOrder: 3, stepText: "Confirm test list with patient", isRequired: true },
        { stepOrder: 4, stepText: "Update confirmation in LabStack", isRequired: false },
      ],
    },
    {
      name: "HSC_ASSIGN_PHLEBO",
      label: "Assign Phlebotomist",
      checklistItems: [
        { stepOrder: 1, stepText: "Check available phlebotomists for the time slot", isRequired: true },
        { stepOrder: 2, stepText: "Assign phlebotomist in LabStack", isRequired: true },
        { stepOrder: 3, stepText: "Share appointment details with phlebotomist on WhatsApp", isRequired: true },
      ],
    },
    {
      name: "HSC_PHLEBO_DISPATCH",
      label: "Phlebo Dispatch Check",
      checklistItems: [
        { stepOrder: 1, stepText: "Confirm phlebotomist has left for patient location", isRequired: true },
        { stepOrder: 2, stepText: "Verify phlebotomist has kit (vacutainers, gloves, forms)", isRequired: true },
        { stepOrder: 3, stepText: "Mark order as PHLEBO_DISPATCHED in LabStack", isRequired: false },
      ],
    },
    {
      name: "HSC_SAMPLE_COLLECTED",
      label: "Confirm Sample Collected",
      checklistItems: [
        { stepOrder: 1, stepText: "Confirm phlebotomist has collected sample from patient", isRequired: true },
        { stepOrder: 2, stepText: "Verify sample labels and tubes are correct", isRequired: true },
        { stepOrder: 3, stepText: "Mark order status as SAMPLE_COLLECTED in LabStack", isRequired: true },
      ],
    },
    {
      name: "HSC_SAMPLE_HANDOVER",
      label: "Sample Handover to Lab",
      checklistItems: [
        { stepOrder: 1, stepText: "Confirm phlebotomist is en route to lab / drop point", isRequired: true },
        { stepOrder: 2, stepText: "Verify estimated drop time", isRequired: true },
        { stepOrder: 3, stepText: "Notify lab reception of incoming samples", isRequired: false },
      ],
    },
    {
      name: "HSC_PATIENT_MISSED",
      label: "Patient Not Available Follow-up",
      checklistItems: [
        { stepOrder: 1, stepText: "Call patient to check availability for reschedule", isRequired: true },
        { stepOrder: 2, stepText: "Offer at least 2 alternative slots", isRequired: true },
        { stepOrder: 3, stepText: "Update LabStack order with reschedule or PATIENT_MISSED status", isRequired: true },
      ],
    },
    {
      name: "HSC_STALE_FOLLOWUP",
      label: "Stale Order Follow-up",
      checklistItems: [
        { stepOrder: 1, stepText: "Review order notes and last status", isRequired: true },
        { stepOrder: 2, stepText: "Contact patient or phlebotomist for status update", isRequired: true },
        { stepOrder: 3, stepText: "Escalate to Ops Head if unresolved after call", isRequired: false },
      ],
    },
    {
      name: "HSC_REPORT_FOLLOW",
      label: "Report Delivery Follow-up",
      checklistItems: [
        { stepOrder: 1, stepText: "Check if lab has processed and uploaded reports", isRequired: true },
        { stepOrder: 2, stepText: "Share report link / PDF with patient on WhatsApp", isRequired: true },
        { stepOrder: 3, stepText: "Mark order as REPORT_DELIVERED in LabStack", isRequired: true },
      ],
    },
  ];

  const taskTypeMap: Record<string, number> = {};
  for (const tt of taskTypes) {
    const record = await prisma.taskType.upsert({
      where: { name: tt.name },
      update: { label: tt.label },
      create: {
        name: tt.name,
        label: tt.label,
        checklistItems: {
          create: tt.checklistItems,
        },
      },
      select: { id: true, name: true },
    });
    taskTypeMap[tt.name] = record.id;
  }
  console.log("  ✔  Task types seeded:", Object.keys(taskTypeMap).join(", "));

  // ── 3. Default escalation chain ──────────────────────────────────
  // Needs at least one user — we'll attach after admin user created.
  // Chain is created here; levels added after admin is seeded.

  // ── 4. Admin user ────────────────────────────────────────────────
  const adminPasswordHash = await hashPassword("changeme123");
  const admin = await prisma.user.upsert({
    where: { email: "admin@opsflow.local" },
    update: {},
    create: {
      name: "Ops Head",
      email: "admin@opsflow.local",
      passwordHash: adminPasswordHash,
      role: UserRole.OPS_HEAD,
      isActive: true,
    },
  });
  console.log(`  ✔  Admin user: admin@opsflow.local / changeme123 (id=${admin.id})`);

  // ── 5. Escalation chain ──────────────────────────────────────────
  const chain = await prisma.escalationChain.upsert({
    where: { name: "Default HSC Escalation" },
    update: {},
    create: {
      name: "Default HSC Escalation",
      levels: {
        create: [
          {
            levelNumber: 1,
            delayMinutes: 0,
            channelType: "IN_APP",
            notifyUserId: admin.id,
          },
          {
            levelNumber: 2,
            delayMinutes: 15,
            channelType: "WHATSAPP",
            notifyUserId: admin.id,
          },
        ],
      },
    },
    select: { id: true },
  });
  console.log(`  ✔  Escalation chain id=${chain.id}`);

  // ── 6. Task rules — 8 Home Sample Collection rules ───────────────
  /**
   * Rule design rationale:
   * R1. New booking (BOOKED) → confirm with patient within 30 min of creation
   * R2. Confirmed but no phlebo assigned 60 min before appointment → assign phlebo
   * R3. Appointment within 30 min, phlebo assigned but not dispatched → dispatch check
   * R4. Appointment passed >15 min ago, still PHLEBO_DISPATCHED → confirm sample collected
   * R5. SAMPLE_COLLECTED >30 min, no handover initiated → sample handover to lab
   * R6. PHLEBO_DISPATCHED but patient not reached (>45 min post-appt) → patient missed follow-up
   * R7. Any status stale for >120 min (stuck orders) → stale follow-up
   * R8. SAMPLE_COLLECTED for >4h without REPORT_DELIVERED → report follow-up
   */
  const rules = [
    {
      id: "hsc_r1_confirm_booking",
      name: "HSC: Confirm Booking (new order)",
      orderType: OrderType.HOME_SAMPLE,
      taskTypeName: "HSC_CONFIRM_BOOKING",
      titleTemplate: "Confirm booking — {{patientName}} (Order #{{orderId}})",
      slaMinutes: 30,
      priority: TaskPriority.HIGH,
      triggerType: "STATUS",
      triggerCondition: {
        statusIn: ["ORDER_SCHEDULED"],
      },
      skillNames: ["HOME_SAMPLE", "CUSTOMER_CARE"],
    },
    {
      id: "hsc_r2_assign_phlebo",
      name: "HSC: Assign Phlebotomist",
      orderType: OrderType.HOME_SAMPLE,
      taskTypeName: "HSC_ASSIGN_PHLEBO",
      titleTemplate: "Assign phlebo — {{patientName}} (Order #{{orderId}})",
      slaMinutes: 30,
      priority: TaskPriority.HIGH,
      triggerType: "STATUS",
      triggerCondition: {
        statusIn: ["ORDER_SCHEDULED", "PHLEBO_ASSIGNED"],
      },
      skillNames: ["HOME_SAMPLE", "LOGISTICS"],
    },
    {
      id: "hsc_r3_phlebo_dispatch",
      name: "HSC: Phlebo Dispatch Check",
      orderType: OrderType.HOME_SAMPLE,
      taskTypeName: "HSC_PHLEBO_DISPATCH",
      titleTemplate: "Dispatch check — {{phleboName}} → {{patientName}} (Order #{{orderId}})",
      slaMinutes: 20,
      priority: TaskPriority.URGENT,
      triggerType: "STATUS",
      triggerCondition: {
        statusIn: ["PHLEBO_ASSIGNED"],
      },
      skillNames: ["HOME_SAMPLE", "LOGISTICS"],
    },
    {
      id: "hsc_r4_confirm_collected",
      name: "HSC: Confirm Sample Collected (>15 min post-appt)",
      orderType: OrderType.HOME_SAMPLE,
      taskTypeName: "HSC_SAMPLE_COLLECTED",
      titleTemplate: "Confirm sample collected — {{patientName}} (Order #{{orderId}})",
      slaMinutes: 20,
      priority: TaskPriority.URGENT,
      triggerType: "TIME",
      triggerCondition: {
        statusIn: ["PHLEBO_ASSIGNED"],
        minutesAfterAppointment: 15,
      },
      skillNames: ["HOME_SAMPLE", "CUSTOMER_CARE"],
    },
    {
      id: "hsc_r5_sample_handover",
      name: "HSC: Sample Handover to Lab (>30 min after collection)",
      orderType: OrderType.HOME_SAMPLE,
      taskTypeName: "HSC_SAMPLE_HANDOVER",
      titleTemplate: "Sample handover — {{patientName}} → {{labName}} (Order #{{orderId}})",
      slaMinutes: 30,
      priority: TaskPriority.HIGH,
      triggerType: "TIME",
      triggerCondition: {
        statusIn: ["SAMPLE_COLLECTED"],
        minutesSinceStatusUpdated: 30,
      },
      skillNames: ["HOME_SAMPLE", "LOGISTICS"],
    },
    {
      id: "hsc_r6_patient_missed",
      name: "HSC: Patient Not Available Follow-up (>45 min post-appt)",
      orderType: OrderType.HOME_SAMPLE,
      taskTypeName: "HSC_PATIENT_MISSED",
      titleTemplate: "Patient not available — {{patientName}} (Order #{{orderId}})",
      slaMinutes: 30,
      priority: TaskPriority.HIGH,
      triggerType: "TIME",
      triggerCondition: {
        statusIn: ["PHLEBO_ASSIGNED"],
        minutesAfterAppointment: 45,
      },
      skillNames: ["CUSTOMER_CARE", "ESCALATION"],
    },
    {
      id: "hsc_r7_stale_order",
      name: "HSC: Stale Order Follow-up (>120 min same status)",
      orderType: OrderType.HOME_SAMPLE,
      taskTypeName: "HSC_STALE_FOLLOWUP",
      titleTemplate: "Stale order alert — {{patientName}} (Order #{{orderId}})",
      slaMinutes: 30,
      priority: TaskPriority.MEDIUM,
      triggerType: "TIME",
      triggerCondition: {
        statusIn: ["ORDER_SCHEDULED", "PHLEBO_ASSIGNED", "SAMPLE_COLLECTED"],
        minutesSinceStatusUpdated: 120,
      },
      skillNames: ["HOME_SAMPLE", "CUSTOMER_CARE"],
    },
    {
      id: "hsc_r8_report_followup",
      name: "HSC: Report Delivery Follow-up (>4h after sample collected)",
      orderType: OrderType.HOME_SAMPLE,
      taskTypeName: "HSC_REPORT_FOLLOW",
      titleTemplate: "Report follow-up — {{patientName}} (Order #{{orderId}})",
      slaMinutes: 45,
      priority: TaskPriority.MEDIUM,
      triggerType: "TIME",
      triggerCondition: {
        statusIn: ["SAMPLE_COLLECTED", "SAMPLE_DELIVERED"],
        minutesSinceStatusUpdated: 240,
      },
      skillNames: ["CUSTOMER_CARE"],
    },
  ];

  for (const rule of rules) {
    const typeId = taskTypeMap[rule.taskTypeName];
    if (!typeId) throw new Error(`Task type not found: ${rule.taskTypeName}`);

    await prisma.taskRule.upsert({
      where: { id: rule.id },
      update: {
        name: rule.name,
        titleTemplate: rule.titleTemplate,
        slaMinutes: rule.slaMinutes,
        priority: rule.priority,
        triggerType: rule.triggerType as any,
        triggerCondition: rule.triggerCondition,
        isActive: true,
        escalationChainId: chain.id,
      },
      create: {
        id: rule.id,
        name: rule.name,
        orderType: rule.orderType,
        taskTypeId: typeId,
        titleTemplate: rule.titleTemplate,
        slaMinutes: rule.slaMinutes,
        priority: rule.priority,
        triggerType: rule.triggerType as any,
        triggerCondition: rule.triggerCondition,
        isActive: true,
        escalationChainId: chain.id,
        requiredSkills: {
          create: rule.skillNames.map((sn) => ({
            skillTagId: skillMap[sn],
          })),
        },
      },
    });
  }

  console.log(`  ✔  ${rules.length} Home Sample Collection task rules seeded`);
  console.log("\n✅  Seed complete.\n");
  console.log("   Default login:  admin@opsflow.local / changeme123");
  console.log("   ⚠️   Change the password after first login!\n");
}

main()
  .catch((e) => {
    console.error("❌ Seed error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
