/**
 * Task Creator — evaluates TaskRules against a labstack order and creates
 * Task records in the taskos schema when trigger conditions are met.
 *
 * Deduplication: one open task per (ruleId, orderId) at any time.
 * Assignment: round-robin among active roster agents who have the required skills.
 */
import prisma from "@/lib/db/client";
import { RawOrder } from "./labstack";
import { TaskRuleWithRelations, TriggerCondition, CreateTaskPayload, MetadataCondition, MetadataOperator } from "@/types";
import { OrderType, TaskStatus, TaskPriority } from "@prisma/client";

// C1.4: Timezone support for SLA calculations
// All timestamps stored as UTC in database, but calculations use TIMEZONE
const TIMEZONE = process.env.TIMEZONE || "Asia/Kolkata";

// IST offset: Database stores naive timestamps in IST (UTC+5:30)
// JavaScript's new Date() interprets them as UTC, creating a 5.5-hour offset
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Corrects IST timestamps for JavaScript Date parsing.
 * Database stores naive timestamps in IST, but JavaScript interprets them as UTC.
 * This function subtracts the IST offset to get the correct UTC time.
 *
 * Usage: All timestamp comparisons in rule evaluation must use this.
 */
function correctISTTimestamp(timestamp: string | Date, debug: boolean = false): Date {
  const parsed = new Date(timestamp);
  const corrected = new Date(parsed.getTime() - IST_OFFSET_MS);
  if (debug) {
    console.log(`[DEBUG-TZ] Input: ${timestamp}, Parsed: ${parsed.toISOString()}, Corrected: ${corrected.toISOString()}`);
  }
  return corrected;
}

// ── Metadata Condition Evaluation (Phase 2) ───────────────────────────────────

/**
 * Evaluates all metadata conditions on an order.
 * ALL conditions must pass (AND logic).
 */
function evaluateMetadataConditions(
  order: RawOrder,
  conditions: MetadataCondition[] | undefined,
  now: Date
): boolean {
  if (!conditions || conditions.length === 0) {
    return true; // No metadata conditions = pass
  }

  // ALL metadata conditions must pass (AND logic)
  return conditions.every(cond => evaluateMetadataCondition(order, cond, now));
}

/**
 * Evaluates a single metadata condition.
 */
function evaluateMetadataCondition(
  order: RawOrder,
  condition: MetadataCondition,
  now: Date
): boolean {
  const { fieldPath, operator, value, offsetMinutes } = condition;

  // Get field value from order.metadata using dot notation
  const fieldValue = getNestedMetadataValue(order.metadata, fieldPath);

  switch (operator) {
    case "exists":
      return fieldValue !== undefined && fieldValue !== null;

    case "not_exists":
      return fieldValue === undefined || fieldValue === null;

    case "equals":
      return fieldValue === value;

    case "not_equals":
      return fieldValue !== value;

    case "contains":
      return typeof fieldValue === 'string' && fieldValue.includes(String(value));

    case "starts_with":
      return typeof fieldValue === 'string' && fieldValue.startsWith(String(value));

    case "ends_with":
      return typeof fieldValue === 'string' && fieldValue.endsWith(String(value));

    case ">":
    case ">=":
    case "<":
    case "<=": {
      // For timestamp comparison with offset
      if (offsetMinutes !== undefined && typeof fieldValue === 'string') {
        // fieldValue is ISO timestamp string (e.g., reportETA)
        try {
          const fieldTime = new Date(fieldValue).getTime();
          const offsetMs = offsetMinutes * 60_000;
          const thresholdTime = now.getTime() + offsetMs;

          switch (operator) {
            case ">":
              return fieldTime > thresholdTime;
            case ">=":
              return fieldTime >= thresholdTime;
            case "<":
              return fieldTime < thresholdTime;
            case "<=":
              return fieldTime <= thresholdTime;
          }
        } catch (e) {
          console.warn(`[MetadataEval] Failed to parse timestamp ${fieldValue}:`, e);
          return false;
        }
      }

      // For numeric comparison without offset
      const numValue = Number(value);
      const numField = Number(fieldValue);
      if (isNaN(numValue) || isNaN(numField)) return false;

      switch (operator) {
        case ">":
          return numField > numValue;
        case ">=":
          return numField >= numValue;
        case "<":
          return numField < numValue;
        case "<=":
          return numField <= numValue;
      }
    }

    default:
      console.warn(`[MetadataEval] Unknown operator: ${operator}`);
      return false;
  }
}

