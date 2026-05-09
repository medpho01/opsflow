/**
 * Seed Camps Data Source Configuration
 * This script configures the Camps table as a task source
 *
 * Usage:
 * npx ts-node src/lib/seed-camps-source.ts
 *
 * Or integrate into your seeding pipeline
 */

import prisma from "@/lib/db/client";

export async function seedCampsDataSource() {
  console.log("[SeedCamps] Starting Camps data source configuration...");

  try {
    // 1. Create DataSource for Camps
    const campsSource = await prisma.dataSource.upsert({
      where: { sourceId: "camps" },
      update: {
        isActive: true,
        displayName: "Medical Camps",
      },
      create: {
        sourceId: "camps",
        displayName: "Medical Camps",
        description: "Medical vaccination and health camps",
        tableReference: "public.camps",
        primaryKeyField: "id",
        typeFieldName: "campType",
        statusFieldName: "campStatus",
        queryTemplate: `
          SELECT
            id,
            camp_type as "campType",
            camp_status as "campStatus",
            camp_name,
            location,
            scheduled_date,
            expected_participants,
            created_at,
            updated_at
          FROM camps
          WHERE updated_at > $1
          ORDER BY created_at DESC
          LIMIT $2
        `,
        metadataFieldMapping: {
          campName: "camp_name",
          location: "location",
          scheduledDate: "scheduled_date",
          expectedParticipants: "expected_participants",
        } as any,
        pollingType: "DATABASE",
        pollingIntervalMinutes: 5,
        isActive: true,
        syncStrategy: "NONE",
        backfillEnabled: false,
        backfillDays: 7,
        createdById: 1, // Assuming admin user ID = 1
      },
    });

    console.log(`[SeedCamps] ✓ Data source created/updated: ${campsSource.sourceId}`);

    // 2. Get or create a task type for camps
    const taskType = await prisma.taskType.upsert({
      where: { name: "CAMPS_TASK" },
      update: {},
      create: {
        name: "CAMPS_TASK",
        label: "Camp Task",
        description: "Task for medical camp operations",
        normalAgingMinutes: 30,
        warningAgingMinutes: 45,
        criticalAgingMinutes: 60,
      },
    });

    console.log(`[SeedCamps] ✓ Task type created: ${taskType.name}`);

    // 3. Create task rules scoped to Camps
    // Rule 1: New Camps need setup tasks
    const setupRule = await prisma.taskRule.upsert({
      where: { id: "camps-setup-rule" },
      update: {
        isActive: true,
      },
      create: {
        id: "camps-setup-rule",
        name: "Camp Setup - New Registration",
        dataSourceId: campsSource.id,
        taskTypeId: taskType.id,
        titleTemplate: "Set up camp: {campName} in {location}",
        slaMinutes: 240, // 4 hours to set up
        priority: "HIGH",
        triggerType: "STATUS",
        triggerCondition: {
          statuses: ["REGISTERED", "CREATED"],
        },
        isActive: true,
      },
    });

    const setupRuleScope = await prisma.taskRuleSourceScope.upsert({
      where: {
        taskRuleId_dataSourceId: {
          taskRuleId: setupRule.id,
          dataSourceId: campsSource.id,
        },
      },
      update: {
        isActive: true,
      },
      create: {
        taskRuleId: setupRule.id,
        dataSourceId: campsSource.id,
        allowedTypes: ["VACCINATION", "HEALTH_SCREENING", "AWARENESS"],
        allowedStatuses: ["REGISTERED", "CREATED"],
        assignmentStrategy: "geo_based", // Assign to agents near the camp location
        slaMinutesOverride: 240,
        isActive: true,
        createdById: 1,
      },
    });

    console.log(`[SeedCamps] ✓ Setup task rule created and scoped to Camps`);

    // Rule 2: Camps need resource verification
    const resourceRule = await prisma.taskRule.upsert({
      where: { id: "camps-resources-rule" },
      update: {
        isActive: true,
      },
      create: {
        id: "camps-resources-rule",
        name: "Camp Resources - Verification",
        dataSourceId: campsSource.id,
        taskTypeId: taskType.id,
        titleTemplate: "Verify resources for camp: {campName}",
        slaMinutes: 180, // 3 hours
        priority: "MEDIUM",
        triggerType: "STATUS",
        triggerCondition: {
          statuses: ["SCHEDULED"],
        },
        isActive: true,
      },
    });

    const resourceRuleScope = await prisma.taskRuleSourceScope.upsert({
      where: {
        taskRuleId_dataSourceId: {
          taskRuleId: resourceRule.id,
          dataSourceId: campsSource.id,
        },
      },
      update: {
        isActive: true,
      },
      create: {
        taskRuleId: resourceRule.id,
        dataSourceId: campsSource.id,
        allowedTypes: ["VACCINATION", "HEALTH_SCREENING"],
        allowedStatuses: ["SCHEDULED"],
        assignmentStrategy: "round_robin", // Rotate among available agents
        slaMinutesOverride: 180,
        isActive: true,
        createdById: 1,
      },
    });

    console.log(`[SeedCamps] ✓ Resources task rule created and scoped to Camps`);

    // Rule 3: Camps post-event reporting
    const reportingRule = await prisma.taskRule.upsert({
      where: { id: "camps-reporting-rule" },
      update: {
        isActive: true,
      },
      create: {
        id: "camps-reporting-rule",
        name: "Camp Reporting - Post Event",
        dataSourceId: campsSource.id,
        taskTypeId: taskType.id,
        titleTemplate: "Report results from: {campName}",
        slaMinutes: 360, // 6 hours after camp ends
        priority: "LOW",
        triggerType: "STATUS",
        triggerCondition: {
          statuses: ["COMPLETED", "FINISHED"],
        },
        isActive: true,
      },
    });

    const reportingRuleScope = await prisma.taskRuleSourceScope.upsert({
      where: {
        taskRuleId_dataSourceId: {
          taskRuleId: reportingRule.id,
          dataSourceId: campsSource.id,
        },
      },
      update: {
        isActive: true,
      },
      create: {
        taskRuleId: reportingRule.id,
        dataSourceId: campsSource.id,
        allowedTypes: ["VACCINATION", "HEALTH_SCREENING", "AWARENESS"],
        allowedStatuses: ["COMPLETED", "FINISHED"],
        assignmentStrategy: "skill_based", // Assign to agents with reporting skills
        assignmentStrategyConfig: {
          requiredSkills: ["reporting", "data_entry"],
        } as any,
        slaMinutesOverride: 360,
        isActive: true,
        createdById: 1,
      },
    });

    console.log(`[SeedCamps] ✓ Reporting task rule created and scoped to Camps`);

    console.log("[SeedCamps] ✓✓✓ Camps data source fully configured!");
    console.log("[SeedCamps] Configuration summary:");
    console.log(`  - Data source: ${campsSource.sourceId}`);
    console.log(`  - Polling interval: ${campsSource.pollingIntervalMinutes} minutes`);
    console.log(`  - Task rules: 3 (Setup, Resources, Reporting)`);
    console.log("[SeedCamps] Camps will now be polled and create tasks automatically!");

    return {
      dataSource: campsSource,
      taskType,
      rules: [setupRule, resourceRule, reportingRule],
    };
  } catch (error) {
    console.error("[SeedCamps] Error seeding Camps data source:", error);
    throw error;
  }
}

// Run if executed directly
if (require.main === module) {
  seedCampsDataSource()
    .then(() => {
      console.log("[SeedCamps] Done!");
      process.exit(0);
    })
    .catch((err) => {
      console.error("[SeedCamps] Failed:", err);
      process.exit(1);
    });
}
