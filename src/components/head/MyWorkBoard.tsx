"use client";

/**
 * MyWorkBoard — Phase 1 of the new task surface.
 *
 * Three tabs:
 *   Today    — sliding NOW (next 90 min) + LATER TODAY (hour-subdivided) + DONE
 *              + a conditional TONIGHT'S PREP section (appears after 4 PM IST)
 *   Tomorrow — early-morning callout (appts before 10 AM) + day summary
 *   Stuck    — flat list filterable by Age (today/yesterday/older) and Type
 *
 * Bucket assignment (today / tomorrow / stuck) is computed server-side and
 * arrives on each task as `viewBucket`. The sub-sections inside Today are
 * computed client-side so they react to clock ticks without re-hitting the API.
 *
 * Drawer: reuses OrderQuickView for Phase 1. Phase 3 introduces the abstract
 * task drawer that renders all order types from a single template.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatISTTimestamp } from "@/lib/utils/timezone";
import TaskDetailPanel from "@/components/agent/TaskDetailPanel";

// ─── Types ─────────────────────────────────────────────────────────────
interface Agent {
  id: number;
  name: string;
  role: string;
}

interface ChecklistItem {
  id: number;
  stepOrder: number;
  stepText: string;
  isRequired: boolean;
  isDone: boolean;
  doneAt: string | null;
}

interface Task {
  id: number;
  title: string;
  status: string;
  priority: string;
  orderType: string;
  entityId: number;
  storeId: number | null;
  appointmentTime: string | null;
  slaDeadline: string;
  slaBreachedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  assignedAt: string | null;
  startedAt: string | null;
  snoozedUntil: string | null;
  metadata: Record<string, unknown>;
  assignedTo?: { id: number; name: string } | null;
  checklistItems: ChecklistItem[];
  taskType: { name: string; label: string };
  // Computed by API:
  viewBucket: "today" | "tomorrow" | "stuck" | "future" | "done";
  urgencyBucket: number;
  slaStatus: "safe" | "warning" | "critical" | "breached";
  minutesRemaining: number;
}

// Subset of users a board page passes in — used to gate Lead-only UI
// (filter bar, reassign popover) and to scope row interactions.
interface CurrentUser {
  id: number;
  name: string;
  role: "OPS_HEAD" | "OPS_AGENT" | "STORE_ADMIN";
}

type Tab = "today" | "tomorrow" | "stuck";

// ─── Constants ─────────────────────────────────────────────────────────
const NOW_WINDOW_MIN = 90;
const PREP_VISIBILITY_HOUR_IST = 16; // 4 PM IST — when tonight's prep becomes addressable
const EARLY_MORNING_CUTOFF_HOUR_IST = 10; // appts before 10 AM count as "early"
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ─── Order-type pill ───────────────────────────────────────────────────
const TYPE_STYLES: Record<string, string> = {
  HOME_SAMPLE: "bg-blue-900/60 text-blue-300",
  CONSULTATION: "bg-purple-900/60 text-purple-300",
  PHARMACY: "bg-green-900/60 text-green-300",
  PHARMA: "bg-green-900/60 text-green-300",
  RADIOLOGY: "bg-violet-900/60 text-violet-300",
  MRI: "bg-violet-900/60 text-violet-300",
  INJECTION: "bg-pink-900/60 text-pink-300",
  MANUAL: "bg-zinc-800 text-zinc-300",
};
const TYPE_LABEL: Record<string, string> = {
  HOME_SAMPLE: "HSC",
  CONSULTATION: "CONS",
  PHARMACY: "PHARMA",
  RADIOLOGY: "RAD",
  INJECTION: "INJ",
  MANUAL: "MANUAL",
};
function typeStyle(orderType: string) {
  return TYPE_STYLES[orderType] ?? "bg-zinc-800 text-zinc-300";
}
function typeLabel(orderType: string) {
  return TYPE_LABEL[orderType] ?? orderType.slice(0, 6);
}

// ─── Time helpers ──────────────────────────────────────────────────────
function istHourOfDay(d: Date): number {
  return new Date(d.getTime() + IST_OFFSET_MS).getUTCHours();
}
function istMinutesSinceMidnight(d: Date): number {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}
function istDayKey(d: Date): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${ist.getUTCMonth()}-${ist.getUTCDate()}`;
}
function fmtHourHeader(hour24: number): string {
  const period = hour24 >= 12 ? "PM" : "AM";
  const h = ((hour24 + 11) % 12) + 1;
  return `${h} ${period}`;
}

// ─── Assignee chip ────────────────────────────────────────────────────
// Stable colour per name (hash → palette index) so the same agent reads as
// the same colour across rows without us hand-maintaining a map.
const AVATAR_PALETTE = [
  "bg-blue-700", "bg-purple-700", "bg-green-700", "bg-pink-700",
  "bg-orange-700", "bg-teal-700", "bg-indigo-700", "bg-rose-700",
];
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function AssigneeChip({
  task,
  agents,
  onReassign,
  canReassign = true,
}: {
  task: Task;
  agents: Agent[];
  onReassign: (taskId: number, agentId: number | null) => void;
  // Agents can't reassign tasks — the chip becomes a read-only badge.
  canReassign?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Read-only mode for agents: render a static badge with no popover.
  if (!canReassign) {
    if (task.assignedTo) {
      return (
        <div className="flex items-center gap-1.5 px-1.5 py-0.5 shrink-0" title={task.assignedTo.name}>
          <span
            className={`w-5 h-5 rounded-full ${avatarColor(task.assignedTo.name)} flex items-center justify-center text-[9px] font-semibold text-white`}
          >
            {initials(task.assignedTo.name)}
          </span>
          <span className="text-xs text-zinc-300 max-w-[80px] truncate">{task.assignedTo.name}</span>
        </div>
      );
    }
    return (
      <span className="px-2 py-0.5 rounded text-[11px] bg-yellow-900/40 text-yellow-300 border border-yellow-900/40 shrink-0">
        Unassigned
      </span>
    );
  }

  // Close popover on outside click (stops propagation to row's onClick too).
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    // Defer so the click that opened the popover doesn't immediately close it.
    const t = setTimeout(() => window.addEventListener("click", close), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("click", close);
    };
  }, [open]);

  const handlePick = async (agentId: number | null) => {
    setBusy(true);
    try {
      await onReassign(task.id, agentId);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      {task.assignedTo ? (
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-zinc-700/50 transition-colors"
          title="Click to reassign"
        >
          <span
            className={`w-5 h-5 rounded-full ${avatarColor(task.assignedTo.name)} flex items-center justify-center text-[9px] font-semibold text-white`}
          >
            {initials(task.assignedTo.name)}
          </span>
          <span className="text-xs text-zinc-300 max-w-[80px] truncate">{task.assignedTo.name}</span>
        </button>
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          className="px-2 py-0.5 rounded text-[11px] bg-yellow-900/40 text-yellow-300 border border-yellow-900/40 hover:bg-yellow-900/60 transition-colors"
          title="Click to assign"
        >
          ⚠ Unassigned
        </button>
      )}

      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-56 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl py-1 max-h-72 overflow-y-auto">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
            {busy ? "Reassigning…" : task.assignedTo ? "Reassign to" : "Assign to"}
          </div>
          {agents.length === 0 ? (
            <div className="px-3 py-3 text-xs text-zinc-500 italic">No team members loaded.</div>
          ) : (
            agents.map((a) => (
              <button
                key={a.id}
                onClick={() => handlePick(a.id)}
                disabled={busy || a.id === task.assignedTo?.id}
                className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <span className={`w-5 h-5 rounded-full ${avatarColor(a.name)} flex items-center justify-center text-[9px] font-semibold text-white`}>
                  {initials(a.name)}
                </span>
                <span className="flex-1 truncate">{a.name}</span>
                {a.id === task.assignedTo?.id && <span className="text-[10px] text-zinc-500">current</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Row renderer ──────────────────────────────────────────────────────
function TaskRow({
  task,
  now,
  agents,
  onClick,
  onReassign,
  canReassign,
  rightBadge,
}: {
  task: Task;
  now: Date;
  agents: Agent[];
  onClick: () => void;
  onReassign: (taskId: number, agentId: number | null) => void;
  canReassign: boolean;
  // Optional extra pill rendered next to SLA (used by Stuck view for age).
  rightBadge?: React.ReactNode;
}) {
  const appt = task.appointmentTime ? new Date(task.appointmentTime) : null;
  const diffMin = appt ? Math.round((appt.getTime() - now.getTime()) / 60_000) : null;

  let timeColor = "text-zinc-300";
  let deltaText = "";
  let deltaColor = "text-zinc-500";
  if (diffMin !== null) {
    if (diffMin < -15) {
      timeColor = "text-zinc-600";
      deltaText = `${-diffMin}m ago`;
    } else if (diffMin <= 15) {
      timeColor = "text-red-400";
      deltaText = `in ${diffMin}m`;
      deltaColor = "text-red-400";
    } else if (diffMin <= 60) {
      timeColor = "text-orange-400";
      deltaText = `in ${diffMin}m`;
      deltaColor = "text-orange-400";
    } else if (diffMin <= 90) {
      timeColor = "text-yellow-400";
      deltaText = `in ${diffMin}m`;
      deltaColor = "text-yellow-500";
    }
  }

  const apptLabel = appt
    ? formatISTTimestamp(task.appointmentTime as string, { hour: "2-digit", minute: "2-digit" })
    : "—";

  return (
    <div
      className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800 cursor-pointer hover:bg-zinc-800/40 transition-colors"
      onClick={onClick}
      role="button"
      tabIndex={0}
    >
      <div className="text-center w-16 shrink-0">
        <div className={`text-base font-semibold ${timeColor}`}>{apptLabel}</div>
        <div className={`text-[10px] ${deltaColor} uppercase tracking-wider`}>
          {deltaText || (appt ? "appt" : "no appt")}
        </div>
      </div>

      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider shrink-0 ${typeStyle(task.orderType)}`}>
        {typeLabel(task.orderType)}
      </span>

      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm text-zinc-100 truncate">{task.title}</div>
        <div className="text-xs text-zinc-500 mt-0.5">#{task.entityId}</div>
      </div>

      <AssigneeChip task={task} agents={agents} onReassign={onReassign} canReassign={canReassign} />

      {rightBadge}

      {/* SLA / status pill — one urgency channel per row.
          Rules:
          - BLOCKED or snoozed → grey "Paused" chip. The breach-as-stick
            is the wrong signal when an agent is correctly waiting on an
            external party; rendering a red breach pill drives clear-not-
            resolve theatre.
          - Time block already coloured (appt within 90 min) → no SLA pill.
            The time block IS the urgency signal. A second red badge
            duplicates and dilutes it.
          - Otherwise → original SLA pill for breached/critical/warning. */}
      {(() => {
        const isSnoozed = task.snoozedUntil ? new Date(task.snoozedUntil) > now : false;
        const isPaused = task.status === "BLOCKED" || isSnoozed;
        if (isPaused) {
          return (
            <span className="px-2 py-0.5 rounded text-[11px] bg-zinc-800 text-zinc-400 shrink-0">
              {isSnoozed ? "Snoozed" : "Paused"}
            </span>
          );
        }
        // Suppress SLA pill when the time block is already telegraphing urgency
        // (red/orange/yellow time means the appointment is within 90 min).
        const timeBlockIsUrgent = appt && diffMin !== null && diffMin >= -15 && diffMin <= 90;
        if (timeBlockIsUrgent && task.slaStatus !== "breached") return null;
        if (task.slaStatus === "breached") {
          return <span className="px-2 py-0.5 rounded text-[11px] bg-red-900/60 text-red-300 shrink-0">SLA breached</span>;
        }
        if (task.slaStatus === "critical") {
          return <span className="px-2 py-0.5 rounded text-[11px] bg-orange-900/60 text-orange-300 shrink-0">SLA critical</span>;
        }
        if (task.slaStatus === "warning") {
          return <span className="px-2 py-0.5 rounded text-[11px] bg-yellow-900/40 text-yellow-300 shrink-0">SLA warning</span>;
        }
        return null;
      })()}

      <span className="text-zinc-600 text-xl shrink-0">›</span>
    </div>
  );
}

