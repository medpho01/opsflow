/**
 * The Brain's monitor (FR-4.4, FR-4.9): every 30 minutes in working hours,
 * deterministic checks over the journeys, the tasks, the outbox and the
 * review decisions. No model call unless a check trips and needs a diagnosis
 * (Phase 5: brain/diagnose.ts). Findings land in agent_brain_runs and, where
 * the rule says so, act: pause a desk whose overrides pass 2% in a week.
 */
import prisma from "@/lib/db/client";
import { TaskStatus } from "@prisma/client";
import { AGENT_RULE_ID } from "../executors/tasks";
import { loadDirectory } from "../directory";

export type Finding = { kind: string; severity: "INFO" | "WARN" | "ALERT"; scope: string; text: string; data?: Record<string, unknown> };

const H = 3_600_000;

export async function monitorFindings(now = new Date()): Promise<Finding[]> {
  const findings: Finding[] = [];
  const dir = await loadDirectory();
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: process.env.TIMEZONE || "Asia/Kolkata" }).format(now));

  // 1. A lab silent for 30 min at peak while it has open asks (FR-4.9).
  if (hour >= 6 && hour < 11) {
    const openAsks = await prisma.agentOutboxItem.groupBy({ by: ["counterparty"], where: { status: "SENT", sentAt: { gte: new Date(now.getTime() - 2 * H) } }, _count: { _all: true } });
    for (const g of openAsks) {
      if (!g.counterparty.startsWith("LAB:")) continue;
      const labId = Number(g.counterparty.slice(4));
      const lab = dir.labs.get(labId);
      if (!lab?.groupId) continue;
      const last = await prisma.waMessage.findFirst({ where: { groupId: lab.groupId, direction: "IN", fromMe: false }, orderBy: { ts: "desc" }, select: { ts: true } });
      const silentMin = last ? (now.getTime() - last.ts.getTime()) / 60_000 : null;
      if (silentMin == null || silentMin >= 30) findings.push({ kind: "lab_silent_peak", severity: "ALERT", scope: `LAB:${labId}`, text: `${lab.labName} silent ${silentMin == null ? "all morning" : `${Math.round(silentMin)} min`} with ${g._count._all} asks open`, data: { labId, asks: g._count._all } });
    }
  }

  // 2. Breach spike: breached journeys now vs the same hour over the last 7 days.
  const breached = await prisma.agentJourney.count({ where: { closedAt: null, health: "BREACHED" } });
  const open = await prisma.agentJourney.count({ where: { closedAt: null } });
  if (open >= 20 && breached / open > 0.25) findings.push({ kind: "breach_spike", severity: "ALERT", scope: "ALL", text: `${breached} of ${open} open orders are past a checkpoint`, data: { breached, open } });

  // 3. Overdue agent tasks.
  const overdue = await prisma.task.count({ where: { taskRuleId: AGENT_RULE_ID, isArchived: false, status: { in: [TaskStatus.CREATED, TaskStatus.ASSIGNED, TaskStatus.IN_PROGRESS] }, slaDeadline: { lt: now } } });
  if (overdue > 0) findings.push({ kind: "tasks_overdue", severity: overdue >= 5 ? "ALERT" : "WARN", scope: "OPS", text: `${overdue} agent task${overdue === 1 ? "" : "s"} past due`, data: { overdue } });

  // 4. Override rate per desk this week: a person reversed or edited more than 2% of live actions → pause (FR-4.4).
  const since = new Date(now.getTime() - 7 * 24 * H);
  const decided = await prisma.agentReviewItem.groupBy({ by: ["desk", "decision"], where: { decidedAt: { gte: since } }, _count: { _all: true } });
  const reverted = await prisma.agentAction.groupBy({ by: ["desk"], where: { outcome: "REVERTED", createdAt: { gte: since } }, _count: { _all: true } });
  const executed = await prisma.agentAction.groupBy({ by: ["desk"], where: { outcome: "EXECUTED", createdAt: { gte: since } }, _count: { _all: true } });
  for (const e of executed) {
    const rev = reverted.find((r) => r.desk === e.desk)?._count._all ?? 0;
    const rate = e._count._all >= 50 ? rev / e._count._all : 0;
    if (rate > 0.02) findings.push({ kind: "override_rate", severity: "ALERT", scope: `DESK:${e.desk}`, text: `${e.desk} desk: ${(rate * 100).toFixed(1)}% of live actions reverted this week`, data: { desk: e.desk, reverted: rev, executed: e._count._all } });
  }
  void decided;

  // 5. Outbox held back by caps or failures.
  const failed = await prisma.agentOutboxItem.count({ where: { status: "FAILED", createdAt: { gte: new Date(now.getTime() - 2 * H) } } });
  if (failed) findings.push({ kind: "dispatch_failed", severity: "ALERT", scope: "DISPATCH", text: `${failed} messages failed to send in the last 2 h`, data: { failed } });

  // 6. Gateway down.
  const gateway = await prisma.waGateway.findUnique({ where: { id: "default" }, select: { status: true, lastSeenAt: true } });
  if (gateway && gateway.lastSeenAt && now.getTime() - gateway.lastSeenAt.getTime() > 5 * 60_000) findings.push({ kind: "gateway_down", severity: "ALERT", scope: "WHATSAPP", text: `WhatsApp gateway last seen ${Math.round((now.getTime() - gateway.lastSeenAt.getTime()) / 60_000)} min ago (${gateway.status})` });

  return findings;
}

export async function runMonitor(now = new Date()): Promise<Record<string, number>> {
  const run = await prisma.agentBrainRun.create({ data: { kind: "monitor" }, select: { id: true } });
  try {
    const findings = await monitorFindings(now);
    let paused = 0;
    for (const f of findings) {
      if (f.kind === "override_rate" && f.data?.desk) {
        const settings = await prisma.agentSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
        if (!settings.pausedDesks.includes(String(f.data.desk))) {
          await prisma.agentSettings.update({ where: { id: "default" }, data: { pausedDesks: [...settings.pausedDesks, String(f.data.desk)] } });
          paused += 1;
        }
      }
    }
    await prisma.agentBrainRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), findings: findings as object[] } });
    return { findings: findings.length, alerts: findings.filter((f) => f.severity === "ALERT").length, paused };
  } catch (error) {
    await prisma.agentBrainRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), error: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}
