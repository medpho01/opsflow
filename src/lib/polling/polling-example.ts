/**
 * Multi-Source Polling System - Example Usage
 * This file demonstrates how to use the polling system in practice
 */

import { getPollingEngine } from "./polling-engine";
import { initializePollingEngine } from "./init-polling-engine";
import { createDatabaseSourceHandler } from "./handlers/database-source-handler";
import { createTaskFromSourceEntity } from "@/lib/task-creation/create-task-service";
import { findMatchingRules, getAllMatchingRulesSorted } from "@/lib/task-creation/rule-matcher";
import prisma from "@/lib/db/client";

// ────────────────────────────────────────────────────────────────
// EXAMPLE 1: Initialize the polling engine at app startup
// ────────────────────────────────────────────────────────────────

export async function exampleInitializeEngine() {
  console.log("=== Example 1: Initialize Polling Engine ===");

  try {
    // Initialize with all registered sources
    await initializePollingEngine();
    console.log("✓ Polling engine initialized");

    // Validate all sources
    const validations = await getPollingEngine().validateAllSources();
    console.log("Validations:", validations);
  } catch (error) {
    console.error("Error:", error);
  }
}

// ────────────────────────────────────────────────────────────────
// EXAMPLE 2: Poll all sources and create tasks
// ────────────────────────────────────────────────────────────────

export async function examplePollAllSources() {
  console.log("\n=== Example 2: Poll All Sources ===");

  const engine = getPollingEngine();

  const results = await engine.pollAllActiveSources(
    async (entity, sourceId) => {
      console.log(`Processing entity ${entity.id} from source ${sourceId}`);

      // Find matching rules for this entity
      const rules = await findMatchingRules(sourceId, entity);

      if (rules.length === 0) {
        console.log(`  ⚠ No matching rules for entity ${entity.id}`);
        return null;
      }

      // Get source info for display name
      const dataSource = await prisma.dataSource.findUnique({
        where: { sourceId },
      });

      if (!dataSource) {
        console.log(`  ✗ Data source not found: ${sourceId}`);
        return null;
      }

      // Create task for each matching rule
      for (const rule of rules) {
        const result = await createTaskFromSourceEntity(
          sourceId,
          entity,
          rule,
          dataSource.displayName
        );

        if (result.success) {
          console.log(`  ✓ Created task #${result.taskId} from rule "${rule.ruleName}"`);
          return result.taskId;
        } else {
          console.log(`  ✗ Failed to create task: ${result.error}`);
        }
      }

      return null;
    }
  );

  console.log("\nPolling Summary:");
  for (const result of results) {
    console.log(`  ${result.sourceId}: ${result.tasksCreated} tasks created, ${result.tasksFailed} failed`);
  }
}

// ────────────────────────────────────────────────────────────────
// EXAMPLE 3: Poll a single source
// ────────────────────────────────────────────────────────────────

