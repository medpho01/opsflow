/**
 * SLA Watcher — runs alongside the poller.
 * Scans all open tasks, marks SLA breaches, fires escalation alerts.
 * Also fires pending ESCALATION alerts whose fireAt time has passed.
 */
import prisma from "@/lib/db/client";
import { TaskStatus, AlertType } from "@prisma/client";
import { sendWhatsAppMessage, formatSlaBreachMessage } from "@/lib/alerts/whatsapp";

const WARNING_MINUTES = 10; // warn when ≤10 min remain

export async function runSlaWatcher(): Promise<void> {
  const now = new Date();
  const warningThreshold = new Date(now.getTime() + WARNING_MINUTES * 60_000);

  // ── 1. Mark newly breached tasks ──────────────────────────────────
  const breached = await prisma.task.findMany({
    where: {
      status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED, TaskStatus.BREACHED] },
      slaDeadline: { lt: now },
    },
    select: {
      id: true, escalationChainId: true, assignedToId: true,
      title: true, storeId: true, taskRuleId: true,
      entityId: true, orderType: true, slaDeadline: true,
    },
  });

  for (const task of breached) {
    await prisma.task.update({
      where: { id: task.id },
      data: { status: TaskStatus.BREACHED, slaBreachedAt: now },
    });

    await prisma.taskHistory.create({
      data: {
        taskId: task.id,
        status: TaskStatus.BREACHED,
        note: "SLA deadline passed — task auto-marked BREACHED by OpsFlow",
      },
    });

    const breachMinutes = task.slaDeadline
      ? Math.round((now.getTime() - task.slaDeadline.getTime()) / 60_000)
      : 0;

    await prisma.slaBreachLog.create({
      data: {
        taskId: task.id,
        taskRuleId: task.taskRuleId ?? "MANUAL",
        entityType: task.orderType ?? "UNKNOWN",
        entityId: task.entityId,
        assignedToId: task.assignedToId ?? null,
        slaDeadline: task.slaDeadline ?? now,
        breachedAt: now,
        breachMinutes,
      },
    });

    // Fire breach alert (in-app)
    await createAlert({
      taskId: task.id,
      alertType: AlertType.SLA_BREACHED,
      message: `SLA breached: "${task.title}"`,
    });

    // Send WhatsApp to Ops Head for every breach
    const opsHeads = await prisma.user.findMany({
      where: { role: "OPS_HEAD", isActive: true },
      select: { phone: true },
    });

    const assignedUser = task.assignedToId
      ? await prisma.user.findUnique({ where: { id: task.assignedToId }, select: { name: true } })
      : null;

    const taskMeta = await prisma.task.findUnique({
      where: { id: task.id },
      select: { entityId: true, metadata: true },
    });

    for (const head of opsHeads) {
      if (head.phone) {
        const waBody = formatSlaBreachMessage({
          taskTitle: task.title,
          orderId: taskMeta?.entityId ?? 0,
          patientName: (taskMeta?.metadata as Record<string, unknown>)?.patientName as string ?? "Patient",
          assignedTo: assignedUser?.name ?? null,
        });
        await sendWhatsAppMessage({ to: head.phone, body: waBody, taskId: task.id });
      }
    }

    // Kick off escalation chain (level 1)
    if (task.escalationChainId) {
      await triggerEscalationChain(task.id, task.escalationChainId, now);
    }
  }

  // ── 2. Create SLA_WARNING alerts for tasks nearing deadline ───────
  const nearingDeadline = await prisma.task.findMany({
    where: {
      status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED, TaskStatus.BREACHED] },
      slaDeadline: { gt: now, lte: warningThreshold },
      // avoid duplicate warnings: no WARNING alert in last 15 min
      alerts: {
        none: {
          alertType: AlertType.SLA_WARNING,
          createdAt: { gte: new Date(now.getTime() - 15 * 60_000) },
        },
      },
    },
    select: { id: true, title: true, storeId: true, slaDeadline: true },
  });

  for (const task of nearingDeadline) {
    const minLeft = Math.round((task.slaDeadline.getTime() - now.getTime()) / 60_000);
    await createAlert({
      taskId: task.id,
      alertType: AlertType.SLA_WARNING,
      message: `SLA warning: "${task.title}" — ${minLeft} min remaining`,
    });
  }

  // ── 3. Alert on long-unassigned tasks (>15 min old, no assignee) ──
  const unassigned = await prisma.task.findMany({
    where: {
      status: TaskStatus.CREATED,
      assignedToId: null,
      createdAt: { lt: new Date(now.getTime() - 15 * 60_000) },
      alerts: {
        none: {
          alertType: AlertType.TASK_UNASSIGNED,
          createdAt: { gte: new Date(now.getTime() - 30 * 60_000) },
        },
      },
    },
    select: { id: true, title: true, storeId: true },
  });

  for (const task of unassigned) {
    await createAlert({
      taskId: task.id,
      alertType: AlertType.TASK_UNASSIGNED,
      message: `Task unassigned for >15 min: "${task.title}"`,
    });
  }

  // ── 4. Fire pending ESCALATION alerts whose fireAt has passed ─────
  await firePendingEscalations(now);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createAlert(params: {
  taskId: number;
  alertType: AlertType;
  message: string;
}): Promise<void> {
  await prisma.alert.create({
    data: {
      taskId: params.taskId,
      alertType: params.alertType,
      severity: "HIGH",
      message: params.message,
      channel: "IN_APP",
      status: "PENDING",
    },
  });
}