/**
 * Gets nested value from metadata object using dot notation.
 * Example: fieldPath "reportETA" → metadata.reportETA
 * Example: fieldPath "nested.field" → metadata.nested.field
 */
function getNestedMetadataValue(metadata: any, fieldPath: string): any {
  if (!metadata) return undefined;

  const parts = fieldPath.split('.');
  let value = metadata;

  for (const part of parts) {
    if (value && typeof value === 'object' && part in value) {
      value = value[part];
    } else {
      return undefined;
    }
  }

  return value;
}

// ── Trigger evaluation ────────────────────────────────────────────────────────

function evaluateTrigger(order: RawOrder, cond: TriggerCondition, now: Date): boolean {
  // 1. Order status must be in the allowed set
  if (!Array.isArray(cond.statusIn) || !cond.statusIn.includes(order.orderStatus)) {
    return false;
  }

  const msPerMin = 60_000;

  // All timestamps must be corrected for IST offset before comparison
  const isDebugOrder = order.id === 46251;
  const createdAt = correctISTTimestamp(order.createdAt, isDebugOrder);
  const statusUpdatedAt = correctISTTimestamp(order.statusUpdatedAt, isDebugOrder);
  const appointmentTime = correctISTTimestamp(order.appointmentTime, isDebugOrder);

  // 2. Age since created
  if (cond.minutesSinceCreated !== undefined) {
    const ageMin = (now.getTime() - createdAt.getTime()) / msPerMin;
    if (isDebugOrder) console.log(`[DEBUG-TZ] minutesSinceCreated: createdAt=${createdAt.toISOString()}, now=${now.toISOString()}, ageMin=${ageMin.toFixed(1)}`);
    if (ageMin < cond.minutesSinceCreated) return false;
  }

  // 3. Age since last status change
  if (cond.minutesSinceStatusUpdated !== undefined) {
    const staleMin = (now.getTime() - statusUpdatedAt.getTime()) / msPerMin;
    if (isDebugOrder) console.log(`[DEBUG-TZ] minutesSinceStatusUpdated: statusUpdatedAt=${statusUpdatedAt.toISOString()}, now=${now.toISOString()}, staleMin=${staleMin.toFixed(1)}`);
    if (staleMin < cond.minutesSinceStatusUpdated) return false;
  }

  // 4. Time before appointment
  if (cond.minutesBeforeAppointment !== undefined) {
    const minBefore = (appointmentTime.getTime() - now.getTime()) / msPerMin;
    // trigger fires when window <= minutesBeforeAppointment and not past appt
    if (minBefore > cond.minutesBeforeAppointment || minBefore < 0) return false;
  }

  // 5. Time after appointment
  if (cond.minutesAfterAppointment !== undefined) {
    const minAfter = (now.getTime() - appointmentTime.getTime()) / msPerMin;
    if (minAfter < cond.minutesAfterAppointment) return false;
  }

  // NEW P2: Metadata conditions
  if (!evaluateMetadataConditions(order, cond.metadataConditions, now)) {
    return false;
  }

  return true;
}

// ── Deduplication ─────────────────────────────────────────────────────────────

async function isDuplicate(ruleId: string, orderId: number): Promise<boolean> {
  const existing = await prisma.task.findFirst({
    where: {
      taskRuleId: ruleId,
      entityId: orderId,
      isArchived: false,
    },
    select: { id: true },
  });
  return existing !== null;
}

// ── Assignment engine ─────────────────────────────────────────────────────────

async function checkOrderTypeAllocations(orderType: OrderType): Promise<boolean> {
  const count = await prisma.teamMemberOrderType.count({
    where: { orderType },
  });
  return count > 0;
}

