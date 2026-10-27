/**
 * Tasks for people (FR-10): an ordinary OpsFlow Task with an agent task type
 * and a typed payload — the order, what happened (evidence), the exact action,
 * a console link, a due time, and how the agent verifies it landed. Never
 * assigned to an individual: it goes to the shared queue.
 */
import { Prisma, TaskPriority, TaskStatus } from "@prisma/client";
import prisma from "@/lib/db/client";

export const AGENT_RULE_ID = "AGENT";

/** Task types the agents create. Seeded on first use; editable on Task Types afterwards. */
export const AGENT_TASK_TYPES: Record<string, { label: string; description: string; skill?: string; slaMinutes: number; priority: TaskPriority }> = {
  AGENT_RESCHEDULE: { label: "Reschedule in the console", description: "A store asked for a new slot; make the change in the console.", slaMinutes: 30, priority: TaskPriority.HIGH },
  AGENT_CANCEL: { label: "Cancel in the console", description: "A store asked to cancel; do it in the console.", slaMinutes: 30, priority: TaskPriority.HIGH },
  AGENT_ORDER_CHANGE: { label: "Change tests or package", description: "A store asked to add or change tests; edit the order in the console and tell the lab.", slaMinutes: 45, priority: TaskPriority.HIGH },
  AGENT_STATUS_WRITE: { label: "Update order status", description: "Evidence says the order moved; set the status in the console (until the write API exists).", slaMinutes: 15, priority: TaskPriority.HIGH },
  AGENT_REPORT_UPLOAD: { label: "Upload a report from the portal", description: "The report is only on the lab's portal; download and upload it with Extract with AI.", slaMinutes: 60, priority: TaskPriority.MEDIUM },
  AGENT_COLLECTION_STUCK: { label: "Collection stuck", description: "The lab has not answered up the ladder; decide: another lab, a call, or a new slot.", slaMinutes: 30, priority: TaskPriority.URGENT },
  AGENT_REPORT_STUCK: { label: "Report stuck", description: "Report past TAT and the lab is not answering.", slaMinutes: 60, priority: TaskPriority.HIGH },
  AGENT_LAB_CANNOT_FULFIL: { label: "Lab cannot do this order", description: "The lab says it cannot; find another lab or reschedule.", slaMinutes: 30, priority: TaskPriority.URGENT },
  AGENT_FIND_LAB: { label: "Assign a lab", description: "Still on the placeholder lab; assign a serviceable lab.", skill: "network", slaMinutes: 240, priority: TaskPriority.HIGH },
  AGENT_PLACEMENT_RETRY: { label: "Retry placement", description: "The console shows a placement error; retry with a new reference.", slaMinutes: 30, priority: TaskPriority.HIGH },
  AGENT_SERVICEABILITY: { label: "Serviceability check", description: "A store asked whether a pincode can be served.", skill: "network", slaMinutes: 120, priority: TaskPriority.MEDIUM },
  AGENT_NEW_BOOKING: { label: "New booking request", description: "A store asked for a booking in its group.", slaMinutes: 60, priority: TaskPriority.MEDIUM },
  AGENT_COMPLAINT: { label: "Complaint or RCA", description: "A store complained; the agent drafted the timeline and reply. A person sends it.", slaMinutes: 120, priority: TaskPriority.HIGH },
  AGENT_STORE_NO_RESPONSE: { label: "Store did not respond", description: "The store was alerted that the patient is unreachable and has not answered.", slaMinutes: 60, priority: TaskPriority.MEDIUM },
  AGENT_CONSOLE_UPDATE: { label: "Update the console", description: "A change was reported only in a message; the console needs it.", slaMinutes: 60, priority: TaskPriority.MEDIUM },
  AGENT_MANAGER_CALL: { label: "Call the lab manager", description: "Three asks unanswered; call the lab manager.", slaMinutes: 30, priority: TaskPriority.HIGH },
  AGENT_PORTAL_SIGNIN: { label: "Sign the lab portal back in", description: "The portal session expired; sign in from Controls.", slaMinutes: 60, priority: TaskPriority.MEDIUM },
};

export type AgentTaskPayload = {
  journeyId: string | null;
  cause: string;
  evidence: Array<{ kind: string; at?: string; text: string }>;
  action: string;
  consoleUrl?: string | null;
  verify?: { kind: "status_at_least" | "slot_equals" | "lab_not" | "lab_is_real" | "report_delivered" | "none"; value?: string | number | null };
  storeGroupJid?: string | null;
  labId?: number | null;
};

/** The order's page in the LabStack console: <base>/dashboard/orders/<id> (27 Oct 2026). */
export const consoleOrderUrl = (orderId: number): string | null => {
  const base = (process.env.LABSTACK_CONSOLE_URL || process.env.CONSOLE_BASE_URL || "").replace(/\/$/, "");
  if (!base) return null;
  return `${base}${base.endsWith("/dashboard") ? "" : "/dashboard"}/orders/${orderId}`;
};
const consoleUrl = consoleOrderUrl;

