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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatISTTimestamp } from "@/lib/utils/timezone";
import TaskDetailPanel from "@/components/agent/TaskDetailPanel";
import OrderQuickView from "@/components/shared/OrderQuickView";
import RiskBadge from "@/components/shared/RiskBadge";
import VipBadge from "@/components/shared/VipBadge";
import PriorityBadge from "@/components/shared/PriorityBadge";

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
  // Rule provenance — powers the workspace "Rule" filter. MANUAL tasks
  // carry the sentinel taskRuleId "MANUAL" (see /api/tasks POST).
  taskRuleId: string;
  taskRule?: { name?: string } | null;
  // Computed by API:
  viewBucket: "today" | "tomorrow" | "stuck" | "future" | "done";
  urgencyBucket: number;
  slaStatus: "safe" | "warning" | "critical" | "breached";
  minutesRemaining: number;
  // Pickup-delay risk + VIP — computed live per request in /api/tasks, see
  // src/lib/priority/. Not a stored value: recomputed on every fetch.
  riskScore: number;
  riskBand: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  riskReasons: { code: string; label: string; points: number; detail: string; sourceField: string }[];
  riskUnavailable: { signal: string; reason: string }[];
  vip: boolean;
  vipReasons: { code: string; label: string; basis: string; detail: string; sourceField: string }[];
  vipUnavailable: { signal: string; reason: string }[];
  isPriority: boolean;
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
// Appointments up to this many minutes in the past still count as "NOW"
// (just slipped past, operator is likely on it). Anything older is OVERDUE.
const NOW_PAST_GRACE_MIN = 15;
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
function fmtHourHeader(hour24: number): string {
  const period = hour24 >= 12 ? "PM" : "AM";
  const h = ((hour24 + 11) % 12) + 1;
  return `${h} ${period}`;
}

// ─── Metadata accessors ───────────────────────────────────────────────
// Task.metadata carries an order snapshot written at creation time
// (storeName, phleboName, labName, patientName — see taskCreator). These
// power the store filter and the Stuck concentration callout without any
// extra fetch. Defensive: metadata can be null/partial on MANUAL tasks.
function metaStr(t: Task, key: string): string {
  const v = (t.metadata as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : "";
}
function storeNameOf(t: Task): string {
  return metaStr(t, "storeName") || (t.storeId != null ? `Store #${t.storeId}` : "");
}

// ─── CSV export (client-side, mirrors the filtered view) ────────────────
// Excel-safe: UTF-8 BOM, CRLF rows, every cell quoted, and leading
// =/+/-/@ neutralised so a cell can't execute as a spreadsheet formula.
function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}
function fmtIst(s: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "short",
    day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}