async function applyRoundRobin(
  orderType: OrderType,
  candidates: Array<{ userId: number; teamMemberId: number }>
): Promise<number> {
  // Get current round-robin state
  let state = await prisma.roundRobinState.findUnique({
    where: { orderType },
  });

  const candidateIds = candidates.map((c) => c.userId);

  // If no state, create it and return first candidate
  if (!state) {
    await prisma.roundRobinState.create({
      data: {
        orderType,
        lastAssignedMemberId: candidates[0].teamMemberId,
      },
    });
    return candidates[0].userId;
  }

  // Find next in rotation
  const currentIndex = candidateIds.indexOf(state.lastAssignedMemberId || -1);
  const nextIndex =
    currentIndex === -1 ? 0 : (currentIndex + 1) % candidateIds.length;

  // Update state with new selection
  const nextCandidate = candidates[nextIndex];
  await prisma.roundRobinState.upsert({
    where: { orderType },
    update: {
      lastAssignedMemberId: nextCandidate.teamMemberId,
      lastUpdatedAt: new Date(),
    },
    create: {
      orderType,
      lastAssignedMemberId: nextCandidate.teamMemberId,
    },
  });

  return nextCandidate.userId;
}

async function pickAssignee(
  requiredSkillIds: number[],
  storeId: number | null,
  orderType: OrderType
): Promise<number | null> {
  try {
    // Check if this order type has any allocations
    const allocationsExist = await checkOrderTypeAllocations(orderType);

    // Load all agents on today's active roster
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const rosterEntries = await prisma.dailyRoster.findMany({
      where: {
        date: { gte: today, lt: tomorrow },
        status: { in: ["ACTIVE", "ON_FIELD"] },
        member: {
          user: { isActive: true, role: "OPS_AGENT" },
          ...(storeId !== null
            ? { storeAssignments: { some: { storeId } } }
            : {}),
          ...(requiredSkillIds.length > 0
            ? { skills: { some: { skillTagId: { in: requiredSkillIds } } } }
            : {}),
        },
      },
      include: {
        member: {
          include: {
            user: { select: { id: true } },
            orderTypes: true,
            _count: {
              select: {
                assignedTasks: {
                  where: { status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
                },
              },
            },
          },
        },
      },
      orderBy: { member: { user: { id: "asc" } } },
    });

    if (rosterEntries.length === 0) {
      console.warn(
        `No eligible members for orderType=${orderType}, skills=${requiredSkillIds.join(",")}`
      );
      return null;
    }

    // Filter by order type allocation (if allocations exist for this type)
    let eligibleEntries = rosterEntries;
    if (allocationsExist) {
      eligibleEntries = rosterEntries.filter((entry) =>
        entry.member.orderTypes.some((ot) => ot.orderType === orderType)
      );

      if (eligibleEntries.length === 0) {
        console.warn(
          `No members with orderType ${orderType} assigned`,
          { orderType, requiredSkillIds, storeId }
        );
        return null;
      }
    }

    // Group by load and pick minimum load group
    const loadGroups = new Map<number, typeof eligibleEntries>();
    for (const entry of eligibleEntries) {
      const load = entry.member._count.assignedTasks;
      if (!loadGroups.has(load)) {
        loadGroups.set(load, []);
      }
      loadGroups.get(load)!.push(entry);
    }

    const minLoad = Math.min(...Array.from(loadGroups.keys()));
    const minLoadMembers = loadGroups.get(minLoad)!;

    let selected: typeof eligibleEntries[0];

    // Apply round-robin if multiple candidates at min load
    if (minLoadMembers.length > 1) {
      const candidates = minLoadMembers.map((m) => ({
        userId: m.member.user.id,
        teamMemberId: m.member.id,
      }));
      const selectedUserId = await applyRoundRobin(orderType, candidates);
      selected = minLoadMembers.find(
        (m) => m.member.user.id === selectedUserId
      )!;
    } else {
      selected = minLoadMembers[0];
    }

    console.info(`Task assigned to member ${selected.member.user.id} (load: ${minLoad})`, {
      orderType,
      memberId: selected.member.user.id,
      currentLoad: minLoad,
      totalCandidates: eligibleEntries.length,
      usedRoundRobin: minLoadMembers.length > 1,
    });

    return selected.member.user.id;
  } catch (error) {
    console.error(`Error in pickAssignee: ${error}`, {
      error,
      orderType,
      requiredSkillIds,
      storeId,
    });
    return null;
  }
}

// ── Core creator ──────────────────────────────────────────────────────────────

async function createTask(payload: CreateTaskPayload): Promise<void> {
  const {
    taskRuleId, taskTypeId, title, entityType, entityId,
    storeId, orderType, priority, slaDeadline, metadata, checklistSteps,
  } = payload;

  // Fetch required skills for this rule
  const ruleSkills = await prisma.taskRuleSkill.findMany({
    where: { taskRuleId },
    select: { skillTagId: true },
  });
  const skillIds = ruleSkills.map((r) => r.skillTagId);

  const assigneeId = await pickAssignee(skillIds, storeId, orderType);

  const now = new Date();
  const task = await prisma.task.create({
    data: {
      taskRuleId,
      taskTypeId,
      title,
      entityType,
      entityId,
      storeId,
      orderType,
      priority,
      slaDeadline,
      metadata: metadata as Parameters<typeof prisma.task.create>[0]["data"]["metadata"],
      status: TaskStatus.CREATED,
      assignedToId: assigneeId,
      assignedAt: assigneeId ? now : null,
      lastStatusUpdate: now,  // Phase 2: Track status change time for aging calculations
      assignmentMethod: "auto", // Phase 2: Mark as auto-assigned
      assignmentRuleId: taskRuleId, // Phase 2: Track which rule assigned it
      checklistItems: {
        create: checklistSteps.map((s) => ({
          stepOrder: s.stepOrder,
          stepText: s.stepText,
          isRequired: s.isRequired,
          isDone: false,
        })),
      },
      history: {
        create: {
          status: TaskStatus.CREATED,
          note: "Task auto-created by OpsFlow polling engine",
        },
      },
    },
  });

  // If assigned, add history entry
  if (assigneeId) {
    await prisma.taskHistory.create({
      data: {
        taskId: task.id,
        status: TaskStatus.ASSIGNED,
        changedById: assigneeId,
        note: `Auto-assigned by OpsFlow engine`,
      },
    });
    await prisma.task.update({
      where: { id: task.id },
      data: { status: TaskStatus.ASSIGNED },
    });
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function evaluateAndCreateTasks(
  orders: RawOrder[],
  rules: TaskRuleWithRelations[]
): Promise<{ created: number; skipped: number }> {
  const now = new Date();
  let created = 0;
  let skipped = 0;
  const msPerDay = 24 * 60 * 60 * 1000;
  const maxOrderAgeDays = 10;

  for (const order of orders) {
    // Skip very old orders (appointment 10+ days past) - prevent creating tasks for stale orders
    // Correct for IST timezone offset before calculation
    const appointmentMs = correctISTTimestamp(order.appointmentTime).getTime();
    const daysOld = (now.getTime() - appointmentMs) / msPerDay;
    if (daysOld > maxOrderAgeDays) {
      skipped++;
      continue;
    }

    for (const rule of rules) {
      // Order type guard
      if (rule.orderType !== order.orderType) {
        continue;
      }

      if (!rule.isActive) {
        continue;
      }

      const cond = rule.triggerCondition as TriggerCondition;

      // Validate trigger condition structure
      if (!cond || typeof cond !== 'object') {
        console.warn(`[TaskCreator] Rule ${rule.id} has invalid trigger condition:`, cond);
        skipped++;
        continue;
      }

      // Handle STATUS vs TIME-triggered rules differently
      const triggerType = rule.triggerType ?? "TIME";
      let shouldCreate = false;

      if (triggerType === "STATUS") {
        // STATUS-triggered: Create only if status matches (no time checks)
        if (Array.isArray(cond.statusIn) && cond.statusIn.includes(order.orderStatus)) {
          shouldCreate = true;
        }
      } else {
        // TIME-triggered: Check all conditions
        shouldCreate = evaluateTrigger(order, cond, now);
      }

      if (order.id === 46251 && rule.id === 'hsc_r4_confirm_collected') {
        console.log(`[DEBUG] Order ${order.id}, Rule ${rule.id}: shouldCreate=${shouldCreate}`);
      }

      if (!shouldCreate) {
        skipped++;
        continue;
      }

      // Deduplication: prevent creating multiple tasks for the same (ruleId, orderId)
      const isDup = await isDuplicate(rule.id, order.id);
      if (isDup) {
        if (order.id === 46251 && rule.id === 'hsc_r4_confirm_collected') {
          console.log(`[DEBUG] Order ${order.id}, Rule ${rule.id}: DUPLICATE - not creating`);
        }
        skipped++;
        continue;
      }

      const slaDeadline = new Date(now.getTime() + rule.slaMinutes * 60_000);

      const title = rule.titleTemplate
        .replace("{{patientName}}", order.patientName ?? "Patient")
        .replace("{{orderId}}", String(order.id))
        .replace("{{storeName}}", order.storeName ?? "")
        .replace("{{labName}}", order.labName ?? "")
        .replace("{{phleboName}}", order.phleboName ?? "");

      const payload: CreateTaskPayload = {
        taskRuleId: rule.id,
        taskTypeId: rule.taskTypeId,
        title,
        entityType: "ORDER",
        entityId: order.id,
        storeId: order.storeId,
        orderType: order.orderType as OrderType,
        priority: rule.priority,
        slaDeadline,
        metadata: {
          orderId: order.id,
          orderStatus: order.orderStatus,
          appointmentTime: order.appointmentTime,
          patientName: order.patientName,
          labName: order.labName,
          storeName: order.storeName,
          phleboName: order.phleboName,
          phleboNumber: order.phleboNumber,
        },
        checklistSteps: rule.taskType.checklistItems.map((ci) => ({
          stepOrder: ci.stepOrder,
          stepText: ci.stepText,
          isRequired: ci.isRequired,
        })),
      };

      await createTask(payload);
      created++;
    }
  }

  return { created, skipped };
}

// ── Active rules loader ───────────────────────────────────────────────────────

export async function loadActiveRules(): Promise<TaskRuleWithRelations[]> {
  const rules = await prisma.taskRule.findMany({
    where: { isActive: true },
    include: {
      requiredSkills: {
        include: { skillTag: { select: { name: true } } },
      },
      taskType: {
        include: {
          checklistItems: {
            orderBy: { stepOrder: "asc" },
          },
        },
      },
    },
  });

  const mapped = rules.map((r) => ({
    ...r,
    triggerType: (r as any).triggerType as "STATUS" | "TIME" ?? "TIME",
    triggerCondition: r.triggerCondition as unknown as TriggerCondition,
  })) as TaskRuleWithRelations[];

  // Debug logging
  const rule5 = mapped.find(r => r.id === 'hsc_r5_sample_handover');
  if (rule5) {
    console.log(`[DEBUG-RULES] R5 loaded. triggerCondition:`, JSON.stringify(rule5.triggerCondition));
  }

  return mapped;
}

// ── Archive obsolete tasks ────────────────────────────────────────────────────

/**
 * Archive tasks for very old orders only
 *
 * Archive Criteria:
 * - Order appointment is 10+ days in the past
 *
 * NOTE: We do NOT archive based on status condition changes.
 * If an order transitions between statuses (e.g., ORDER_SCHEDULED → PHLEBO_ASSIGNED),
 * existing tasks remain active for audit trail and historical reference.
 * Manual archival is available via the API if needed.
 */
export async function archiveObsoleteTasks(
  orders: RawOrder[],
  rules: TaskRuleWithRelations[]
): Promise<number> {
  const now = new Date();
  let archived = 0;
  const msPerDay = 24 * 60 * 60 * 1000;
  const maxOrderAgeDays = 10;

  for (const order of orders) {
    // Check if appointment is very old (10+ days) - archive all tasks for very old orders
    // Correct for IST timezone offset before calculation
    const appointmentMs = correctISTTimestamp(order.appointmentTime).getTime();
    const daysOld = (now.getTime() - appointmentMs) / msPerDay;
    const isVeryOldOrder = daysOld > maxOrderAgeDays;

    // Get all non-completed tasks for this order
    const tasks = await prisma.task.findMany({
      where: {
        entityId: order.id,
        status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] },
        isArchived: false,
      },
      include: { taskRule: { select: { id: true, triggerType: true, triggerCondition: true } } },
    });

    for (const task of tasks) {
      // Only archive tasks for very old orders (appointment 10+ days past)
      // Do NOT archive based on status condition changes - those are legitimate task transitions
      if (isVeryOldOrder) {
        await prisma.task.update({
          where: { id: task.id },
          data: { isArchived: true },
        });
        archived++;
        console.log(`[TaskArchiver] Archived task ${task.id} (order: ${order.id}, reason: old order (${daysOld.toFixed(1)} days old))`);
      }
    }
  }

  return archived;
}