export async function examplePollSingleSource(sourceId: string) {
  console.log(`\n=== Example 3: Poll Single Source (${sourceId}) ===`);

  const engine = getPollingEngine();

  const result = await engine.pollSource(sourceId, async (entity, source) => {
    console.log(`  Entity: ID=${entity.id}, Type=${entity.type}, Status=${entity.status}`);

    // Get all matching rules and pick the highest priority
    const rules = await getAllMatchingRulesSorted(source, entity);

    if (rules.length === 0) {
      console.log(`    No matching rules`);
      return null;
    }

    const rule = rules[0];
    const dataSource = await prisma.dataSource.findUnique({
      where: { sourceId: source },
    });

    const result = await createTaskFromSourceEntity(
      source,
      entity,
      rule,
      dataSource!.displayName
    );

    console.log(`    Task created: ${result.success ? `#${result.taskId}` : "failed"}`);
    return result.taskId || null;
  });

  console.log("Result:", {
    status: result.status,
    entitiesFound: result.entitiesFound,
    tasksCreated: result.tasksCreated,
    duration: `${result.durationMs}ms`,
  });
}

// ────────────────────────────────────────────────────────────────
// EXAMPLE 4: Get polling status
// ────────────────────────────────────────────────────────────────

export async function exampleGetPollingStatus() {
  console.log("\n=== Example 4: Get Polling Status ===");

  const engine = getPollingEngine();
  const status = await engine.getPollingStatus();

  console.log("Active Sources:");
  for (const source of status) {
    console.log(`\n  ${source.sourceId}`);
    console.log(`    Handler: ${source.handler?.constructor.name}`);
    console.log(`    Polling: ${source.config?.isActive ? "Yes" : "No"}`);
    if (source.config) {
      console.log(`    Interval: ${source.config.intervalMinutes}m`);
    }

    if (source.lastPollResult) {
      console.log(`    Last Poll: ${source.lastPollResult.status}`);
      console.log(`      Entities: ${source.lastPollResult.entitiesFound}`);
      console.log(`      Tasks Created: ${source.lastPollResult.tasksCreated}`);
      console.log(`      Duration: ${source.lastPollResult.durationMs}ms`);
    }
  }
}

// ────────────────────────────────────────────────────────────────
// EXAMPLE 5: Register a new data source
// ────────────────────────────────────────────────────────────────

export async function exampleRegisterDataSource() {
  console.log("\n=== Example 5: Register New Data Source ===");

  const newSource = await prisma.dataSource.create({
    data: {
      sourceId: "custom-source",
      displayName: "Custom Data Source",
      description: "Example custom data source",
      tableReference: "public.custom_entities",
      primaryKeyField: "id",
      typeFieldName: "entity_type",
      statusFieldName: "entity_status",
      queryTemplate: "SELECT * FROM custom_entities WHERE updated_at > $1 LIMIT $2",
      pollingIntervalMinutes: 10,
      pollingType: "DATABASE",
      isActive: true,
      createdById: 1,
      metadataFieldMapping: {
        entityName: "name",
        entityDescription: "description",
      },
    },
  });

  console.log("✓ Data source created:", {
    id: newSource.id,
    sourceId: newSource.sourceId,
    displayName: newSource.displayName,
  });

  // Re-initialize engine to pick up new source
  await initializePollingEngine();
}

// ────────────────────────────────────────────────────────────────
// EXAMPLE 6: Create source-specific task rule
// ────────────────────────────────────────────────────────────────

export async function exampleCreateSourceSpecificRule() {
  console.log("\n=== Example 6: Create Source-Specific Task Rule ===");

  // Create a task rule (requires a valid dataSourceId)
  const anySource = await prisma.dataSource.findFirst({ select: { id: true } });
  const rule = await prisma.taskRule.create({
    data: {
      name: "New Appointment Check-in",
      dataSourceId: anySource!.id,
      taskTypeId: 1,
      titleTemplate: "Check-in: {patientName} with {doctorName}",
      slaMinutes: 120,
      priority: "HIGH",
      triggerType: "TIME",
      triggerCondition: {},
      isActive: true,
    },
  });

  console.log("✓ Task rule created:", rule.id);

  // Find the appointments data source
  const appointmentsSource = await prisma.dataSource.findUnique({
    where: { sourceId: "appointments" },
  });

  if (!appointmentsSource) {
    console.log("✗ Appointments source not found");
    return;
  }

  // Scope the rule to appointments source
  const scope = await prisma.taskRuleSourceScope.create({
    data: {
      taskRuleId: rule.id,
      dataSourceId: appointmentsSource.id,
      allowedTypes: ["CONSULTATION", "CHECKUP"],
      allowedStatuses: ["SCHEDULED", "CONFIRMED"],
      assignmentStrategy: "round_robin",
      slaMinutesOverride: 60,
      isActive: true,
      createdById: 1,
    },
  });

  console.log("✓ Rule scoped to source:", {
    ruleId: scope.taskRuleId,
    source: appointmentsSource.sourceId,
    allowedTypes: scope.allowedTypes,
    allowedStatuses: scope.allowedStatuses,
    slaOverride: scope.slaMinutesOverride,
  });
}

// ────────────────────────────────────────────────────────────────
// EXAMPLE 7: Test rule matching
// ────────────────────────────────────────────────────────────────

export async function exampleTestRuleMatching() {
  console.log("\n=== Example 7: Test Rule Matching ===");

  // Create a test entity
  const testEntity = {
    id: 999,
    type: "CONSULTATION",
    status: "SCHEDULED",
    metadata: {
      patientName: "John Doe",
      doctorName: "Dr. Smith",
    },
    createdAt: new Date(),
    modifiedAt: new Date(),
  };

  // Test matching against orders source
  console.log("Testing Orders Source:");
  const ordersRules = await findMatchingRules("orders", testEntity);
  console.log(`  Matching rules: ${ordersRules.length}`);
  ordersRules.forEach((rule) => {
    console.log(`    - ${rule.ruleName} (priority: ${rule.priority})`);
  });

  // Test matching against appointments source
  console.log("\nTesting Appointments Source:");
  const appointmentRules = await findMatchingRules("appointments", testEntity);
  console.log(`  Matching rules: ${appointmentRules.length}`);
  appointmentRules.forEach((rule) => {
    console.log(`    - ${rule.ruleName} (priority: ${rule.priority})`);
  });
}

// ────────────────────────────────────────────────────────────────
// EXAMPLE 8: Run polling on a schedule (using cron)
// ────────────────────────────────────────────────────────────────

export async function exampleScheduledPolling() {
  console.log("\n=== Example 8: Scheduled Polling ===");

  // This would be called by a cron job or scheduled task
  // Example using node-cron:
  // import cron from 'node-cron';
  // cron.schedule('*/5 * * * *', () => {
  //   examplePollAllSources().catch(console.error);
  // });

  console.log("To implement scheduled polling:");
  console.log("1. Use a cron library (node-cron) or task scheduler");
  console.log("2. Call examplePollAllSources() on your desired interval");
  console.log("3. Use data source polling intervals from database");
  console.log("4. Log all results for monitoring");
}

// ────────────────────────────────────────────────────────────────
// Run all examples
// ────────────────────────────────────────────────────────────────

export async function runAllExamples() {
  try {
    await exampleInitializeEngine();
    // Uncomment to run actual polling:
    // await examplePollAllSources();
    // await examplePollSingleSource("orders");
    // await exampleGetPollingStatus();
    // await exampleRegisterDataSource();
    // await exampleCreateSourceSpecificRule();
    // await exampleTestRuleMatching();
    await exampleScheduledPolling();
  } catch (error) {
    console.error("Error running examples:", error);
  }
}