const SLA_LABEL: Record<Task["slaStatus"], string> = {
  breached: "Breached", critical: "Critical", warning: "Warning", safe: "In SLA",
};
function tasksToCsv(tasks: Task[]): string {
  const headers = [
    "Task ID", "Order ID", "Order Type", "Title", "Rule", "Patient", "Store",
    "Assignee", "Assigned", "Priority", "SLA Status", "Min Remaining",
    "SLA Deadline (IST)", "Breached At (IST)", "Appointment (IST)",
    "Status", "Bucket", "Created (IST)",
  ];
  const rows = tasks.map((t) => [
    t.id, t.entityId, t.orderType, t.title,
    t.taskRule?.name || t.taskRuleId,
    metaStr(t, "patientName"), storeNameOf(t),
    t.assignedTo?.name || "Unassigned", t.assignedTo ? "Yes" : "No",
    t.priority, SLA_LABEL[t.slaStatus], Math.round(t.minutesRemaining),
    fmtIst(t.slaDeadline), fmtIst(t.slaBreachedAt), fmtIst(t.appointmentTime),
    t.status, t.viewBucket, fmtIst(t.createdAt),
  ]);
  return "﻿" + [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}
function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

// ─── Table columns ─────────────────────────────────────────────────────
// One shared grid template for the header and every row, everywhere in the
// board (Focus/Recover/Later/Done/Tomorrow/Stuck) — a CSS-grid row rather
// than a literal <table>, so it drops into the existing <details>-grouped
// layouts (piles, hour groups, day-age bands) without restructuring them.
const ORDER_TABLE_COLS =
  "grid-cols-[64px_112px_140px_70px_minmax(0,1fr)_84px_60px_104px_92px]";

function TableHeaderRow() {
  return (
    <div
      className={`hidden md:grid ${ORDER_TABLE_COLS} gap-3 items-center px-5 py-2 border-b border-zinc-800 bg-zinc-950/60 text-[10px] font-semibold uppercase tracking-wider text-zinc-500`}
    >
      <span>Order</span>
      <span>Appointment (IST)</span>
      <span>Patient</span>
      <span>Type</span>
      <span>Task / Reason</span>
      <span>Priority</span>
      <span>VIP</span>
      <span>Risk</span>
      <span className="text-right">Actions</span>
    </div>
  );
}

// ─── Row renderer ──────────────────────────────────────────────────────
function OrderTableRow({
  task,
  now,
  agents,
  onClick,
  onReassign,
  canReassign,
  rightBadge,
  onComplete,
  extraActions,
}: {
  task: Task;
  now: Date;
  agents: Agent[];
  onClick: () => void;
  onReassign: (taskId: number, agentId: number | null) => void;
  canReassign: boolean;
  // Optional extra pill rendered next to SLA (used by Stuck view for age).
  rightBadge?: React.ReactNode;
  // Optional inline ✓ Done — passed by the Focus/Recover/Stuck zones where
  // the row is a checklist item to burn down, omitted where it's a preview.
  onComplete?: (taskId: number) => void;
  // Extra buttons in the Actions column (Stuck → "Older" zone's
  // Escalate / Close-with-reason), rendered alongside the standard controls.
  extraActions?: React.ReactNode;
}) {
  const appt = task.appointmentTime ? new Date(task.appointmentTime) : null;
  const diffMin = appt ? Math.round((appt.getTime() - now.getTime()) / 60_000) : null;

  // Friendlier delta formatting. Stuck-view tasks routinely show appts from
  // days/weeks ago; "14640m ago" forced operators to do mental math. Step
  // up through m → h → d → w / mo so anything older than ~1 hour reads as
  // a human duration. We keep the minute precision only inside the urgency
  // window (within 15 / 60 / 90 min) where it actually matters for triage.
  function formatDelta(minutes: number, future: boolean): string {
    const abs = Math.abs(minutes);
    let value: string;
    if (abs < 60) value = `${abs}m`;
    else if (abs < 60 * 24) value = `${Math.round(abs / 60)}h`;
    else if (abs < 60 * 24 * 7) value = `${Math.round(abs / (60 * 24))}d`;
    else if (abs < 60 * 24 * 30) value = `${Math.round(abs / (60 * 24 * 7))}w`;
    else value = `${Math.round(abs / (60 * 24 * 30))}mo`;
    return future ? `in ${value}` : `${value} ago`;
  }

  let timeColor = "text-zinc-300";
  let deltaText = "";
  let deltaColor = "text-zinc-500";
  if (diffMin !== null) {
    if (diffMin < -15) {
      timeColor = "text-zinc-600";
      deltaText = formatDelta(diffMin, false);
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
    } else {
      // > 90 min in the future — still soon enough to want a friendlier
      // label than "in 14400m" on tomorrow-or-later appts.
      deltaText = formatDelta(diffMin, true);
    }
  }

  // For appointments that aren't today, surface the date too — bare
  // "06:00 am" on a row whose appt was 10 days ago is misleading. We
  // detect "today IST" by IST day-key match (no timezone library needed).
  function istDayKey(d: Date): string {
    const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
    return `${ist.getUTCFullYear()}-${ist.getUTCMonth()}-${ist.getUTCDate()}`;
  }
  const apptLabel = appt
    ? (istDayKey(appt) === istDayKey(now)
        ? formatISTTimestamp(task.appointmentTime as string, { hour: "2-digit", minute: "2-digit" })
        : formatISTTimestamp(task.appointmentTime as string, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))
    : "—";

  // Task/Reason secondary line — the real, computed reason this row needs
  // attention, never an invented category. Elevated risk wins (it's the
  // most specific "why"); otherwise fall back to whatever context the
  // calling zone passed (Focus's "scheduled now"/"oldest recovery",
  // Tomorrow's "no phlebo yet", Stuck's day-age tag).
  const topRiskReason = task.riskReasons?.[0];
  const showRiskReason = (task.riskBand === "HIGH" || task.riskBand === "CRITICAL") && topRiskReason;

  return (
    <div
      className={`grid ${ORDER_TABLE_COLS} gap-3 items-center px-5 py-3 border-b border-zinc-800 cursor-pointer hover:bg-zinc-800/40 transition-colors`}
      onClick={onClick}
      role="button"
      tabIndex={0}
    >
      <div className="text-xs text-zinc-400 tabular-nums truncate">#{task.entityId}</div>

      <div>
        <div className={`text-sm font-semibold ${timeColor}`}>{apptLabel}</div>
        <div className={`text-[10px] ${deltaColor} uppercase tracking-wider`}>
          {deltaText || (appt ? "appt" : "no appt")}
        </div>
      </div>

      <div className="text-xs text-zinc-300 truncate" title={metaStr(task, "patientName") || undefined}>
        {metaStr(task, "patientName") || "—"}
      </div>

      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider justify-self-start ${typeStyle(task.orderType)}`}>
        {typeLabel(task.orderType)}
      </span>

      <div className="min-w-0">
        <div className="font-medium text-sm text-zinc-100 truncate">{task.title}</div>
        <div className="text-[11px] text-zinc-500 mt-0.5 truncate">
          {showRiskReason ? topRiskReason.detail : rightBadge ?? null}
        </div>
      </div>

      <div className="justify-self-start"><PriorityBadge priority={task.priority} /></div>

      <div className="justify-self-start"><VipBadge vip={task.vip} /></div>

      <div className="justify-self-start"><RiskBadge band={task.riskBand} score={task.riskScore} /></div>

      <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
        {extraActions}
        {onComplete && task.status !== "COMPLETED" && task.status !== "CANCELLED" && (
          <button
            onClick={() => onComplete(task.id)}
            className="px-1.5 py-1 rounded text-[11px] font-medium border border-green-900 text-green-300 hover:bg-green-900/30 transition-colors"
            title="Mark completed"
          >
            ✓
          </button>
        )}
        <AssigneeChip task={task} agents={agents} onReassign={onReassign} canReassign={canReassign} />
      </div>
    </div>
  );
}

// (SectionCard removed — superseded by Zone, the Focus View chrome.)

// ─── Zone chrome ───────────────────────────────────────────────────────
// The Focus View demarcation system: four fixed zone colors, rendered as a
// 4px left rail. The rails are the only place these semantic colors appear
// at container level, so the zones do the wayfinding (design rev 2-4).
//   focus   blue   — act now (completable this moment)
//   risk    amber  — aging / at risk
//   recover red    — overdue debt
//   deep    darker red — escalation-old (Stuck's "older" band)
//   later   grey   — scheduled / waiting
//   cleared green  — done strips
const ZONE_RAIL: Record<string, string> = {
  focus: "border-l-blue-600 ring-1 ring-blue-900/40",
  risk: "border-l-amber-600",
  recover: "border-l-red-600",
  deep: "border-l-red-900",
  later: "border-l-zinc-600",
  cleared: "border-l-green-800",
};
const ZONE_TITLE: Record<string, string> = {
  focus: "text-blue-300", risk: "text-amber-300", recover: "text-red-300",
  deep: "text-red-400", later: "text-zinc-400", cleared: "text-green-300",
};

function Zone({ kind, title, subtitle, count, countClass, headerRight, children }: {
  kind: keyof typeof ZONE_RAIL;
  title: string;
  subtitle?: string;
  count?: React.ReactNode;
  countClass?: string;
  headerRight?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className={`bg-zinc-900 border border-zinc-800 border-l-4 rounded-lg overflow-hidden ${ZONE_RAIL[kind]}`}>
      <div className={`px-5 py-3 flex items-center gap-3 ${children ? "border-b border-zinc-800" : ""}`}>
        <div className="min-w-0">
          <div className={`text-xs font-extrabold tracking-widest ${ZONE_TITLE[kind]}`}>{title}</div>
          {subtitle && <div className="text-[11px] text-zinc-500 mt-0.5">{subtitle}</div>}
        </div>
        <div className="flex-1" />
        {headerRight}
        {count !== undefined && (
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${countClass ?? "bg-zinc-800 text-zinc-300"}`}>
            {count}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// "Assign all…" — one popover assigning every task in a pile/zone to the
// chosen agent via the bulk endpoint.
function BulkAssignButton({ taskIds, agents, onBulkReassign, label }: {
  taskIds: number[];
  agents: Agent[];
  onBulkReassign: (taskIds: number[], agentId: number) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const t = setTimeout(() => window.addEventListener("click", close), 0);
    return () => { clearTimeout(t); window.removeEventListener("click", close); };
  }, [open]);
  if (taskIds.length === 0) return null;
  return (
    <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-2 py-1 rounded text-[11px] border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors"
      >
        {label ?? `Assign all ${taskIds.length}…`}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-56 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl py-1 max-h-72 overflow-y-auto">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
            Assign {taskIds.length} task{taskIds.length !== 1 ? "s" : ""} to
          </div>
          {agents.map((a) => (
            <button
              key={a.id}
              onClick={() => { onBulkReassign(taskIds, a.id); setOpen(false); }}
              className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-zinc-200 hover:bg-zinc-800"
            >
              <span className={`w-5 h-5 rounded-full ${avatarColor(a.name)} flex items-center justify-center text-[9px] font-semibold text-white`}>
                {initials(a.name)}
              </span>
              <span className="flex-1 truncate">{a.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Today view: NOW / PREP / LATER / DONE ─────────────────────────────
function TodayView({ tasks, tomorrowTasks, now, agents, canReassign, onRowClick, onReassign, onComplete, onBulkReassign }: {
  tasks: Task[];
  tomorrowTasks: Task[];
  now: Date;
  agents: Agent[];
  canReassign: boolean;
  onRowClick: (task: Task) => void;
  onReassign: (taskId: number, agentId: number | null) => void;
  onComplete: (taskId: number) => void;
  onBulkReassign: (taskIds: number[], agentId: number) => void;
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
  const overdueTasks: Task[] = [];
  const nowTasks: Task[] = [];
  const laterTasks: Task[] = [];
  const doneTasks: Task[] = [];

  // With day-based bucketing, Today holds the whole day — including
  // appointments that already passed. Split three ways so NOW means what
  // it says ("due in the next 90 min"):
  //   OVERDUE  appt earlier today, already past (beyond a 15-min grace)
  //   NOW      appt within [now − 15 min, now + 90 min]
  //   LATER    appt later today (> now + 90 min)
  const nowStartMin = nowMinIST - NOW_PAST_GRACE_MIN;

  for (const t of tasks) {
    if (t.viewBucket === "done") { doneTasks.push(t); continue; }
    const appt = t.appointmentTime ? new Date(t.appointmentTime) : null;

    if (!appt) {
      // No appointment time → bucket by SLA urgency.
      const sla = new Date(t.slaDeadline);
      const slaMinFromNow = (sla.getTime() - now.getTime()) / 60_000;
      if (slaMinFromNow < -NOW_PAST_GRACE_MIN) {
        overdueTasks.push(t);                      // SLA already blown past grace
      } else if (slaMinFromNow <= NOW_WINDOW_MIN) {
        nowTasks.push(t);                          // SLA imminent
      } else {
        laterTasks.push(t);                        // comfortable SLA → not urgent
      }
      continue;
    }

    const apptMin = istMinutesSinceMidnight(appt);
    if (apptMin < nowStartMin) {
      overdueTasks.push(t);                        // appointment already passed today
    } else if (apptMin <= windowEndMin) {
      nowTasks.push(t);                            // within next 90 min (+15 min grace)
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
  // landing at the bottom). CRITICAL-risk and VIP tasks (task.isPriority)
  // float to the top of their zone first — appointment-time order is only
  // the tiebreaker among equally-flagged tasks. Zone membership itself
  // (which of Overdue/Now/Later a task lands in) is untouched.
  const sortAnchor = (t: Task) =>
    t.appointmentTime ? new Date(t.appointmentTime).getTime() : new Date(t.slaDeadline).getTime();
  const byTime = (a: Task, b: Task) => {
    const priorityDelta = (a.isPriority ? 0 : 1) - (b.isPriority ? 0 : 1);
    if (priorityDelta !== 0) return priorityDelta;
    return sortAnchor(a) - sortAnchor(b);
  };
  overdueTasks.sort(byTime);
  nowTasks.sort(byTime);
  laterTasks.sort(byTime);
  doneTasks.sort(byTime);

  // Split Done into human-completed vs engine-auto-retired. The retirer
  // stamps metadata.autoRetiredByEngine=true when it closes a task because
  // the source order advanced past the rule's statusIn. Keeping them in
  // separate strips means the "Completed by team" count stays honest as a
  // measure of actual ops work, while the engine-retired pile is visible
  // (and collapsible) for auditability.
  const isAutoRetired = (t: Task) =>
    !!(t.metadata && (t.metadata as Record<string, unknown>).autoRetiredByEngine);
  const doneByTeam = doneTasks.filter((t) => !isAutoRetired(t));
  const doneByEngine = doneTasks.filter(isAutoRetired);

  // ── FOCUS — NEXT 5 (design rev 2) ──────────────────────────────────
  // The focus zone is NEVER empty while open work exists: scheduled
  // next-90-min items rank first, then it tops up with the oldest
  // recoveries. Completing one pulls the next in (the lists recompute
  // from task state). Each entry carries a "why" label so the ranking
  // is legible, not mysterious.
  const FOCUS_CAP = 5;
  const focusEntries: Array<{ task: Task; why: "scheduled now" | "oldest recovery" }> = [
    ...nowTasks.slice(0, FOCUS_CAP).map((t) => ({ task: t, why: "scheduled now" as const })),
  ];
  for (const t of overdueTasks) {
    if (focusEntries.length >= FOCUS_CAP) break;
    focusEntries.push({ task: t, why: "oldest recovery" });
  }
  const focusIds = new Set(focusEntries.map((e) => e.task.id));

  // ── RECOVER — overdue grouped by rule, sorted by pile size ─────────
  // Items already promoted into Focus are excluded so a task never
  // renders twice. Each group carries oldest-age + store concentration
  // ("Thyrocare ×28" reads as one lab problem, not 28 task problems).
  const recoverTasks = overdueTasks.filter((t) => !focusIds.has(t.id));
  const recoverGroups = (() => {
    const byRule = new Map<string, { ruleId: string; label: string; items: Task[] }>();
    for (const t of recoverTasks) {
      const id = t.taskRuleId ?? "unknown";
      if (!byRule.has(id)) {
        const raw = t.taskRule?.name ?? (id === "MANUAL" ? "Manual tasks" : id);
        const label = raw.replace(/^[^:]*:\s*/, "").replace(/\s*\(.*$/, "").trim() || raw;
        byRule.set(id, { ruleId: id, label, items: [] });
      }
      byRule.get(id)!.items.push(t);
    }
    return Array.from(byRule.values())
      .map((g) => {
        const oldest = g.items[0]; // items inherit overdueTasks' time sort (oldest first)
        const oldestMin = oldest?.appointmentTime
          ? Math.max(0, Math.round((now.getTime() - new Date(oldest.appointmentTime).getTime()) / 60_000))
          : null;
        const storeCounts = new Map<string, number>();
        for (const t of g.items) {
          const s = storeNameOf(t);
          if (s) storeCounts.set(s, (storeCounts.get(s) ?? 0) + 1);
        }
        const topStore = Array.from(storeCounts.entries()).sort((a, b) => b[1] - a[1])[0];
        return { ...g, oldestMin, topStore };
      })
      .sort((a, b) => b.items.length - a.items.length);
  })();
  const fmtAge = (min: number | null) => {
    if (min == null) return "—";
    if (min < 60) return `${min}m`;
    if (min < 60 * 24) return `${Math.floor(min / 60)}h ${min % 60}m`;
    return `${Math.floor(min / (60 * 24))}d ${Math.floor((min % (60 * 24)) / 60)}h`;
  };
  const openCount = overdueTasks.length + nowTasks.length + laterTasks.length;
  const totalToday = openCount + doneTasks.length;

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
      <TableHeaderRow />

      {/* Day progress line — replaces the misleading total badge. Open work
          vs team completions vs engine auto-closes at a glance; fills as
          the team completes. Auto-closes never masquerade as throughput. */}
      <div>
        <div className="h-1.5 rounded bg-zinc-800 overflow-hidden flex">
          <div
            className="bg-green-600 h-full"
            style={{ width: totalToday > 0 ? `${(doneByTeam.length / totalToday) * 100}%` : "0%" }}
          />
          <div
            className="bg-zinc-600 h-full"
            style={{ width: totalToday > 0 ? `${(doneByEngine.length / totalToday) * 100}%` : "0%" }}
          />
        </div>
        <div className="flex justify-between mt-1.5 text-[11px] text-zinc-500 tabular-nums">
          <span>
            <span className={openCount > 0 ? "text-red-300 font-medium" : "text-green-300 font-medium"}>
              {openCount} open
            </span>
            {" — "}{doneByTeam.length} done by team · {doneByEngine.length} auto-closed
          </span>
          <span>{totalToday} total today</span>
        </div>
      </div>

      {/* ◉ FOCUS — the "what matters this moment" zone. Never empty while
          open work exists: next-90-min items first, topped up with the
          oldest recoveries. Completing one pulls the next in. */}
      <Zone
        kind="focus"
        title={`◉ FOCUS — NEXT ${Math.min(FOCUS_CAP, Math.max(focusEntries.length, 1))}`}
        subtitle={
          focusEntries.length === 0
            ? undefined
            : `${nowTasks.length} scheduled in the next 90 min · topped up with the ${Math.max(0, focusEntries.length - Math.min(nowTasks.length, FOCUS_CAP))} oldest recoveries`
        }
        count={focusEntries.length}
        countClass="bg-blue-900/60 text-blue-300"
      >
        {focusEntries.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-zinc-500">
            All of today&apos;s work is complete. Genuinely nothing to do. 🎉
          </div>
        ) : (
          focusEntries.map(({ task: t, why }) => (
            <OrderTableRow
              key={t.id}
              task={t}
              now={now}
              agents={agents}
              onClick={() => onRowClick(t)}
              onReassign={onReassign}
              canReassign={canReassign}
              onComplete={onComplete}
              rightBadge={
                <span className={`px-2 py-0.5 rounded text-[10px] shrink-0 ${
                  why === "scheduled now" ? "bg-blue-900/50 text-blue-300" : "bg-red-900/40 text-red-300"
                }`}>
                  {why}
                </span>
              }
            />
          ))
        )}
        {recoverTasks.length > 0 && focusEntries.length > 0 && (
          <div className="px-5 py-2.5 text-[11px] text-zinc-500 border-t border-zinc-800">
            completing one pulls the next oldest in automatically
          </div>
        )}
      </Zone>

      {/* ⏰ RECOVER TODAY — remaining overdue, grouped by rule so 100+
          tasks read as a handful of piles. Expand only the pile being
          worked; "Assign all…" batches a pile to one agent. */}
      {recoverTasks.length > 0 && (
        <Zone
          kind="recover"
          title="⏰ RECOVER TODAY"
          subtitle="appointment passed, still open — burn down by pile"
          count={`${recoverTasks.length} remaining`}
          countClass="bg-red-900 text-red-300"
        >
          {recoverGroups.map((g, gi) => (
            <details key={g.ruleId} open={gi === 0} className="border-b border-zinc-800 last:border-b-0">
              <summary className="px-5 py-3 flex items-center gap-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden hover:bg-zinc-800/30">
                <span className="text-zinc-500 text-[10px]">▸</span>
                <span className="text-sm font-semibold text-zinc-200">{g.label}</span>
                <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-900/60 text-red-300 tabular-nums">{g.items.length}</span>
                <span className="text-[11px] text-zinc-500">
                  oldest {fmtAge(g.oldestMin)}
                  {g.topStore && g.topStore[1] > 1 ? ` · ${g.topStore[0]} ×${g.topStore[1]}` : ""}
                </span>
                <span className="flex-1" />
                {canReassign && (
                  <BulkAssignButton
                    taskIds={g.items.map((t) => t.id)}
                    agents={agents}
                    onBulkReassign={onBulkReassign}
                  />
                )}
              </summary>
              <div className="border-t border-zinc-800/60">
                {g.items.map((t) => (
                  <OrderTableRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} onComplete={onComplete} />
                ))}
              </div>
            </details>
          ))}
        </Zone>
      )}

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
              {prepTasks.map(t => <OrderTableRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} />)}
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

      {/* ◷ LATER TODAY — a single quiet line when empty (empty space must
          not pretend to be calm); hour-grouped rows when there's work. */}
      {laterTasks.length === 0 ? (
        <Zone kind="later" title="◷ LATER TODAY" subtitle="nothing else scheduled today" count={0} />
      ) : (
        <Zone
          kind="later"
          title="◷ LATER TODAY"
          subtitle={`${laterTasks.length} more until midnight`}
          count={laterTasks.length}
        >
          {laterHours.map(h => (
            <div key={h}>
              <div className="px-5 py-2 bg-zinc-950/40 border-b border-zinc-800 text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">
                ── {fmtHourHeader(h)} · {laterByHour.get(h)!.length} task{laterByHour.get(h)!.length > 1 ? "s" : ""} ──
              </div>
              {laterByHour.get(h)!.map(t => <OrderTableRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} />)}
            </div>
          ))}
        </Zone>
      )}

      <details className="rounded-lg border border-zinc-800 border-l-4 border-l-green-800 bg-zinc-900/50">
        <summary className="px-5 py-3 flex items-center justify-between cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <div className="flex items-center gap-3">
            <span className="text-green-400">✓</span>
            <div>
              <div className="text-sm font-medium text-zinc-300">Completed by team today</div>
              <div className="text-xs text-zinc-500">resets at midnight IST</div>
            </div>
          </div>
          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-900 text-green-300">
            {doneByTeam.length} completed
          </span>
        </summary>
        <div className="border-t border-zinc-800">
          {doneByTeam.length === 0 ? (
            <div className="px-5 py-3 text-center text-xs text-zinc-500">Nothing completed yet today.</div>
          ) : (
            doneByTeam.slice(0, 20).map(t => <OrderTableRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} />)
          )}
        </div>
      </details>

      {/* Engine auto-retirements — collapsed by default. These are tasks the
          poller closed because the underlying order moved past the rule's
          statusIn (e.g. R5 task for an order that's now REPORT_DELIVERED).
          Surfaced separately so the "Completed by team" count above stays
          a clean measure of human throughput. */}
      {doneByEngine.length > 0 && (
        <details className="rounded-lg border border-zinc-800 border-l-4 border-l-green-900/60 bg-zinc-900/30">
          <summary className="px-5 py-3 flex items-center justify-between cursor-pointer list-none [&::-webkit-details-marker]:hidden">
            <div className="flex items-center gap-3">
              <span className="text-zinc-500">⚙</span>
              <div>
                <div className="text-sm font-medium text-zinc-400">Auto-closed by engine today</div>
                <div className="text-xs text-zinc-600">orders advanced past their rule&apos;s statusIn</div>
              </div>
            </div>
            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-zinc-800 text-zinc-400">
              {doneByEngine.length} auto
            </span>
          </summary>
          <div className="border-t border-zinc-800">
            {doneByEngine.slice(0, 20).map(t => <OrderTableRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} />)}
          </div>
        </details>
      )}
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
  // Simple chronological schedule (design rev 4): one plain summary line,
  // hour-divided read-only rows, busy hours collapsed to a count line.
  // Prep/risk WORK lives on Today (Tonight's Prep) — Tomorrow is only for
  // reading the shape of the day.
  const byHour = new Map<number, Task[]>();
  const noTime: Task[] = [];
  for (const t of tasks) {
    if (!t.appointmentTime) { noTime.push(t); continue; }
    const h = istHourOfDay(new Date(t.appointmentTime));
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h)!.push(t);
  }
  // CRITICAL-risk and VIP tasks float to the top of their hour group first —
  // same rule as TodayView, appointment time is only the tiebreaker.
  const byTime = (a: Task, b: Task) => {
    const priorityDelta = (a.isPriority ? 0 : 1) - (b.isPriority ? 0 : 1);
    if (priorityDelta !== 0) return priorityDelta;
    return new Date(a.appointmentTime!).getTime() - new Date(b.appointmentTime!).getTime();
  };
  const hours = Array.from(byHour.keys()).sort((a, b) => a - b);
  hours.forEach((h) => byHour.get(h)!.sort(byTime));

  const beforeEight = tasks.filter(
    (t) => t.appointmentTime && istHourOfDay(new Date(t.appointmentTime)) < 8
  ).length;
  const noPhlebo = tasks.filter(
    (t) => t.appointmentTime && !metaStr(t, "phleboName")
  ).length;

  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowLabel = tomorrow.toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata",
  });

  // Hours with more rows than this start collapsed — the divider line with
  // its count is the information; the rows are detail on demand.
  const COLLAPSE_THRESHOLD = 10;

  return (
    <div className="space-y-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-5 py-4">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h2 className="text-lg font-bold text-zinc-100">{tomorrowLabel}</h2>
          <span className="text-sm text-zinc-400 tabular-nums">
            {tasks.length} appointments
            {beforeEight > 0 && <> · <b className="text-amber-300">{beforeEight} before 8 AM</b></>}
            {noPhlebo > 0 && <> · {noPhlebo} without a phlebo yet</>}
          </span>
        </div>
        <div className="text-xs text-zinc-500 mt-1">
          Read-only schedule — tonight&apos;s prep work is on <b>Today → Tonight&apos;s Prep</b>.
        </div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 border-l-4 border-l-zinc-600 rounded-lg overflow-hidden">
        {hours.length === 0 && noTime.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-zinc-500">Nothing scheduled for tomorrow yet.</div>
        ) : (
          <>
            <TableHeaderRow />
            {hours.map((h) => {
              const items = byHour.get(h)!;
              return (
                <details key={h} open={items.length <= COLLAPSE_THRESHOLD} className="border-b border-zinc-800 last:border-b-0">
                  <summary className="px-5 py-2.5 bg-zinc-950/40 flex items-center gap-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden hover:bg-zinc-800/30">
                    <span className="text-[11px] text-zinc-400 uppercase tracking-wider font-semibold tabular-nums">{fmtHourHeader(h)}</span>
                    <span className="text-[11px] text-zinc-600 tabular-nums">{items.length} appointment{items.length !== 1 ? "s" : ""}</span>
                    {items.length > COLLAPSE_THRESHOLD && <span className="text-[10px] text-zinc-600">(click to expand)</span>}
                  </summary>
                  {items.map((t) => (
                    <OrderTableRow
                      key={t.id}
                      task={t}
                      now={now}
                      agents={agents}
                      onClick={() => onRowClick(t)}
                      onReassign={onReassign}
                      canReassign={canReassign}
                      rightBadge={
                        !metaStr(t, "phleboName")
                          ? <span className="px-2 py-0.5 rounded text-[10px] shrink-0 bg-amber-900/30 text-amber-300/80">no phlebo yet</span>
                          : undefined
                      }
                    />
                  ))}
                </details>
              );
            })}
            {noTime.length > 0 && (
              <div>
                <div className="px-5 py-2.5 bg-zinc-950/40 text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">
                  No appointment time · {noTime.length}
                </div>
                {noTime.map((t) => (
                  <OrderTableRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Stuck view: age-zoned debt ledger (design rev 3) ──────────────────
// Age is Stuck's natural demarcation because age dictates the action:
//   Yesterday (amber)  → recover like Today's pile: ✓ Done / Assign
//   2–3 days  (red)    → chase hard, every item has slipped once already
//   Older     (dark)   → chasing failed; the honest options are a formal
//                        escalation or a recorded decision to stop. Rows
//                        show Escalate / Close-with-reason, not ✓.
// The old Age filter pills and sort toggle are gone — the zones ARE the
// age filter, fixed oldest-first. (Type/rule/store slicing lives in the
// workspace filter bar above the tabs.)
function StuckView({ tasks, now, agents, canReassign, onRowClick, onReassign, onComplete, onBulkReassign, onCloseWithReason }: {
  tasks: Task[];
  now: Date;
  agents: Agent[];
  canReassign: boolean;
  onRowClick: (task: Task) => void;
  onReassign: (taskId: number, agentId: number | null) => void;
  onComplete: (taskId: number) => void;
  onBulkReassign: (taskIds: number[], agentId: number) => void;
  onCloseWithReason: (taskId: number, reason: string) => void;
}) {
  // Whole IST days between the task's anchor (appointment, else creation)
  // and now. Stuck holds prior-day work, so diff ≥ 1 in the normal case;
  // clamp to ≥1 so a boundary artefact can't fall out of every band.
  const istMidnightMs = (d: Date) => {
    const ist = new Date(d.getTime() + IST_OFFSET_MS);
    return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  };
  const dayAge = (t: Task) => {
    const anchor = t.appointmentTime ? new Date(t.appointmentTime) : new Date(t.createdAt);
    return Math.max(1, Math.round((istMidnightMs(now) - istMidnightMs(anchor)) / 86_400_000));
  };

  const anchorMs = (t: Task) =>
    t.appointmentTime ? new Date(t.appointmentTime).getTime() : new Date(t.createdAt).getTime();
  // Oldest first, but CRITICAL-risk/VIP tasks float to the top within
  // whichever day-age band they land in — band membership itself (computed
  // from dayAge, a filter over `sorted`, not this order) is untouched.
  const sorted = [...tasks].sort((a, b) => {
    const priorityDelta = (a.isPriority ? 0 : 1) - (b.isPriority ? 0 : 1);
    if (priorityDelta !== 0) return priorityDelta;
    return anchorMs(a) - anchorMs(b);
  });

  const bandYesterday = sorted.filter((t) => dayAge(t) === 1);
  const bandMid = sorted.filter((t) => { const d = dayAge(t); return d >= 2 && d <= 3; });
  const bandOld = sorted.filter((t) => dayAge(t) > 3);
  const total = tasks.length;

  const fmtDayAge = (t: Task) => {
    const d = dayAge(t);
    return d === 1 ? "1d" : `${d}d`;
  };

  // Systemic-pattern detection: one store owning ≥25% of the stuck pile
  // (min 3) is usually one upstream problem, not N task problems.
  const concentration = useMemo(() => {
    const byStore = new Map<string, number>();
    for (const t of tasks) {
      const s = storeNameOf(t);
      if (s) byStore.set(s, (byStore.get(s) ?? 0) + 1);
    }
    const top = Array.from(byStore.entries()).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= Math.max(3, Math.ceil(tasks.length * 0.25))) return top;
    return null;
  }, [tasks]);

  return (
    <div className="space-y-4">
      <TableHeaderRow />
      {/* Age composition bar — Stuck's scoreboard. A healthy operation's
          bar shrinks from the right; a growing dark tail is the warning. */}
      {total > 0 ? (
        <div>
          <div className="h-2 rounded bg-zinc-800 overflow-hidden flex">
            <div className="bg-amber-600 h-full" style={{ width: `${(bandYesterday.length / total) * 100}%` }} />
            <div className="bg-red-600 h-full" style={{ width: `${(bandMid.length / total) * 100}%` }} />
            <div className="bg-red-900 h-full" style={{ width: `${(bandOld.length / total) * 100}%` }} />
          </div>
          <div className="flex gap-5 mt-1.5 text-[11px] text-zinc-500 tabular-nums flex-wrap">
            <span><span className="inline-block w-2 h-2 rounded-sm bg-amber-600 mr-1.5" /><b className="text-zinc-300">{bandYesterday.length}</b> yesterday</span>
            <span><span className="inline-block w-2 h-2 rounded-sm bg-red-600 mr-1.5" /><b className="text-zinc-300">{bandMid.length}</b> 2–3 days</span>
            <span><span className="inline-block w-2 h-2 rounded-sm bg-red-900 mr-1.5" /><b className="text-zinc-300">{bandOld.length}</b> older — needs a decision</span>
            <span className="ml-auto">goal: this bar shrinks left-to-right</span>
          </div>
        </div>
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="text-sm font-medium text-green-300">✓ Nothing stuck</div>
          <div className="text-xs text-zinc-500 mt-1">No prior-day work is waiting. (Workspace filters apply here too.)</div>
        </div>
      )}

      {/* Systemic-pattern callout — one store owning ≥25% of the pile is
          one upstream problem, not N task problems. */}
      {concentration && (
        <div className="flex items-center gap-3 bg-amber-950/20 border border-amber-900/40 rounded-lg px-4 py-2.5 text-sm text-amber-300 flex-wrap">
          <span>⚠ Pattern: <b className="tabular-nums">{concentration[1]} of {total}</b> stuck tasks are {concentration[0]}.</span>
          <span className="text-amber-400/60 text-xs">Likely one upstream problem — worth a root-cause look before chasing individually.</span>
        </div>
      )}

      {/* ◔ YESTERDAY — fresh debt, recover exactly like Today's pile */}
      {bandYesterday.length > 0 && (
        <Zone
          kind="risk"
          title="◔ YESTERDAY"
          subtitle="fresh debt — recover exactly like Today's pile"
          count={bandYesterday.length}
          countClass="bg-amber-900/60 text-amber-300"
          headerRight={canReassign ? (
            <BulkAssignButton taskIds={bandYesterday.map((t) => t.id)} agents={agents} onBulkReassign={onBulkReassign} />
          ) : undefined}
        >
          {bandYesterday.map((t) => (
            <OrderTableRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} onComplete={onComplete}
              rightBadge={<span className="px-2 py-0.5 rounded text-[11px] shrink-0 bg-amber-900/40 text-amber-300 tabular-nums">{fmtDayAge(t)}</span>}
            />
          ))}
        </Zone>
      )}

      {/* ⏰ 2–3 DAYS — chase hard; every item here has slipped once already */}
      {bandMid.length > 0 && (
        <Zone
          kind="recover"
          title="⏰ 2–3 DAYS"
          subtitle="chase hard — every item here has slipped once already"
          count={bandMid.length}
          countClass="bg-red-900 text-red-300"
          headerRight={canReassign ? (
            <BulkAssignButton taskIds={bandMid.map((t) => t.id)} agents={agents} onBulkReassign={onBulkReassign} />
          ) : undefined}
        >
          {bandMid.map((t) => (
            <OrderTableRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} onComplete={onComplete}
              rightBadge={<span className="px-2 py-0.5 rounded text-[11px] shrink-0 bg-red-900/40 text-red-300 tabular-nums">{fmtDayAge(t)}</span>}
            />
          ))}
        </Zone>
      )}

      {/* ⛔ OLDER THAN 3 DAYS — chasing failed; rows show a decision, not ✓.
          Escalate opens the order context (drawer) so the head can raise it
          with full history; Close-with-reason records why we stopped. */}
      {bandOld.length > 0 && (
        <Zone
          kind="deep"
          title="⛔ OLDER THAN 3 DAYS"
          subtitle="chasing has failed — decide: escalate, or close with a reason"
          count={bandOld.length}
          countClass="bg-red-950 text-red-400"
        >
          {bandOld.map((t) => (
            <OrderTableRow
              key={t.id}
              task={t}
              now={now}
              agents={agents}
              onClick={() => onRowClick(t)}
              onReassign={onReassign}
              canReassign={canReassign}
              rightBadge={`stuck ${fmtDayAge(t)}${storeNameOf(t) ? ` · ${storeNameOf(t)}` : ""}`}
              extraActions={
                <>
                  <button
                    onClick={() => onRowClick(t)}
                    className="px-1.5 py-1 rounded text-[11px] font-medium border border-red-900 text-red-300 hover:bg-red-900/30 transition-colors"
                    title="Open order context to raise an escalation"
                  >
                    Escalate ↗
                  </button>
                  <button
                    onClick={() => {
                      const reason = window.prompt(
                        `Close "${t.title}"?\n\nRecord the reason (required) — this is a decision to stop chasing, kept in the task history:`
                      );
                      if (reason && reason.trim()) onCloseWithReason(t.id, reason.trim());
                    }}
                    className="px-1.5 py-1 rounded text-[11px] border border-zinc-700 text-zinc-400 hover:bg-zinc-800 transition-colors"
                  >
                    Close w/ reason
                  </button>
                </>
              }
            />
          ))}
        </Zone>
      )}
    </div>
  );
}

// ─── Risk-distribution donut ───────────────────────────────────────────
// Hand-rolled SVG (no charting library in this repo — see SourceLoadPanel.tsx
// for the same convention elsewhere). Status colors reused verbatim from
// RiskBadge.tsx so the donut and every row badge agree on what each color
// means; a fixed LOW→CRITICAL order, never re-derived per render.
const RISK_BAND_COLOR: Record<"LOW" | "MEDIUM" | "HIGH" | "CRITICAL", string> = {
  LOW: "#71717a", MEDIUM: "#eab308", HIGH: "#f97316", CRITICAL: "#ef4444",
};
function RiskDonut({ counts }: { counts: Record<"LOW" | "MEDIUM" | "HIGH" | "CRITICAL", number> }) {
  const order = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
  const total = order.reduce((sum, k) => sum + counts[k], 0);
  const R = 38, STROKE = 13;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const segments = order
    .map((k) => {
      const frac = total > 0 ? counts[k] / total : 0;
      const len = frac * C;
      const seg = { key: k, len, offset };
      offset += len;
      return seg;
    })
    .filter((s) => s.len > 0);

  return (
    <div className="flex items-center gap-4">
      <svg width="96" height="96" viewBox="0 0 96 96" className="shrink-0" role="img" aria-label={`Risk distribution: ${order.map((k) => `${k.toLowerCase()} ${counts[k]}`).join(", ")}`}>
        <circle cx="48" cy="48" r={R} fill="none" stroke="#27272a" strokeWidth={STROKE} />
        {/* Rotate only the segment group so 0% starts at 12 o'clock; the
            total-count text stays upright, unrotated. */}
        <g transform="rotate(-90 48 48)">
          {segments.map((s) => (
            <circle
              key={s.key}
              cx="48" cy="48" r={R} fill="none"
              stroke={RISK_BAND_COLOR[s.key]}
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={`${Math.max(0, s.len - 2)} ${C - Math.max(0, s.len - 2)}`}
              strokeDashoffset={-s.offset}
            />
          ))}
        </g>
        <text x="48" y="54" textAnchor="middle" className="fill-zinc-100 text-xl font-bold">
          {total}
        </text>
      </svg>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map((k) => (
          <div key={k} className="flex items-center gap-1.5 text-xs whitespace-nowrap">
            <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: RISK_BAND_COLOR[k] }} />
            <span className="text-zinc-400">{k.charAt(0) + k.slice(1).toLowerCase()}</span>
            <span className="text-zinc-200 font-medium tabular-nums">{counts[k]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// A single filter as a bordered dropdown card — label on top, full-width
// select below. Uniform look for Assignee/Type/Rule/Store/Task Priority so
// they read as one row of equal controls rather than mixed label+select
// pairs and chip clusters.
function FilterCard({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="flex-1 min-w-[150px] rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-2">
      <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-transparent text-sm text-zinc-100 focus:outline-none cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-zinc-800">{o.label}</option>
        ))}
      </select>
    </div>
  );
}

// ─── Summary — stat tiles + risk distribution ──────────────────────────
// Computed from the SAME task list the table below renders (the active
// tab's filtered set), so the numbers here and the rows below never
// disagree. Tile markup mirrors HeadCommandCenter.tsx's stats bar.
// Small icon glyphs for the stat tiles — plain inline SVG (no icon library
// in this repo), matched one-for-one to what each tile counts.
const TILE_ICONS: Record<string, React.ReactNode> = {
  total: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 7h6m-6 4h6" />
    </svg>
  ),
  priority: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
    </svg>
  ),
  vip: (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
      <path d="M5 16L3 6l5.5 4L12 4l3.5 6L21 6l-2 10H5zm0 2h14v2H5v-2z" />
    </svg>
  ),
  risk: (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
      <path d="M12 2l2.9 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l7.1-1.01L12 2z" />
    </svg>
  ),
};

function SmartViewSummary({ tasks }: { tasks: Task[] }) {
  const total = tasks.length;
  const priorityCount = tasks.filter((t) => t.isPriority).length;
  const vipCount = tasks.filter((t) => t.vip).length;
  const riskCounts: Record<"LOW" | "MEDIUM" | "HIGH" | "CRITICAL", number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  for (const t of tasks) riskCounts[t.riskBand]++;
  const highCritical = riskCounts.HIGH + riskCounts.CRITICAL;

  const tiles: Array<{ key: string; label: string; value: number; iconCls: string; ringCls: string }> = [
    { key: "total", label: "Total Orders", value: total, iconCls: "text-blue-400 bg-blue-500/15", ringCls: "text-white" },
    { key: "priority", label: "Priority Orders", value: priorityCount, iconCls: "text-red-400 bg-red-500/15", ringCls: priorityCount > 0 ? "text-blue-400" : "text-white" },
    { key: "vip", label: "VIP Orders", value: vipCount, iconCls: "text-amber-400 bg-amber-500/15", ringCls: vipCount > 0 ? "text-amber-400" : "text-white" },
    { key: "risk", label: "High / Critical Risk", value: highCritical, iconCls: "text-purple-400 bg-purple-500/15", ringCls: highCritical > 0 ? "text-red-400" : "text-white" },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 mb-4">
      {tiles.map((t) => (
        <div key={t.label} className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 flex items-center gap-3">
          <span className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${t.iconCls}`}>
            {TILE_ICONS[t.key]}
          </span>
          <div className="min-w-0">
            <div className="text-xs text-zinc-500 mb-0.5 truncate">{t.label}</div>
            <div className={`text-2xl font-bold ${t.ringCls}`}>{t.value}</div>
          </div>
        </div>
      ))}
      <div className="col-span-2 bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 flex items-center justify-center">
        <RiskDonut counts={riskCounts} />
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
  const [exportOpen, setExportOpen] = useState(false);
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
  // Rule filter — slice the workspace by originating task rule (keyed on
  // taskRuleId). Lets the lead answer "which rule is generating the pile"
  // (e.g. select Sample Handover → Stuck tab = where handovers are stuck).
  const [filterRules, setFilterRules] = useState<Set<string>>(new Set()); // empty = all
  // Store / priority filters — combined with the above so any permutation of
  // (assignee × type × rule × store × priority × risk × VIP) can be sliced.
  // All client-side over the already-fetched workspace.
  const [filterStore, setFilterStore] = useState<string>("all");
  const [filterPriorities, setFilterPriorities] = useState<Set<string>>(new Set()); // empty = all
  // Risk / VIP / Priority-order filters — same client-side slicing over the
  // riskBand/vip/isPriority fields computed live by /api/tasks (see
  // src/lib/priority/).
  const [filterRiskBands, setFilterRiskBands] = useState<Set<string>>(new Set()); // empty = all
  const [filterVip, setFilterVip] = useState<"all" | "vip" | "non-vip">("all");
  const [filterPriorityOrders, setFilterPriorityOrders] = useState<"all" | "priority" | "non-priority">("all");
  const [filterSearch, setFilterSearch] = useState("");

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

  // ✓ Done from a row (Focus / Recover / Stuck zones). Optimistic: flip the
  // task to COMPLETED + viewBucket "done" locally so it moves to Cleared and
  // the Focus zone pulls the next item in immediately; revert on failure.
  const handleComplete = useCallback(async (taskId: number) => {
    const prev = tasks;
    const nowIso = new Date().toISOString();
    setTasks((ts) =>
      ts.map((t) =>
        t.id === taskId
          ? { ...t, status: "COMPLETED", completedAt: nowIso, viewBucket: "done" as const }
          : t
      )
    );
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "COMPLETED", note: "Completed from Smart View" }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      console.error("[MyWork] complete failed:", e);
      setTasks(prev);
      setError(`Complete failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }, [tasks]);

  // Close-with-reason (Stuck → "Older" zone). CANCELLED + the operator's
  // reason in history — a recorded decision to stop chasing, distinct from
  // completion and from engine auto-retirement.
  const handleCloseWithReason = useCallback(async (taskId: number, reason: string) => {
    const prev = tasks;
    const nowIso = new Date().toISOString();
    setTasks((ts) =>
      ts.map((t) =>
        t.id === taskId
          ? { ...t, status: "CANCELLED", completedAt: nowIso, viewBucket: "done" as const }
          : t
      )
    );
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "CANCELLED", note: `Closed from Smart View — ${reason}` }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      console.error("[MyWork] close failed:", e);
      setTasks(prev);
      setError(`Close failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }, [tasks]);

  // Bulk assign — one call for a whole pile/zone (reuses /api/tasks/bulk).
  const handleBulkReassign = useCallback(async (taskIds: number[], agentId: number) => {
    if (taskIds.length === 0) return;
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;
    const prev = tasks;
    const idSet = new Set(taskIds);
    setTasks((ts) =>
      ts.map((t) => (idSet.has(t.id) ? { ...t, assignedTo: { id: agent.id, name: agent.name } } : t))
    );
    try {
      const res = await fetch("/api/tasks/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: taskIds, action: "reassign", assignedToId: agentId }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      console.error("[MyWork] bulk reassign failed:", e);
      setTasks(prev);
      setError(`Bulk assign failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }, [tasks, agents]);

  // Guards against overlapping fetches — the live-refresh interval, focus
  // refetch, manual Refresh, and post-action onUpdate can all fire close
  // together; only one request set should be in flight at a time.
  const fetchInFlight = useRef(false);

  const fetchTasks = useCallback(async (background = false) => {
    if (fetchInFlight.current) return;
    fetchInFlight.current = true;
    // Background refreshes swap data in place — no spinner, no flicker.
    // The full-page loading state is reserved for the first paint.
    if (!background) setLoading(true);
    setError(null);
    try {
      // Per-view fetches — one bounded query per bucket so no bucket can
      // starve another at the row cap.
      //
      // History of this bug: a single `status=<active>&limit=500&sortBy=
      // appointmentTime asc` fetch fed every bucket. Sorted by appointment
      // ascending, the hundreds of STUCK tasks (earliest appointments)
      // consumed the entire 500 cap before the query ever reached today's
      // or tomorrow's later-dated appointments — so Tomorrow silently
      // showed 0 even though the tasks existed. Splitting active-vs-done
      // earlier only half-fixed it (stuck still starved today/tomorrow
      // inside the active fetch).
      //
      // The real fix: use the server's `?view=` SQL filter (day-based,
      // mirrors computeViewBucket) to fetch today / tomorrow / stuck
      // independently. The view filter already excludes terminal statuses,
      // so no status= param is needed for those three. Done-today is a
      // separate terminal+completedAfter fetch for the strips below Today.
      const terminalStatuses = "COMPLETED,CANCELLED";
      // completedAfter = today IST midnight as UTC ISO. Filters on
      // completedAt so engine-retired tasks (createdAt weeks old, closed
      // just now) are included in the done strips.
      const istOffsetMs = 5.5 * 60 * 60 * 1000;
      const istNow = Date.now() + istOffsetMs;
      const istMidnight = Math.floor(istNow / 86_400_000) * 86_400_000 - istOffsetMs;
      const todayMidnightIso = new Date(istMidnight).toISOString();

      const [todayRes, tomorrowRes, stuckRes, doneRes] = await Promise.all([
        fetch(`/api/tasks?view=today&limit=500&sortBy=appointmentTime&sortOrder=asc`),
        fetch(`/api/tasks?view=tomorrow&limit=300&sortBy=appointmentTime&sortOrder=asc`),
        fetch(`/api/tasks?view=stuck&limit=500&sortBy=appointmentTime&sortOrder=asc`),
        fetch(`/api/tasks?view=done&limit=300&sortBy=createdAt&sortOrder=desc&status=${terminalStatuses}&completedAfter=${encodeURIComponent(todayMidnightIso)}`),
      ]);
      for (const [r, label] of [[todayRes, "today"], [tomorrowRes, "tomorrow"], [stuckRes, "stuck"], [doneRes, "done"]] as const) {
        if (!r.ok) throw new Error(`HTTP ${r.status} (${label})`);
      }
      const [todayData, tomorrowData, stuckData, doneData] = await Promise.all([
        todayRes.json(), tomorrowRes.json(), stuckRes.json(), doneRes.json(),
      ]);
      // Merge + de-dup by id. The view buckets are mutually exclusive, but
      // a status transition between the parallel fetches could theoretically
      // surface a task in two — dedup guards that.
      const seen = new Set<number>();
      const merged: Task[] = [];
      for (const t of [
        ...(todayData.tasks ?? []),
        ...(tomorrowData.tasks ?? []),
        ...(stuckData.tasks ?? []),
        ...(doneData.tasks ?? []),
      ]) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        merged.push(t);
      }
      setTasks(merged);
      setLastUpdated(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tasks");
    } finally {
      setLoading(false);
      fetchInFlight.current = false;
    }
  }, []);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  // ── Live refresh ─────────────────────────────────────────────────────
  // The workspace re-syncs itself: a silent background refetch every 30s
  // (only while the tab is visible — a hidden dashboard shouldn't poll),
  // plus an immediate refetch the moment the tab regains focus. Combined
  // with the optimistic updates on Done/Assign, every view tracks the
  // engine within one interval of real time, with zero loading flicker
  // (background fetches swap data in place; the spinner is first-paint
  // only). Push (SSE/WS) was considered and rejected: the source data
  // only changes on poll-cycle writes and operator actions, so a socket
  // would add infrastructure without adding freshness.
  const LIVE_REFRESH_MS = 30_000;
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") fetchTasks(true);
    }, LIVE_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchTasks(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [fetchTasks]);

  // Apply filters first, then bucket. Filters narrow the entire workspace
  // (today/tomorrow/stuck counts all update together).
  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      // Assignee filter
      if (filterAssigneeId === "unassigned" && t.assignedTo) return false;
      if (typeof filterAssigneeId === "number" && t.assignedTo?.id !== filterAssigneeId) return false;
      // Order-type filter (empty set = all)
      if (filterTypes.size > 0 && !filterTypes.has(t.orderType)) return false;
      // Rule filter (empty set = all)
      if (filterRules.size > 0 && !filterRules.has(t.taskRuleId)) return false;
      // Store filter ("all" = off; matches metadata.storeName)
      if (filterStore !== "all" && storeNameOf(t) !== filterStore) return false;
      // Priority filter (empty set = all)
      if (filterPriorities.size > 0 && !filterPriorities.has(t.priority)) return false;
      // Risk band filter (empty set = all)
      if (filterRiskBands.size > 0 && !filterRiskBands.has(t.riskBand)) return false;
      // VIP filter
      if (filterVip === "vip" && !t.vip) return false;
      if (filterVip === "non-vip" && t.vip) return false;
      // Priority-order filter (isPriority = vip || risk HIGH/CRITICAL)
      if (filterPriorityOrders === "priority" && !t.isPriority) return false;
      if (filterPriorityOrders === "non-priority" && t.isPriority) return false;
      // Order-ID search (trimmed; empty = no filtering)
      const search = filterSearch.trim();
      if (search && !String(t.entityId).includes(search) && !t.title.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [
    tasks, filterAssigneeId, filterTypes, filterRules, filterStore, filterPriorities,
    filterRiskBands, filterVip, filterPriorityOrders, filterSearch,
  ]);

  const byBucket = useMemo(() => {
    const t = { today: [] as Task[], tomorrow: [] as Task[], stuck: [] as Task[] };
    for (const x of filteredTasks) {
      // COMPLETED/CANCELLED/RESOLVED tasks: route to today (they appear
      // in Today's "Done today" strip).
      if (x.viewBucket === "done") { t.today.push(x); continue; }

      // Server's "stuck" bucket: prior-day appointment still open (or a
      // no-appt task created before today) — direct to Stuck tab.
      if (x.viewBucket === "stuck") { t.stuck.push(x); continue; }

      // Day-based bucketing: bucketing is decided by the appointment's IST
      // calendar day server-side (computeViewBucket), NOT by whether the
      // clock has passed it. A same-day appointment that's already overdue
      // stays in Today (it surfaces in TodayView's NOW/overdue section) so
      // the team sees today's full workload all day instead of watching it
      // drain into Stuck. The old clock-based override that pushed
      // past-appointment-today tasks to Stuck has been removed — it emptied
      // Today as the day progressed.
      if (x.viewBucket === "today") t.today.push(x);
      else if (x.viewBucket === "tomorrow") t.tomorrow.push(x);
    }
    return t;
  }, [filteredTasks, now]);

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

  // Rules present in the unfiltered workspace, with a compact chip label
  // and per-rule task count (count reflects the unfiltered workspace so the
  // lead sees the true per-rule volume — "where is the pile" at a glance).
  // Long rule names like "HSC: Sample Handover to Lab (>30 min after
  // collection)" compress to "Sample Handover to Lab".
  const availableRules = useMemo(() => {
    const byId = new Map<string, { id: string; label: string; count: number }>();
    for (const t of tasks) {
      const id = t.taskRuleId;
      if (!id) continue;
      const existing = byId.get(id);
      if (existing) { existing.count++; continue; }
      const raw = t.taskRule?.name ?? (id === "MANUAL" ? "Manual tasks" : id);
      const label = raw.replace(/^[^:]*:\s*/, "").replace(/\s*\(.*$/, "").trim() || raw;
      byId.set(id, { id, label, count: 1 });
    }
    return Array.from(byId.values()).sort((a, b) => b.count - a.count);
  }, [tasks]);

  // Stores present in the workspace, by volume — powers the Store select.
  const availableStores = useMemo(() => {
    const byName = new Map<string, number>();
    for (const t of tasks) {
      const s = storeNameOf(t);
      if (!s) continue;
      byName.set(s, (byName.get(s) ?? 0) + 1);
    }
    return Array.from(byName.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [tasks]);

  const availablePriorities = useMemo(() => {
    const s = new Set<string>();
    for (const t of tasks) if (t.priority) s.add(t.priority);
    // Stable severity order regardless of insertion.
    const ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
    return Array.from(s).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  }, [tasks]);

  // Fixed severity order (not insertion order) — matches RiskBadge's own
  // LOW→CRITICAL sequence.
  const RISK_OPTIONS: Array<{ key: string; label: string; activeCls: string }> = [
    { key: "LOW", label: "Low", activeCls: "bg-zinc-600 border-zinc-600 text-white" },
    { key: "MEDIUM", label: "Medium", activeCls: "bg-yellow-600 border-yellow-600 text-white" },
    { key: "HIGH", label: "High", activeCls: "bg-orange-600 border-orange-600 text-white" },
    { key: "CRITICAL", label: "Critical", activeCls: "bg-red-600 border-red-600 text-white" },
  ];

  const anyFilterActive =
    filterAssigneeId !== "all" || filterTypes.size > 0 || filterRules.size > 0 ||
    filterStore !== "all" || filterPriorities.size > 0 ||
    filterRiskBands.size > 0 || filterVip !== "all" || filterPriorityOrders !== "all" ||
    filterSearch.trim() !== "";

  const clearAllFilters = () => {
    setFilterAssigneeId("all"); setFilterTypes(new Set()); setFilterRules(new Set());
    setFilterStore("all"); setFilterPriorities(new Set());
    setFilterRiskBands(new Set()); setFilterVip("all"); setFilterPriorityOrders("all");
    setFilterSearch("");
  };

  // Unassigned count for the chip badge (always reflects the unfiltered
  // workspace so the user sees the real "you have N unassigned" pulse).
  const unassignedCount = useMemo(
    () => tasks.filter((t) => !t.assignedTo).length,
    [tasks]
  );

  // Export the CURRENT view (all active filters already applied) to CSV. Scope
  // "all" = every open task across Today+Tomorrow+Stuck (so a High/Critical
  // risk filter captures ALL at-risk orders regardless of which tab is open);
  // a tab scope exports just that tab. Done tasks are excluded from "all".
  const openFiltered = useMemo(() => filteredTasks.filter((t) => t.viewBucket !== "done"), [filteredTasks]);
  const doExport = useCallback((scope: "all" | Tab) => {
    const list = scope === "all" ? openFiltered : byBucket[scope];
    if (!list.length) return;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    downloadCsv(`smartview-${scope}-${stamp}.csv`, tasksToCsv(list));
    setExportOpen(false);
  }, [openFiltered, byBucket]);

  const lastUpdatedRel = useMemo(() => {
    const sec = Math.floor((now.getTime() - lastUpdated.getTime()) / 1000);
    if (sec < 60) return "just now";
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
  }, [now, lastUpdated]);

  return (
    <div className="px-8 py-6 max-w-[1700px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Smart View</h1>
          {!isAgent && (
            <p className="text-sm text-zinc-500 mt-0.5">
              Your prioritized workday with risk, VIP and operational context — all in one place.
            </p>
          )}
          <div className="text-sm text-zinc-500 mt-1">
            {now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" })}
            <span className="mx-2">·</span>
            <span className="inline-flex items-center gap-1.5 text-zinc-400">
              <span className="relative flex h-2 w-2" aria-hidden>
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-60 motion-reduce:hidden" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
              Live · updated {lastUpdatedRel}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isAgent && (
            <div className="relative">
              <button
                onClick={() => setExportOpen((o) => !o)}
                disabled={loading || openFiltered.length === 0}
                className="px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
                title="Download the current view (filters applied) as CSV / Excel"
              >
                ⤓ Export
              </button>
              {exportOpen && (
                <>
                  <button className="fixed inset-0 z-40 cursor-default" aria-label="Close export menu" onClick={() => setExportOpen(false)} />
                  <div className="absolute right-0 mt-1 z-50 w-64 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl p-1 text-sm">
                    <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">Export to CSV · filters applied</div>
                    <button onClick={() => doExport("all")} className="w-full text-left px-3 py-2 rounded hover:bg-zinc-800 text-zinc-200 flex items-center justify-between gap-2">
                      <span>All open <span className="text-zinc-500">(Today + Tomorrow + Stuck)</span></span>
                      <span className="text-zinc-500 tabular-nums">{openFiltered.length}</span>
                    </button>
                    <button onClick={() => doExport(tab)} className="w-full text-left px-3 py-2 rounded hover:bg-zinc-800 text-zinc-200 flex items-center justify-between gap-2">
                      <span>Current tab <span className="text-zinc-500 capitalize">({tab})</span></span>
                      <span className="text-zinc-500 tabular-nums">{byBucket[tab].length}</span>
                    </button>
                    <div className="px-3 py-1.5 text-[11px] text-zinc-600 leading-snug border-t border-zinc-800 mt-1">
                      Tip: filter <b className="text-zinc-400">Risk → High / Critical</b> first to export exactly the at-risk orders.
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          <button
            onClick={() => fetchTasks()}
            disabled={loading}
            className="px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
          >
            ⟳ Refresh
          </button>
        </div>
      </div>

      {/* Sticky control deck — filter bar + tab strip pin to the top of
          the scroll container so slicing/switching never requires
          scrolling back up through a long task list. The title row above
          scrolls away (it holds no controls the deck needs). Semi-opaque
          bg + blur masks rows passing underneath. */}
      <div className="sticky top-0 z-30 -mx-8 px-8 pt-2 bg-zinc-950/95 backdrop-blur-sm">

      {/* Filter bar — Lead's main tool for slicing the workspace.
          Sits above tabs so filters persist across Today/Tomorrow/Stuck.
          Hidden for agents (their queue is small enough that filters add
          noise rather than value). */}
      {!isAgent && (
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 mb-4">
        {/* Assignee / Type / Rule / Store / Task Priority — one row of
            uniform dropdown cards. Each still drives the same Set/string
            filter state the board's filteredTasks predicate already reads;
            only the control surface changed from mixed chips+selects. */}
        <div className="flex items-stretch gap-3 flex-wrap">
          <FilterCard
            label="Assignee"
            value={typeof filterAssigneeId === "number" ? String(filterAssigneeId) : filterAssigneeId}
            onChange={(v) => {
              if (v === "all" || v === "unassigned") setFilterAssigneeId(v);
              else setFilterAssigneeId(parseInt(v, 10));
            }}
            options={[
              { value: "all", label: `All team (${tasks.length})` },
              { value: "unassigned", label: `⚠ Unassigned (${unassignedCount})` },
              ...agents.map((a) => ({ value: String(a.id), label: a.name })),
            ]}
          />

          {availableTypes.length > 1 && (
            <FilterCard
              label="Type"
              value={filterTypes.size === 1 ? Array.from(filterTypes)[0] : "all"}
              onChange={(v) => setFilterTypes(v === "all" ? new Set() : new Set([v]))}
              options={[
                { value: "all", label: "All types" },
                ...availableTypes.map((t) => ({ value: t, label: typeLabel(t) })),
              ]}
            />
          )}

          {availableRules.length > 1 && (
            <FilterCard
              label="Rule"
              value={filterRules.size === 1 ? Array.from(filterRules)[0] : "all"}
              onChange={(v) => setFilterRules(v === "all" ? new Set() : new Set([v]))}
              options={[
                { value: "all", label: "All rules" },
                ...availableRules.map((r) => ({ value: r.id, label: `${r.label} (${r.count})` })),
              ]}
            />
          )}

          {availableStores.length > 1 && (
            <FilterCard
              label="Store"
              value={filterStore}
              onChange={setFilterStore}
              options={[
                { value: "all", label: "All stores" },
                ...availableStores.map((s) => ({ value: s.name, label: `${s.name} (${s.count})` })),
              ]}
            />
          )}

          {availablePriorities.length > 1 && (
            <FilterCard
              label="Task Priority"
              value={filterPriorities.size === 1 ? Array.from(filterPriorities)[0] : "all"}
              onChange={(v) => setFilterPriorities(v === "all" ? new Set() : new Set([v]))}
              options={[
                { value: "all", label: "All priorities" },
                ...availablePriorities.map((p) => ({ value: p, label: p.charAt(0) + p.slice(1).toLowerCase() })),
              ]}
            />
          )}
        </div>
      </div>
      )}

      {/* Priority workspace bar — Risk/VIP/Priority slicing, kept visually
          distinct from the operational filters above (blue ring matches the
          Focus zone's own accent) since this is the lens this whole board
          was built around. */}
      {!isAgent && (
      <div className="bg-zinc-900 border border-blue-900/40 ring-1 ring-blue-900/20 rounded-lg p-3 mb-4 flex items-center gap-4 flex-wrap">
        {/* Priority-orders tri-state (isPriority = vip || risk HIGH/CRITICAL) */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider mr-1">Priority Orders</span>
          {(["all", "priority", "non-priority"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setFilterPriorityOrders(v)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                filterPriorityOrders === v
                  ? "bg-blue-600 border-blue-600 text-white"
                  : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {v === "all" ? "All" : v === "priority" ? "Priority only" : "Non-priority"}
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-zinc-800" />

        {/* Risk-band chips — tri-state-style single-select, same pattern as
            the VIP chips below: exactly one of All/Low/Medium/High/Critical
            is active at a time, not an accumulating multi-select. */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider mr-1">Risk</span>
          <button
            onClick={() => setFilterRiskBands(new Set())}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              filterRiskBands.size === 0
                ? "bg-blue-600 border-blue-600 text-white"
                : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            All
          </button>
          {RISK_OPTIONS.map(({ key, label, activeCls }) => {
            const active = filterRiskBands.has(key);
            return (
              <button
                key={key}
                onClick={() => setFilterRiskBands(new Set([key]))}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  active ? activeCls : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div className="w-px h-5 bg-zinc-800" />

        {/* VIP tri-state */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider mr-1">VIP</span>
          {(["all", "vip", "non-vip"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setFilterVip(v)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                filterVip === v
                  ? "bg-amber-600 border-amber-600 text-white"
                  : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {v === "all" ? "All" : v === "vip" ? "VIP" : "Non-VIP"}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Order-ID search — narrows the current tab's list client-side */}
        <input
          type="text"
          value={filterSearch}
          onChange={(e) => setFilterSearch(e.target.value)}
          placeholder="Search order ID…"
          className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 w-48 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />

        {anyFilterActive && (
          <button onClick={clearAllFilters} className="text-xs text-zinc-500 hover:text-zinc-200">
            Clear filters
          </button>
        )}
      </div>
      )}

      {!isAgent && <SmartViewSummary tasks={byBucket[tab]} />}

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

      {/* end sticky control deck */}
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
              onComplete={handleComplete}
              onBulkReassign={handleBulkReassign}
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
              onComplete={handleComplete}
              onBulkReassign={handleBulkReassign}
              onCloseWithReason={handleCloseWithReason}
            />
          )}
        </>
      )}

      {/* Task drawer — role-aware.
          - Agents: TaskDetailPanel in a slide-over. Full actions
            (start / complete checklist / snooze / flag for help / done).
            This is their daily workflow.
          - Heads / Admins: OrderQuickView. Read-only context — order
            details, related OpsFlow tasks, history. Heads oversee; they
            shouldn't be marking tasks complete from a monitoring view.
            They have the Reassign popover on the row for the one
            intervention they actually need from here. */}
      {selectedTask && isAgent && (
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
      {selectedTask && !isAgent && (
        <OrderQuickView
          orderId={selectedTask.entityId}
          onClose={() => setSelectedTask(null)}
          priority={{
            riskScore: selectedTask.riskScore,
            riskBand: selectedTask.riskBand,
            riskReasons: selectedTask.riskReasons,
            riskUnavailable: selectedTask.riskUnavailable,
            vip: selectedTask.vip,
            vipReasons: selectedTask.vipReasons,
            vipUnavailable: selectedTask.vipUnavailable,
            isPriority: selectedTask.isPriority,
          }}
          taskPriority={selectedTask.priority}
        />
      )}
    </div>
  );
}
