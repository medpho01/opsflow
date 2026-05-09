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
import { TaskStatus, TaskPriority } from "@prisma/client";
import { isAvailableNow, getUTCDayOfWeek } from "@/lib/roster/availability";
import { renderTitleTemplate } from "@/lib/templating/title";
import { triggerConditionSchema } from "@/lib/validation/task-rules";

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

// ── Comparison helpers for metadata operators ────────────────────────────────

/** Single source of truth for the >, >=, <, <= comparison itself. */
function compareNumbers(op: ">" | ">=" | "<" | "<=", a: number, b: number): boolean {
  switch (op) {
    case ">":  return a > b;
    case ">=": return a >= b;
    case "<":  return a < b;
    case "<=": return a <= b;
  }
}

/**
 * Heuristic: does `v` look like an ISO date or datetime string?
 * Matches "2026-01-01", "2026-01-01T10:00:00Z", "2026-01-01T10:00:00.000+05:30", etc.
 * Pure numbers ("123", "2026") return false so the numeric branch can handle them.
 */
function isIsoDateLike(v: unknown): boolean {
  if (typeof v !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return false;
  return !isNaN(Date.parse(v));
}

/** Coerce to a milliseconds-since-epoch number. NaN if it can't be parsed. */
function parseDateOrNaN(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") return Date.parse(v);
  if (typeof v === "number") return v;
  return NaN;
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
      // Three comparison modes, dispatched in order:
      //
      //   1. Timestamp-with-offset: caller set `offsetMinutes` and the field
      //      is a string (e.g. reportETA, appointmentTime). Compares the
      //      parsed date against `now + offsetMinutes`.
      //
      //   2. Date-vs-date: neither offsetMinutes nor a numeric `value` —
      //      both sides parse as valid dates AND at least one side LOOKS
      //      like an ISO date string (rather than just a parseable number).
      //      This is the case the audit's W1.6 was about — previously the
      //      code fell straight to the numeric branch and `Number("2026-01-01")`
      //      → NaN → silent false.
      //
      //   3. Numeric: both sides coerce to finite numbers.
      //
      // Anything else: return false rather than silently passing.

      // Mode 1: timestamp + offsetMinutes
      if (offsetMinutes !== undefined && typeof fieldValue === "string") {
        const fieldTime = Date.parse(fieldValue);
        if (isNaN(fieldTime)) {
          console.warn(`[MetadataEval] ${fieldPath}: not a parseable date: ${fieldValue}`);
          return false;
        }
        const thresholdTime = now.getTime() + offsetMinutes * 60_000;
        return compareNumbers(operator, fieldTime, thresholdTime);
      }

      // Mode 2: date-vs-date — at least one side is an ISO-shaped string.
      const fieldIsIsoLike = isIsoDateLike(fieldValue);
      const valueIsIsoLike = isIsoDateLike(value);
      if (fieldIsIsoLike || valueIsIsoLike) {
        const fieldTime = parseDateOrNaN(fieldValue);
        const valueTime = parseDateOrNaN(value);
        if (isNaN(fieldTime) || isNaN(valueTime)) {
          console.warn(`[MetadataEval] ${fieldPath}: date comparison failed (${typeof fieldValue}, ${typeof value})`);
          return false;
        }
        return compareNumbers(operator, fieldTime, valueTime);
      }

      // Mode 3: pure numeric.
      const numField = Number(fieldValue);
      const numValue = Number(value);
      if (!Number.isFinite(numField) || !Number.isFinite(numValue)) {
        return false;
      }
      return compareNumbers(operator, numField, numValue);
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
  const createdAt = correctISTTimestamp(order.createdAt);
  const statusUpdatedAt = correctISTTimestamp(order.statusUpdatedAt);
  const appointmentTime = correctISTTimestamp(order.appointmentTime);

  // 2. Age since created
  if (cond.minutesSinceCreated !== undefined) {
    const ageMin = (now.getTime() - createdAt.getTime()) / msPerMin;
    if (ageMin < cond.minutesSinceCreated) return false;
  }

  // 3. Age since last status change
  if (cond.minutesSinceStatusUpdated !== undefined) {
    const staleMin = (now.getTime() - statusUpdatedAt.getTime()) / msPerMin;
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

async function checkDataSourceCapabilities(dataSourceId: string): Promise<boolean> {
  const count = await prisma.teamMemberCapability.count({
    where: { dataSourceId },
  });
  return count > 0;
}

async function applyRoundRobin(
  dataSourceId: string,
  candidates: Array<{ userId: number; teamMemberId: number }>
): Promise<number> {
  // Get current round-robin state for this data source
  let state = await prisma.roundRobinState.findUnique({
    where: { dataSourceId },
  });

  // State tracks by teamMemberId — use that for rotation lookup
  const candidateTeamMemberIds = candidates.map((c) => c.teamMemberId);

  // If no state, create it and return first candidate
  if (!state) {
    await prisma.roundRobinState.create({
      data: {
        dataSourceId,
        lastAssignedMemberId: candidates[0].teamMemberId,
      },
    });
    return candidates[0].userId;
  }

  // Find next in rotation (compare teamMemberId to teamMemberId)
  const currentIndex = candidateTeamMemberIds.indexOf(state.lastAssignedMemberId || -1);
  const nextIndex =
    currentIndex === -1 ? 0 : (currentIndex + 1) % candidates.length;

  // Update state with new selection
  const nextCandidate = candidates[nextIndex];
  await prisma.roundRobinState.upsert({
    where: { dataSourceId },
    update: {
      lastAssignedMemberId: nextCandidate.teamMemberId,
    },
    create: {
      dataSourceId,
      lastAssignedMemberId: nextCandidate.teamMemberId,
    },
  });

  return nextCandidate.userId;
}

// W4.2 — assignment strategies. Names match the CHECK constraint on
// task_rules.assignmentStrategy.
type AssignmentStrategy = "default" | "round_robin" | "store_affinity" | "skill_based" | "least_loaded";

/**
 * Select only the least-loaded subset of candidates. Used as the inner
 * preference for strategies that want load-aware fairness, and as the
 * default behaviour when no strategy is selected.
 */
function leastLoaded<T extends { _count: { assignedTasks: number } }>(entries: T[]): T[] {
  if (entries.length === 0) return entries;
  const minLoad = Math.min(...entries.map((e) => e._count.assignedTasks));
  return entries.filter((e) => e._count.assignedTasks === minLoad);
}

async function pickAssignee(
  requiredSkillIds: number[],
  storeId: number | null,
  dataSourceId: string,
  strategy: AssignmentStrategy = "default"
): Promise<number | null> {
  try {
    // Check if this data source has any capability assignments
    const allocationsExist = await checkDataSourceCapabilities(dataSourceId);

    // Compute today's date range using local-date components (matches /api/team's
    // logic exactly so rosterStatus in the UI matches what the engine uses).
    // The server runs in IST; "today" must be the local-day view, anchored as a
    // UTC midnight so it lines up with PostgreSQL's DATE column representation.
    const now = new Date();
    const todayUTC = new Date(
      Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
    );
    const tomorrowUTC = new Date(todayUTC);
    tomorrowUTC.setUTCDate(tomorrowUTC.getUTCDate() + 1);
    const todayDayOfWeek = getUTCDayOfWeek(todayUTC);

    // Load all OPS_AGENT team members matching store + skill filters, with their
    // weekly schedule for today's day-of-week and any roster exception for today.
    // Availability is then derived in JS via computeRosterStatus() — same logic
    // used by GET /api/team for displaying rosterStatus.
    const candidateMembers = await prisma.teamMember.findMany({
      where: {
        isActive: true,
        user: { isActive: true, role: "OPS_AGENT" },
        ...(storeId !== null
          ? { storeAssignments: { some: { storeId } } }
          : {}),
        ...(requiredSkillIds.length > 0
          ? { skills: { some: { skillTagId: { in: requiredSkillIds } } } }
          : {}),
      },
      include: {
        user: { select: { id: true } },
        capabilities: { select: { dataSourceId: true } },
        // Loaded for strategies that look beyond load (skill_based,
        // store_affinity). The base query already filters by required skills
        // when present, but strategies that PREFER more matches still need
        // the full skill set.
        skills: { select: { skillTagId: true } },
        storeAssignments: { select: { storeId: true } },
        weeklySchedules: { where: { dayOfWeek: todayDayOfWeek } },
        rosterExceptions: {
          where: { date: { gte: todayUTC, lt: tomorrowUTC } },
          take: 1,
        },
        _count: {
          select: {
            assignedTasks: {
              where: { status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
            },
          },
        },
      },
      orderBy: { user: { id: "asc" } },
    });

    if (candidateMembers.length === 0) {
      console.warn(
        `[pickAssignee] No team members match filters (dataSourceId=${dataSourceId}, storeId=${storeId}, skills=${requiredSkillIds.join(",")})`
      );
      return null;
    }

    // Filter by current schedule/exception status (must be ACTIVE right now)
    let eligibleEntries = candidateMembers.filter((m) => {
      const schedule = m.weeklySchedules[0] ?? null;
      const exception = m.rosterExceptions[0] ?? null;
      return isAvailableNow(schedule, exception, now);
    });

    if (eligibleEntries.length === 0) {
      console.warn(
        `[pickAssignee] No members are currently ACTIVE per schedule/exception (dataSourceId=${dataSourceId}, storeId=${storeId})`
      );
      return null;
    }

    // Filter by data source capability (if assignments exist for this source)
    if (allocationsExist) {
      eligibleEntries = eligibleEntries.filter((m) =>
        m.capabilities.some((c) => c.dataSourceId === dataSourceId)
      );

      if (eligibleEntries.length === 0) {
        console.warn(
          `[pickAssignee] No ACTIVE members with dataSourceId=${dataSourceId} capability`,
          { dataSourceId, requiredSkillIds, storeId }
        );
        return null;
      }
    }

    // ── Strategy dispatch ─────────────────────────────────────────────────
    // Each strategy first NARROWS the candidate set (preference), then
    // hands the survivors to a deterministic tiebreaker (round-robin) so
    // identical states still produce a fair rotation. Falling back to the
    // full eligibleEntries when a strategy doesn't apply means an unlucky
    // configuration never starves a task.

    let preferred: typeof eligibleEntries;

    switch (strategy) {
      case "round_robin":
        // Pure rotation across all eligible. No load consideration.
        preferred = eligibleEntries;
        break;

      case "store_affinity": {
        // Prefer agents who own the order's store; fall through to all
        // eligible if no perfect match exists (or if storeId is null).
        if (storeId === null) {
          preferred = eligibleEntries;
        } else {
          const affine = eligibleEntries.filter((m) =>
            m.storeAssignments.some((sa) => sa.storeId === storeId)
          );
          preferred = affine.length > 0 ? affine : eligibleEntries;
        }
        // Within store-affine candidates, pick least-loaded (busy phlebos
        // assigned to a store still get spread across the day's tasks).
        preferred = leastLoaded(preferred);
        break;
      }

      case "skill_based": {
        // Prefer agents with the MOST matching required skills. The base
        // query already filtered to ≥1 match when requiredSkillIds is set,
        // so this is a tie-resolver, not a gate.
        if (requiredSkillIds.length === 0) {
          preferred = eligibleEntries;
        } else {
          const requiredSet = new Set(requiredSkillIds);
          const scored = eligibleEntries.map((m) => ({
            m,
            matches: m.skills.filter((s) => requiredSet.has(s.skillTagId)).length,
          }));
          const maxMatches = Math.max(...scored.map((s) => s.matches));
          preferred = scored.filter((s) => s.matches === maxMatches).map((s) => s.m);
        }
        // Then least-loaded among the top-skill-match group.
        preferred = leastLoaded(preferred);
        break;
      }

      case "least_loaded":
      case "default":
      default:
        // The historical behaviour: pick the lowest current-load group,
        // then round-robin among ties. "default" and "least_loaded" are
        // identical semantically; the dropdown lists both so authors
        // coming from different mental models can find the right name.
        preferred = leastLoaded(eligibleEntries);
        break;
    }

    if (preferred.length === 0) {
      // Strategy filtered everything out — fall back to the full set so a
      // task is at least assigned, and warn so the operator can fix the
      // strategy config.
      console.warn(`[pickAssignee] Strategy "${strategy}" left zero candidates; falling back to least-loaded`);
      preferred = leastLoaded(eligibleEntries);
    }

    let selected: typeof eligibleEntries[0];
    if (preferred.length > 1) {
      const candidates = preferred.map((m) => ({ userId: m.user.id, teamMemberId: m.id }));
      const selectedUserId = await applyRoundRobin(dataSourceId, candidates);
      selected = preferred.find((m) => m.user.id === selectedUserId)!;
    } else {
      selected = preferred[0];
    }

    console.info(`[pickAssignee] strategy=${strategy} → user ${selected.user.id} (load: ${selected._count.assignedTasks})`, {
      dataSourceId,
      strategy,
      userId: selected.user.id,
      candidatePool: eligibleEntries.length,
      preferredPool: preferred.length,
    });

    return selected.user.id;
  } catch (error) {
    console.error(`[pickAssignee] Error storeId=${storeId} dsId=${dataSourceId}:`, error instanceof Error ? error.stack : String(error));
    return null;
  }
}

// ── Core creator ──────────────────────────────────────────────────────────────

async function createTask(payload: CreateTaskPayload): Promise<void> {
  const {
    taskRuleId, taskTypeId, title, entityType, entityId,
    storeId, orderType, dataSourceId, priority, slaDeadline, metadata, checklistSteps,
    assignmentStrategy,
  } = payload;

  // Fetch required skills for this rule
  const ruleSkills = await prisma.taskRuleSkill.findMany({
    where: { taskRuleId },
    select: { skillTagId: true },
  });
  const skillIds = ruleSkills.map((r) => r.skillTagId);

  const assigneeId = await pickAssignee(skillIds, storeId, dataSourceId, assignmentStrategy);

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
  // Don't create tasks for orders whose appointment is far in the future —
  // they don't need attention yet and would clutter the active queue.
  // Tasks become eligible once the appointment is within this window.
  const maxOrderFutureDays = 3;

  for (const order of orders) {
    // Correct for IST timezone offset before any time-based comparison.
    const appointmentMs = correctISTTimestamp(order.appointmentTime).getTime();
    const ageDays = (now.getTime() - appointmentMs) / msPerDay; // +ve = past, -ve = future

    // Skip very old orders (appointment 10+ days in the past)
    if (ageDays > maxOrderAgeDays) {
      skipped++;
      continue;
    }

    // Skip far-future orders — agents don't need to act on these yet.
    // Negative ageDays means appointment is in the future; flip the sign.
    if (-ageDays > maxOrderFutureDays) {
      skipped++;
      continue;
    }

    for (const rule of rules) {
      // Filter by allowed types (if any are specified)
      if (Array.isArray(rule.allowedTypes) && rule.allowedTypes.length > 0) {
        if (!rule.allowedTypes.includes(order.orderType)) {
          continue;
        }
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

      if (!shouldCreate) {
        skipped++;
        continue;
      }

      // Deduplication: prevent creating multiple tasks for the same (ruleId, orderId)
      const isDup = await isDuplicate(rule.id, order.id);
      if (isDup) {
        skipped++;
        continue;
      }

      const slaDeadline = new Date(now.getTime() + rule.slaMinutes * 60_000);

      // Use the shared, regex-based substituter — handles repeated tokens
      // (the inline `.replace(string, ...)` only swapped the first match)
      // and renders unknown placeholders as `[missing: key]` so a typo or
      // newly-added rule placeholder fails loudly instead of leaking
      // `{{patientName}}` into user-visible task titles + alert messages.
      const title = renderTitleTemplate(rule.titleTemplate, {
        patientName: order.patientName,
        orderId: order.id,
        storeName: order.storeName,
        labName: order.labName,
        phleboName: order.phleboName,
        appointmentTime: order.appointmentTime,
      });

      const payload: CreateTaskPayload = {
        taskRuleId: rule.id,
        taskTypeId: rule.taskTypeId,
        title,
        entityType: "ORDER",
        entityId: order.id,
        storeId: order.storeId,
        orderType: order.orderType,
        dataSourceId: rule.dataSourceId,
        // W4.2 — pass strategy down so pickAssignee can branch.
        assignmentStrategy: rule.assignmentStrategy as CreateTaskPayload["assignmentStrategy"],
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

  // Defensive load: if a rule has a malformed `triggerCondition` (legacy
  // row, direct DB write, etc.) the engine should skip it loudly rather
  // than crash mid-poll. zod-parse here so the rest of the file can rely
  // on the shape; field-by-field validation is the same one POST/PATCH use.
  const mapped = rules
    .map((r) => {
      const parsed = triggerConditionSchema.safeParse(r.triggerCondition);
      if (!parsed.success) {
        console.warn(
          `[loadActiveRules] Skipping rule '${r.name}' (id=${r.id}) — triggerCondition fails validation:`,
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        );
        return null;
      }
      return {
        ...r,
        // triggerType is now properly typed by Prisma (schema field
        // TaskRuleTriggerType @default(TIME)); no cast needed.
        triggerType: r.triggerType,
        triggerCondition: parsed.data as unknown as TriggerCondition,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null) as TaskRuleWithRelations[];

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