// ─── Section card wrapper ──────────────────────────────────────────────
function SectionCard({
  icon,
  title,
  subtitle,
  count,
  countClass,
  defaultOpen = true,
  children,
}: {
  icon: string;
  title: string;
  subtitle?: string;
  count?: number;
  countClass?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className="bg-zinc-900 border border-zinc-800 rounded-lg">
      <summary className="px-5 py-4 flex items-center justify-between cursor-pointer list-none [&::-webkit-details-marker]:hidden rounded-t-lg">
        <div className="flex items-center gap-3">
          <span className="text-lg">{icon}</span>
          <div>
            <div className="font-semibold text-zinc-100">{title}</div>
            {subtitle && <div className="text-xs text-zinc-500 mt-0.5">{subtitle}</div>}
          </div>
        </div>
        {count !== undefined && (
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${countClass ?? "bg-zinc-800 text-zinc-300"}`}>
            {count}
          </span>
        )}
      </summary>
      <div className="border-t border-zinc-800">{children}</div>
    </details>
  );
}

// ─── Today view: NOW / PREP / LATER / DONE ─────────────────────────────
function TodayView({ tasks, tomorrowTasks, now, agents, canReassign, onRowClick, onReassign }: {
  tasks: Task[];
  tomorrowTasks: Task[];
  now: Date;
  agents: Agent[];
  canReassign: boolean;
  onRowClick: (task: Task) => void;
  onReassign: (taskId: number, agentId: number | null) => void;
}) {
  const nowMinIST = istMinutesSinceMidnight(now);
  const windowEndMin = nowMinIST + NOW_WINDOW_MIN;

  // Bucket today's tasks by sub-section.
  //
  // The rule:
  //   - tasks WITH an appointmentTime → bucket by that time (NOW / LATER / DONE)
  //   - tasks WITHOUT appointmentTime → fall back to slaDeadline:
  //       SLA breached / due within 90 min → NOW (it's actually urgent)
  //       otherwise → LATER TODAY (don't dump unscheduled work into NOW just
  //       because we lack a time anchor)
  //
  // Earlier shipped behaviour put every no-appt task into NOW. Combined with
  // an engine bug that left appointmentTime null on every task, that meant
  // ALL tasks showed in NOW. Fixed defensively here so a missing field never
  // produces "everything is urgent" again.
  const nowTasks: Task[] = [];
  const laterTasks: Task[] = [];
  const doneTasks: Task[] = [];

  for (const t of tasks) {
    if (t.viewBucket === "done") { doneTasks.push(t); continue; }
    const appt = t.appointmentTime ? new Date(t.appointmentTime) : null;

    if (!appt) {
      // No appointment time → bucket by SLA urgency
      const sla = new Date(t.slaDeadline);
      const slaMinFromNow = (sla.getTime() - now.getTime()) / 60_000;
      if (slaMinFromNow <= NOW_WINDOW_MIN) {
        nowTasks.push(t);                          // SLA is imminent or breached
      } else {
        laterTasks.push(t);                        // No appt + comfortable SLA → not urgent
      }
      continue;
    }

    const apptMin = istMinutesSinceMidnight(appt);
    if (apptMin < nowMinIST - 15) {
      doneTasks.push(t);                           // past appointment, server bucketed as done/stuck
    } else if (apptMin < windowEndMin) {
      nowTasks.push(t);                            // within next 90 min
    } else {
      laterTasks.push(t);                          // later today
    }
  }

  // Tonight's prep: tomorrow tasks with early-morning appts (before 10 AM IST)
  const showPrep = istHourOfDay(now) >= PREP_VISIBILITY_HOUR_IST;
  const prepTasks = showPrep
    ? tomorrowTasks.filter(t => {
        if (!t.appointmentTime) return false;
        const appt = new Date(t.appointmentTime);
        return istHourOfDay(appt) < EARLY_MORNING_CUTOFF_HOUR_IST;
      })
    : [];

  // Sort each bucket by appt time, falling back to slaDeadline when an appt
  // is missing (so no-appt tasks interleave by urgency rather than all
  // landing at the bottom).
  const sortAnchor = (t: Task) =>
    t.appointmentTime ? new Date(t.appointmentTime).getTime() : new Date(t.slaDeadline).getTime();
  const byTime = (a: Task, b: Task) => sortAnchor(a) - sortAnchor(b);
  nowTasks.sort(byTime);
  laterTasks.sort(byTime);
  doneTasks.sort(byTime);

  // Group laterTasks by hour for subdividers
  const laterByHour = new Map<number, Task[]>();
  for (const t of laterTasks) {
    const h = t.appointmentTime ? istHourOfDay(new Date(t.appointmentTime)) : 24;
    if (!laterByHour.has(h)) laterByHour.set(h, []);
    laterByHour.get(h)!.push(t);
  }
  const laterHours = Array.from(laterByHour.keys()).sort((a, b) => a - b);

  return (
    <div className="space-y-4">

      <SectionCard
        icon="⚡"
        title="NOW"
        subtitle={`next 90 minutes`}
        count={nowTasks.length}
        countClass={nowTasks.length > 0 ? "bg-red-900 text-red-300" : "bg-zinc-800 text-zinc-500"}
      >
        {nowTasks.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-zinc-500">
            Nothing urgent right now. Enjoy the breather. ☕
          </div>
        ) : (
          nowTasks.map(t => <TaskRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} />)
        )}
      </SectionCard>

      {prepTasks.length > 0 ? (
        <div className="rounded-lg border border-amber-900/40 ring-1 ring-amber-900/30">
          <details open className="bg-zinc-900">
            <summary className="px-5 py-4 bg-amber-950/20 flex items-center justify-between cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <div className="flex items-center gap-3">
                <span className="text-lg">🌙</span>
                <div>
                  <div className="font-semibold text-amber-200">TONIGHT'S PREP</div>
                  <div className="text-xs text-amber-400/70 mt-0.5">
                    confirmations for tomorrow's early-morning items (before 10 AM)
                  </div>
                </div>
              </div>
              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-700 text-amber-100">
                {prepTasks.length} due tonight
              </span>
            </summary>
            <div className="border-t border-amber-900/30">
              {prepTasks.map(t => <TaskRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} />)}
            </div>
          </details>
        </div>
      ) : !showPrep ? (
        // Pre-4 PM stub. The section materialises with content after 4 PM
        // IST; without this stub a new user has no idea it exists. Visible
        // but dim — clearly disabled, teaches the surface.
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3 opacity-60">
            <span className="text-lg">🌙</span>
            <div>
              <div className="text-sm font-medium text-zinc-400">Tonight's prep</div>
              <div className="text-xs text-zinc-600 mt-0.5">
                tomorrow's early-morning confirmations will surface here after 4 PM
              </div>
            </div>
          </div>
          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-zinc-800 text-zinc-500">
            unlocks at 4 PM
          </span>
        </div>
      ) : null}

      <SectionCard
        icon="📋"
        title="LATER TODAY"
        subtitle={laterTasks.length > 0 ? `${laterTasks.length} more until midnight` : undefined}
        count={laterTasks.length}
      >
        {laterTasks.length === 0 ? (
          <div className="px-5 py-6 text-center text-sm text-zinc-500">
            Nothing else scheduled today.
          </div>
        ) : (
          laterHours.map(h => (
            <div key={h}>
              <div className="px-5 py-2 bg-zinc-950/40 border-b border-zinc-800 text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">
                ── {fmtHourHeader(h)} · {laterByHour.get(h)!.length} task{laterByHour.get(h)!.length > 1 ? "s" : ""} ──
              </div>
              {laterByHour.get(h)!.map(t => <TaskRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} />)}
            </div>
          ))
        )}
      </SectionCard>

      <details className="rounded-lg border border-zinc-800 bg-zinc-900/50">
        <summary className="px-5 py-3 flex items-center justify-between cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <div className="flex items-center gap-3">
            <span className="text-zinc-400">✓</span>
            <div>
              <div className="text-sm font-medium text-zinc-300">Done today</div>
              <div className="text-xs text-zinc-500">resets at midnight IST</div>
            </div>
          </div>
          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-900 text-green-300">
            {doneTasks.length} completed
          </span>
        </summary>
        <div className="border-t border-zinc-800">
          {doneTasks.length === 0 ? (
            <div className="px-5 py-3 text-center text-xs text-zinc-500">Nothing completed yet today.</div>
          ) : (
            doneTasks.slice(0, 20).map(t => <TaskRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} />)
          )}
        </div>
      </details>
    </div>
  );
}

// ─── Tomorrow view ─────────────────────────────────────────────────────
function TomorrowView({ tasks, now, agents, canReassign, onRowClick, onReassign }: {
  tasks: Task[];
  now: Date;
  agents: Agent[];
  canReassign: boolean;
  onRowClick: (task: Task) => void;
  onReassign: (taskId: number, agentId: number | null) => void;
}) {
  const early: Task[] = [];
  const morning: Task[] = [];
  const afternoon: Task[] = [];
  for (const t of tasks) {
    if (!t.appointmentTime) continue;
    const apptHour = istHourOfDay(new Date(t.appointmentTime));
    if (apptHour < EARLY_MORNING_CUTOFF_HOUR_IST) early.push(t);
    else if (apptHour < 12) morning.push(t);
    else afternoon.push(t);
  }
  const byTime = (a: Task, b: Task) =>
    new Date(a.appointmentTime!).getTime() - new Date(b.appointmentTime!).getTime();
  early.sort(byTime); morning.sort(byTime); afternoon.sort(byTime);

  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowLabel = tomorrow.toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata",
  });

  return (
    <div className="space-y-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
        <div className="text-sm text-zinc-400 mb-1">Looking ahead</div>
        <div className="flex items-baseline gap-3">
          <h2 className="text-xl font-bold text-zinc-100">{tomorrowLabel}</h2>
          <span className="text-sm text-zinc-500">· {tasks.length} actions</span>
        </div>
      </div>

      {early.length > 0 && (
        <div className="rounded-lg border border-amber-900/40 ring-1 ring-amber-900/30">
          <div className="px-5 py-4 bg-amber-950/20 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-lg">⚠️</span>
              <div>
                <div className="font-semibold text-amber-200">Early-morning appointments</div>
                <div className="text-xs text-amber-400/70 mt-0.5">
                  Before 10 AM tomorrow — need confirmation calls tonight after 6 PM
                </div>
              </div>
            </div>
            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-700 text-amber-100">
              {early.length} patient{early.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="bg-zinc-900 border-t border-amber-900/30">
            {early.map(t => <TaskRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} />)}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <div className="text-2xl mb-2">🌅</div>
          <div className="text-2xl font-bold text-zinc-100">{morning.length}</div>
          <div className="text-sm text-zinc-400">Morning tasks</div>
          <div className="text-xs text-zinc-500 mt-2">10 AM – 12 PM tomorrow</div>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <div className="text-2xl mb-2">☀️</div>
          <div className="text-2xl font-bold text-zinc-100">{afternoon.length}</div>
          <div className="text-sm text-zinc-400">Afternoon / evening</div>
          <div className="text-xs text-zinc-500 mt-2">12 PM onwards tomorrow</div>
        </div>
      </div>
    </div>
  );
}

// ─── Stuck view: flat list with age + type filters ─────────────────────
function StuckView({ tasks, now, agents, canReassign, onRowClick, onReassign }: {
  tasks: Task[];
  now: Date;
  agents: Agent[];
  canReassign: boolean;
  onRowClick: (task: Task) => void;
  onReassign: (taskId: number, agentId: number | null) => void;
}) {
  const [ageFilter, setAgeFilter] = useState<"all" | "today" | "yesterday" | "older">("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  // Derive age bucket per task (today / yesterday / older) using IST day keys
  const nowDay = istDayKey(now);
  const yesterdayDay = istDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));

  function ageOf(t: Task): "today" | "yesterday" | "older" {
    const anchor = t.appointmentTime ? new Date(t.appointmentTime) : new Date(t.createdAt);
    const k = istDayKey(anchor);
    if (k === nowDay) return "today";
    if (k === yesterdayDay) return "yesterday";
    return "older";
  }

  const types = useMemo(() => {
    const s = new Set<string>();
    tasks.forEach(t => s.add(t.orderType));
    return Array.from(s).sort();
  }, [tasks]);

  const filtered = tasks.filter(t => {
    if (ageFilter !== "all" && ageOf(t) !== ageFilter) return false;
    if (typeFilter !== "all" && t.orderType !== typeFilter) return false;
    return true;
  });

  // Sort by oldest first (most urgent to resolve)
  const ageOrder: Record<string, number> = { older: 0, yesterday: 1, today: 2 };
  filtered.sort((a, b) => {
    const da = ageOrder[ageOf(a)] - ageOrder[ageOf(b)];
    if (da !== 0) return da;
    const at = a.appointmentTime ? new Date(a.appointmentTime).getTime() : new Date(a.createdAt).getTime();
    const bt = b.appointmentTime ? new Date(b.appointmentTime).getTime() : new Date(b.createdAt).getTime();
    return at - bt;
  });

  function ageStyle(age: string) {
    return {
      today: "bg-yellow-900/40 text-yellow-300",
      yesterday: "bg-orange-900/40 text-orange-300",
      older: "bg-red-900/40 text-red-300",
    }[age] ?? "bg-zinc-800 text-zinc-400";
  }
  function ageLabel(t: Task) {
    const a = ageOf(t);
    if (a === "today") return "stuck today";
    if (a === "yesterday") return "stuck yesterday";
    return "older";
  }

  return (
    <div className="space-y-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-zinc-500 uppercase tracking-wider mr-2">Age</span>
          {(["all", "today", "yesterday", "older"] as const).map(a => (
            <button
              key={a}
              onClick={() => setAgeFilter(a)}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                ageFilter === a
                  ? "bg-blue-600 border-blue-600 text-white"
                  : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {a === "all" ? "All" : a.charAt(0).toUpperCase() + a.slice(1)}
              {a === "older" && <span className="text-red-300 ml-1">⚠</span>}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-zinc-500 uppercase tracking-wider mr-2">Type</span>
          <button
            onClick={() => setTypeFilter("all")}
            className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
              typeFilter === "all"
                ? "bg-blue-600 border-blue-600 text-white"
                : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            All types
          </button>
          {types.map(t => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                typeFilter === t
                  ? "bg-blue-600 border-blue-600 text-white"
                  : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {typeLabel(t)}
            </button>
          ))}
        </div>
      </div>

      {/* Banner — alarm tone when something is actually stuck, neutral
          tone when the filter slice happens to be empty. Previously this
          rendered a red "0 orders not progressing" panic box on any
          zero-result filter, training users to distrust the colour. */}
      {filtered.length > 0 ? (
        <div className="bg-red-950/30 border border-red-900/50 rounded-lg p-4">
          <div className="text-sm font-medium text-red-300">{filtered.length} orders not progressing</div>
          <div className="text-xs text-red-400/80 mt-1">
            Past their service window without lifecycle advancement. Sorted oldest first.
          </div>
        </div>
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="text-sm font-medium text-zinc-300">No stuck tasks match your filters</div>
          <div className="text-xs text-zinc-500 mt-1">
            Try widening Age or Type. Default view is "All / All" — start there if you suspect something is hiding.
          </div>
        </div>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
        {filtered.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-zinc-500">
            ✓ Nothing stuck matching these filters.
          </div>
        ) : (
          filtered.map(t => (
            <TaskRow
              key={t.id}
              task={t}
              now={now}
              agents={agents}
              onClick={() => onRowClick(t)}
              onReassign={onReassign}
              canReassign={canReassign}
              rightBadge={
                <span className={`px-2 py-0.5 rounded text-[11px] shrink-0 ${ageStyle(ageOf(t))}`}>
                  {ageLabel(t)}
                </span>
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Main board ────────────────────────────────────────────────────────
//
// Lead/Head and Agent share this component. The currentUser.role gates
// Lead-only UI:
//   - filter bar (only Leads have a workspace big enough to need filters)
//   - reassign popover on the assignee chip (Leads reassign; agents don't)
// Everyone gets the same row layout, drawer, and Today/Tomorrow/Stuck
// buckets. The /api/tasks endpoint already role-scopes results, so agents
// only see their own tasks even with the same component.
export default function MyWorkBoard({ currentUser }: { currentUser: CurrentUser }) {
  const isAgent = currentUser.role === "OPS_AGENT";

  const [tab, setTab] = useState<Tab>("today");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<Date>(new Date());
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  // Drawer state — full task object (not just an id), so TaskDetailPanel
  // can render immediately without a re-fetch. Updated optimistically by
  // the panel's actions; refetched via onUpdate to pick up server state.
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  // ── Filter state (Lead's main tool for slicing the workspace) ───────
  const [filterAssigneeId, setFilterAssigneeId] = useState<"all" | "unassigned" | number>("all");
  const [filterTypes, setFilterTypes] = useState<Set<string>>(new Set()); // empty = all

  // Keep "now" fresh so the sliding NOW window slides on its own.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000); // tick every minute
    return () => clearInterval(id);
  }, []);

  // Escape closes the task drawer.
  useEffect(() => {
    if (!selectedTask) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelectedTask(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedTask]);

  // Load team members once for the assignee dropdown + reassign popovers.
  useEffect(() => {
    fetch("/api/team")
      .then((r) => r.json())
      .then((d) => {
        setAgents(
          (d.members ?? []).map((m: { userId: number; name: string; role: string }) => ({
            id: m.userId, name: m.name, role: m.role,
          }))
        );
      })
      .catch((err) => console.error("[MyWork] team fetch failed:", err));
  }, []);

  // Reassign handler — used by the AssigneeChip popover on every row.
  // Optimistic update + server call; on failure, revert + show error.
  // (Unassign is not supported by /api/tasks/bulk yet — popover hides the
  // option. When the endpoint adds an `unassign` action, accept agentId=null
  // here and branch.)
  const handleReassign = useCallback(async (taskId: number, agentId: number | null) => {
    if (agentId == null) return; // unassign not implemented server-side
    const prev = tasks;
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;
    setTasks((ts) =>
      ts.map((t) =>
        t.id === taskId ? { ...t, assignedTo: { id: agent.id, name: agent.name } } : t
      )
    );
    try {
      const res = await fetch("/api/tasks/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [taskId], action: "reassign", assignedToId: agentId }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      console.error("[MyWork] reassign failed:", e);
      setTasks(prev); // revert optimistic update
      setError(`Reassign failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }, [tasks, agents]);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch a generous slice so client-side bucketing has the full
      // workspace, not just the first page. The previous limit=50 silently
      // truncated visible tasks when total > 50 (e.g. a workspace with 133
      // ORDER_SCHEDULED items showed only 6/7 AM + part of 8 AM, hiding the
      // rest of Today and all of Stuck behind an invisible page break).
      //
      // Phase 2 should split this into per-tab fetches keyed by ?view= so we
      // can paginate each bucket independently. For now, 500 covers realistic
      // ops workspaces and keeps client render perf comfortable.
      const res = await fetch("/api/tasks?limit=500&sortBy=appointmentTime&sortOrder=asc");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTasks(data.tasks ?? []);
      setLastUpdated(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tasks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  // Apply filters first, then bucket. Filters narrow the entire workspace
  // (today/tomorrow/stuck counts all update together).
  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      // Assignee filter
      if (filterAssigneeId === "unassigned" && t.assignedTo) return false;
      if (typeof filterAssigneeId === "number" && t.assignedTo?.id !== filterAssigneeId) return false;
      // Order-type filter (empty set = all)
      if (filterTypes.size > 0 && !filterTypes.has(t.orderType)) return false;
      return true;
    });
  }, [tasks, filterAssigneeId, filterTypes]);

  const byBucket = useMemo(() => {
    const t = { today: [] as Task[], tomorrow: [] as Task[], stuck: [] as Task[] };
    for (const x of filteredTasks) {
      if (x.viewBucket === "today" || x.viewBucket === "done") t.today.push(x);
      else if (x.viewBucket === "tomorrow") t.tomorrow.push(x);
      else if (x.viewBucket === "stuck") t.stuck.push(x);
    }
    return t;
  }, [filteredTasks]);

  const counts = {
    today: byBucket.today.length,
    tomorrow: byBucket.tomorrow.length,
    stuck: byBucket.stuck.length,
  };

  // Set of order types present in the unfiltered workspace — chips render
  // dynamically so we only show chips for types that exist.
  const availableTypes = useMemo(() => {
    const s = new Set<string>();
    for (const t of tasks) s.add(t.orderType);
    return Array.from(s).sort();
  }, [tasks]);

  // Unassigned count for the chip badge (always reflects the unfiltered
  // workspace so the user sees the real "you have N unassigned" pulse).
  const unassignedCount = useMemo(
    () => tasks.filter((t) => !t.assignedTo).length,
    [tasks]
  );

  const lastUpdatedRel = useMemo(() => {
    const sec = Math.floor((now.getTime() - lastUpdated.getTime()) / 1000);
    if (sec < 60) return "just now";
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
  }, [now, lastUpdated]);

  return (
    <div className="px-8 py-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Smart View</h1>
          <div className="text-sm text-zinc-500 mt-1">
            {now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" })}
            <span className="mx-2">·</span>
            <span className="text-zinc-400">Last updated {lastUpdatedRel}</span>
          </div>
        </div>
        <button
          onClick={fetchTasks}
          disabled={loading}
          className="px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
        >
          ⟳ Refresh
        </button>
      </div>

      {/* Filter bar — Lead's main tool for slicing the workspace.
          Sits above tabs so filters persist across Today/Tomorrow/Stuck.
          Hidden for agents (their queue is small enough that filters add
          noise rather than value). */}
      {!isAgent && (
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 mb-4 flex items-center gap-3 flex-wrap">
        {/* Assignee selector */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Assignee</span>
          <select
            value={typeof filterAssigneeId === "number" ? String(filterAssigneeId) : filterAssigneeId}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "all" || v === "unassigned") setFilterAssigneeId(v);
              else setFilterAssigneeId(parseInt(v, 10));
            }}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="all">All team ({tasks.length})</option>
            <option value="unassigned">⚠ Unassigned ({unassignedCount})</option>
            <optgroup label="Team members">
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </optgroup>
          </select>
        </div>

        {/* Order-type chips */}
        {availableTypes.length > 1 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider mr-1">Type</span>
            <button
              onClick={() => setFilterTypes(new Set())}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                filterTypes.size === 0
                  ? "bg-blue-600 border-blue-600 text-white"
                  : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              All
            </button>
            {availableTypes.map((t) => {
              const active = filterTypes.has(t);
              return (
                <button
                  key={t}
                  onClick={() => {
                    const next = new Set(filterTypes);
                    if (active) next.delete(t); else next.add(t);
                    setFilterTypes(next);
                  }}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                    active
                      ? "bg-blue-600 border-blue-600 text-white"
                      : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {typeLabel(t)}
                </button>
              );
            })}
          </div>
        )}

        {/* Reset (only shows when something is filtered) */}
        {(filterAssigneeId !== "all" || filterTypes.size > 0) && (
          <button
            onClick={() => { setFilterAssigneeId("all"); setFilterTypes(new Set()); }}
            className="text-xs text-zinc-500 hover:text-zinc-200 ml-auto"
          >
            Clear filters
          </button>
        )}
      </div>
      )}

      {/* Tab strip */}
      <div className="flex items-center gap-1 border-b border-zinc-800 mb-6">
        {(["today", "tomorrow", "stuck"] as const).map(t => {
          const isActive = tab === t;
          const label = t === "today" ? "Today" : t === "tomorrow" ? "Tomorrow" : "Stuck";
          const countCls = isActive
            ? t === "stuck" ? "bg-red-600 text-white" : "bg-blue-600 text-white"
            : "bg-zinc-700 text-zinc-300";
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-5 py-3 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-zinc-900 border-b-2 border-blue-500 text-white -mb-px"
                  : "text-zinc-500 hover:text-zinc-200"
              }`}
            >
              {label}
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ml-2 ${countCls}`}>
                {counts[t]}
              </span>
            </button>
          );
        })}
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 rounded bg-red-950/40 border border-red-900/40 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && tasks.length === 0 ? (
        <div className="py-16 text-center text-zinc-500">Loading…</div>
      ) : (
        <>
          {tab === "today" && (
            <TodayView
              tasks={byBucket.today}
              tomorrowTasks={byBucket.tomorrow}
              now={now}
              agents={agents}
              canReassign={!isAgent}
              onRowClick={(t) => setSelectedTask(t)}
              onReassign={handleReassign}
            />
          )}
          {tab === "tomorrow" && (
            <TomorrowView
              tasks={byBucket.tomorrow}
              now={now}
              agents={agents}
              canReassign={!isAgent}
              onRowClick={(t) => setSelectedTask(t)}
              onReassign={handleReassign}
            />
          )}
          {tab === "stuck" && (
            <StuckView
              tasks={byBucket.stuck}
              now={now}
              agents={agents}
              canReassign={!isAgent}
              onRowClick={(t) => setSelectedTask(t)}
              onReassign={handleReassign}
            />
          )}
        </>
      )}

      {/* Task drawer — slide-over on the right with TaskDetailPanel inside.
          Same drawer for Leads and Agents. The panel handles all task
          actions (start / complete checklist / snooze / flag for help /
          mark done). onUpdate refetches the list so the row reflects the
          new state. Escape and backdrop both close. */}
      {selectedTask && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-40"
            onClick={() => setSelectedTask(null)}
            aria-hidden
          />
          <div className="fixed top-0 right-0 h-screen w-[520px] max-w-[95vw] z-50 bg-zinc-950 border-l border-zinc-800 shadow-2xl flex flex-col">
            <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between shrink-0">
              <button
                onClick={() => setSelectedTask(null)}
                className="text-zinc-400 hover:text-zinc-100 text-sm flex items-center gap-1"
                aria-label="Close task panel"
              >
                ← Back
              </button>
              <span className="text-xs text-zinc-500">Order #{selectedTask.entityId}</span>
            </div>
            <div className="flex-1 min-h-0">
              <TaskDetailPanel
                key={selectedTask.id}
                task={selectedTask}
                onUpdate={() => { fetchTasks(); }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