async function ensureAgentRule(taskTypeId: number) {
  const anchor = await prisma.dataSource.findFirst({ where: { isActive: true }, select: { id: true } }) ?? await prisma.dataSource.findFirst({ select: { id: true } });
  if (!anchor) throw new Error("No data source configured; cannot create tasks");
  return prisma.taskRule.upsert({
    where: { id: AGENT_RULE_ID },
    create: { id: AGENT_RULE_ID, name: "OpsFlow Agents", dataSourceId: anchor.id, taskTypeId, titleTemplate: "{title}", slaMinutes: 60, priority: TaskPriority.MEDIUM, triggerCondition: {}, isActive: false },
    update: { dataSourceId: anchor.id },
  });
}

export async function ensureAgentTaskTypes(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const [name, def] of Object.entries(AGENT_TASK_TYPES)) {
    const row = await prisma.taskType.upsert({
      where: { name },
      create: { name, label: def.label, description: def.description, normalAgingMinutes: def.slaMinutes, warningAgingMinutes: Math.round(def.slaMinutes * 1.5), criticalAgingMinutes: def.slaMinutes * 2 },
      update: {},
      select: { id: true },
    });
    out.set(name, row.id);
  }
  return out;
}

export type CreateAgentTaskInput = {
  orderId: number; orderType: string; storeId: number | null; type: keyof typeof AGENT_TASK_TYPES | string;
  title: string; payload: AgentTaskPayload; dueInMinutes?: number; appointmentTime?: Date | null; idemKey: string;
};

/** Create (or find) the task for this cause. Returns the task id. */
export async function createAgentTask(input: CreateAgentTaskInput): Promise<{ taskId: number; created: boolean }> {
  const existing = await prisma.task.findFirst({ where: { metadata: { path: ["agent", "idemKey"], equals: input.idemKey }, isArchived: false }, select: { id: true } });
  if (existing) return { taskId: existing.id, created: false };
  const def = AGENT_TASK_TYPES[input.type] ?? { label: input.type, description: "", slaMinutes: 60, priority: TaskPriority.MEDIUM };
  const types = await ensureAgentTaskTypes();
  const taskTypeId = types.get(input.type) ?? (await prisma.taskType.upsert({ where: { name: input.type }, create: { name: input.type, label: def.label }, update: {}, select: { id: true } })).id;
  await ensureAgentRule(taskTypeId);
  const slaMinutes = input.dueInMinutes ?? def.slaMinutes;
  // Task has one agent task per order (unique taskRuleId + entityId). A second request on the
  // same order joins the open task, or reopens a closed one — it never fails (25 Oct 2026).
  const sameOrder = await prisma.task.findFirst({ where: { taskRuleId: AGENT_RULE_ID, entityId: input.orderId }, select: { id: true, status: true, metadata: true } });
  if (sameOrder) {
    const open = !([TaskStatus.COMPLETED, TaskStatus.CANCELLED] as TaskStatus[]).includes(sameOrder.status);
    const previous = (sameOrder.metadata as { agent?: Record<string, unknown> } | null)?.agent ?? {};
    await prisma.task.update({
      where: { id: sameOrder.id },
      data: {
        taskTypeId, title: input.title, priority: def.priority, slaDeadline: new Date(Date.now() + slaMinutes * 60_000), appointmentTime: input.appointmentTime ?? null,
        ...(open ? {} : { status: TaskStatus.CREATED, completedAt: null, assignedToId: null, teamMemberId: null, assignedAt: null, assignmentMethod: null, isArchived: false }),
        metadata: { agent: { ...input.payload, idemKey: input.idemKey, consoleUrl: input.payload.consoleUrl ?? consoleUrl(input.orderId), type: input.type, previous: { type: previous.type, cause: previous.cause, idemKey: previous.idemKey } } } as Prisma.InputJsonValue,
        history: { create: { status: open ? sameOrder.status : TaskStatus.CREATED, note: `${open ? "Added" : "Reopened"} by OpsFlow Agents: ${input.payload.cause} — ${input.payload.action}` } },
      },
    });
    return { taskId: sameOrder.id, created: !open };
  }
  const task = await prisma.task.create({
    data: {
      taskRuleId: AGENT_RULE_ID, taskTypeId, title: input.title, entityType: "ORDER", entityId: input.orderId, storeId: input.storeId,
      orderType: input.orderType, priority: def.priority, status: TaskStatus.CREATED, slaDeadline: new Date(Date.now() + slaMinutes * 60_000),
      appointmentTime: input.appointmentTime ?? null,
      metadata: { agent: { ...input.payload, idemKey: input.idemKey, consoleUrl: input.payload.consoleUrl ?? consoleUrl(input.orderId), type: input.type } } as Prisma.InputJsonValue,
      history: { create: { status: TaskStatus.CREATED, note: `Created by OpsFlow Agents: ${input.payload.cause}` } },
    },
    select: { id: true },
  });
  // Never assigned to a person: agent tasks sit in the shared queue and whoever is on it picks
  // them up (decided 24 Oct 2026).
  return { taskId: task.id, created: true };
}

/** Tasks the agents created that are still open, for the inbox. */
export async function openAgentTasks(limit = 200) {
  return prisma.task.findMany({
    where: { taskRuleId: AGENT_RULE_ID, isArchived: false, status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
    orderBy: [{ slaDeadline: "asc" }], take: limit,
    select: { id: true, title: true, entityId: true, storeId: true, orderType: true, priority: true, status: true, assignedToId: true, slaDeadline: true, metadata: true, createdAt: true, taskType: { select: { name: true, label: true } }, assignedTo: { select: { id: true, name: true } } },
  });
}