async function triggerEscalationChain(
  taskId: number,
  chainId: number,
  breachedAt: Date
): Promise<void> {
  // Load level 1 of the chain
  const level = await prisma.escalationLevel.findFirst({
    where: { chainId, levelNumber: 1 },
    include: { notifyUser: { select: { id: true, name: true } } },
  });

  if (!level) return;

  const fireAt = new Date(breachedAt.getTime() + level.delayMinutes * 60_000);

  await prisma.alert.create({
    data: {
      taskId,
      alertType: AlertType.ESCALATION,
      severity: "URGENT",
      message: `Escalation L${level.levelNumber}: notify ${level.notifyUser.name}`,
      channel: "IN_APP",
      status: "PENDING",
      metadata: {
        escalationLevel: level.levelNumber,
        chainId,
        notifyUserId: level.notifyUserId,
        channelType: level.channelType,
        fireAt: fireAt.toISOString(),
      },
    },
  });
}

/**
 * Find ESCALATION alerts that haven't been sent yet and whose fireAt has passed.
 * Send WhatsApp (or mark as in-app delivered) and then schedule the next level.
 */
async function firePendingEscalations(now: Date): Promise<void> {
  const pending = await prisma.alert.findMany({
    where: {
      alertType: AlertType.ESCALATION,
      status: "PENDING",
    },
    include: {
      task: { select: { id: true, title: true, entityId: true, metadata: true, assignedToId: true } },
    },
    take: 20, // process at most 20 per cycle to avoid overload
  });

  for (const alert of pending) {
    const meta = alert.metadata as Record<string, unknown> | null;
    if (!meta) continue;

    const fireAt = meta.fireAt ? new Date(meta.fireAt as string) : null;
    if (!fireAt || fireAt > now) continue; // not due yet

    const channelType = meta.channelType as string ?? "IN_APP";
    const notifyUserId = meta.notifyUserId as number | null;
    const escalationLevel = meta.escalationLevel as number ?? 1;
    const chainId = meta.chainId as number | null;

    // Mark as sent
    await prisma.alert.update({
      where: { id: alert.id },
      data: { status: "SENT", sentAt: now },
    });

    // Deliver via WhatsApp if configured
    if (channelType === "WHATSAPP" && notifyUserId) {
      const notifyUser = await prisma.user.findUnique({
        where: { id: notifyUserId },
        select: { phone: true, name: true },
      });
      if (notifyUser?.phone && alert.task) {
        const msg = `🔴 *Escalation L${escalationLevel}* — Task: "${alert.task.title}" (Order #${alert.task.entityId}) is SLA breached and needs attention. — OpsFlow`;
        await sendWhatsAppMessage({
          to: notifyUser.phone,
          body: msg,
          taskId: alert.task.id,
        });
      }
    }

    // Schedule next escalation level
    if (chainId && alert.task) {
      const nextLevel = await prisma.escalationLevel.findFirst({
        where: { chainId, levelNumber: escalationLevel + 1 },
        include: { notifyUser: { select: { id: true, name: true } } },
      });

      if (nextLevel) {
        const nextFireAt = new Date(now.getTime() + nextLevel.delayMinutes * 60_000);
        await prisma.alert.create({
          data: {
            taskId: alert.task.id,
            alertType: AlertType.ESCALATION,
            severity: "URGENT",
            message: `Escalation L${nextLevel.levelNumber}: notify ${nextLevel.notifyUser.name}`,
            channel: "IN_APP",
            status: "PENDING",
            metadata: {
              escalationLevel: nextLevel.levelNumber,
              chainId,
              notifyUserId: nextLevel.notifyUserId,
              channelType: nextLevel.channelType,
              fireAt: nextFireAt.toISOString(),
            },
          },
        });
      }
    }
  }
}
