"use client";

import { useState } from "react";
import SlaCountdown from "@/components/shared/SlaCountdown";
import SLADisplay from "@/components/shared/SLADisplay";
import PriorityBadge from "@/components/shared/PriorityBadge";
import StatusBadge from "@/components/shared/StatusBadge";
import OrderQuickView from "@/components/shared/OrderQuickView";
import AssignmentAuditTrail from "@/components/shared/AssignmentAuditTrail";
import { formatISTTimestamp } from "@/lib/utils/timezone";

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
  slaDeadline: string;
  slaBreachedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  assignedAt: string | null;
  startedAt: string | null;
  metadata: Record<string, unknown>;
  assignedTo: { id: number; name: string } | null;
  checklistItems: ChecklistItem[];
  taskType: { name: string; label: string };
}

interface TaskDetailPanelProps {
  task: Task;
  onUpdate: () => void;
}

// W3 — "Why this task?" panel.
// Reads `metadata.whyThisTask`, which the engine stamps onto the task at
// creation time (see taskCreator.ts). For older tasks (created before W3
// shipped) the block is missing and the panel renders a graceful fallback.
function WhyThisTask({ metadata }: { metadata: Record<string, unknown> | null | undefined }) {
  const why = (metadata && (metadata.whyThisTask as
    | {
        ruleName?: string;
        ruleId?: string;
        triggerType?: "STATUS" | "TIME";
        matchedFacts?: { check: string; detail: string }[];
        evaluatedAt?: string;
      }
    | undefined)) || null;

  // Graceful fallback for legacy tasks: still show "Why this task?" with
  // whatever rule context is on hand, so the section header isn't a lie.
  if (!why || !why.ruleName) {
    const manual = (metadata as Record<string, unknown> | null)?.manual === true;
    return (
      <div>
        <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
          Why this task?
        </h3>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-500">
          {manual
            ? "Created manually by an Ops Head."
            : "Trigger details not recorded for this task (created before this surface was added)."}
        </div>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
        Why this task?
      </h3>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-3 space-y-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-wider text-zinc-600">Rule</span>
          <span className="text-sm font-medium text-zinc-100">{why.ruleName}</span>
          {why.triggerType && (
            <span className="text-[10px] uppercase tracking-wider text-zinc-600 ml-auto">
              {why.triggerType}-triggered
            </span>
          )}
        </div>
        {why.matchedFacts && why.matchedFacts.length > 0 && (
          <ul className="space-y-1 pl-1">
            {why.matchedFacts.map((f, i) => (
              <li key={i} className="text-xs text-zinc-300 flex gap-2">
                <span className="text-zinc-600 shrink-0">•</span>
                <span>{f.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const NEXT_STATUS: Record<string, { label: string; status: string; cls: string }[]> = {
  ASSIGNED: [{ label: "Start Task", status: "IN_PROGRESS", cls: "bg-blue-600 hover:bg-blue-500 text-white" }],
  CREATED: [{ label: "Start Task", status: "IN_PROGRESS", cls: "bg-blue-600 hover:bg-blue-500 text-white" }],
  IN_PROGRESS: [
    { label: "Mark Complete", status: "COMPLETED", cls: "bg-green-600 hover:bg-green-500 text-white" },
    { label: "Mark Blocked", status: "BLOCKED", cls: "bg-amber-600 hover:bg-amber-500 text-white" },
  ],
  BLOCKED: [
    { label: "Resume", status: "IN_PROGRESS", cls: "bg-blue-600 hover:bg-blue-500 text-white" },
    { label: "Mark Complete", status: "COMPLETED", cls: "bg-green-600 hover:bg-green-500 text-white" },
  ],
  BREACHED: [
    { label: "Resume", status: "IN_PROGRESS", cls: "bg-blue-600 hover:bg-blue-500 text-white" },
    { label: "Mark Complete", status: "COMPLETED", cls: "bg-green-600 hover:bg-green-500 text-white" },
  ],
};

export default function TaskDetailPanel({ task, onUpdate }: TaskDetailPanelProps) {
  // W2 — standalone Note field removed. Status changes no longer carry a
  // freeform note from the agent; the system records each transition with
  // a default reason ("Flagged for help", auto-generated SLA notes, etc).
  // If users need richer communication, the future in-task chat (Phase 4)
  // is the channel for that.
  const [loading, setLoading] = useState<string | null>(null);
  const [showOrderView, setShowOrderView] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displayedTask, setDisplayedTask] = useState<Task>(task);

  const meta = displayedTask.metadata;
  const actions = NEXT_STATUS[displayedTask.status] ?? [];

  async function updateStatus(status: string) {
    setLoading(status);
    setError(null);

    // Optimistic update: update UI immediately
    const previousTask = displayedTask;
    setDisplayedTask({ ...displayedTask, status });

    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to update task status");
      }

      const data = await res.json();
      // Update with server response to ensure consistency
      setDisplayedTask(data.task);
      onUpdate();
    } catch (err) {
      // Revert optimistic update on error
      setDisplayedTask(previousTask);
      setError(err instanceof Error ? err.message : "Failed to update task");
      console.error("[TaskDetailPanel] updateStatus error:", err);
    } finally {
      setLoading(null);
    }
  }

  // saveNote() removed in W2 — see comment on `loading` declaration above.

  async function flagForHelp() {
    setLoading("flag");
    setError(null);

    // Optimistic update
    const previousTask = displayedTask;
    setDisplayedTask({ ...displayedTask, status: "BLOCKED" });

    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "BLOCKED", note: "Flagged for help" }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to flag task");
      }

      const data = await res.json();
      setDisplayedTask(data.task);
      onUpdate();
    } catch (err) {
      setDisplayedTask(previousTask);
      setError(err instanceof Error ? err.message : "Failed to flag task");
      console.error("[TaskDetailPanel] flagForHelp error:", err);
    } finally {
      setLoading(null);
    }
  }

  async function toggleChecklist(itemId: number, isDone: boolean) {
    setLoading(`check-${itemId}`);
    setError(null);

    // Optimistic update: update checklist item immediately
    const previousTask = displayedTask;
    const updatedChecklistItems = displayedTask.checklistItems.map((item) =>
      item.id === itemId ? { ...item, isDone, doneAt: isDone ? new Date().toISOString() : null } : item
    );
    setDisplayedTask({ ...displayedTask, checklistItems: updatedChecklistItems });

    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checklistItemId: itemId, isDone }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to update checklist");
      }

      const data = await res.json();
      setDisplayedTask(data.task);
      onUpdate();
    } catch (err) {
      // Revert optimistic update on error
      setDisplayedTask(previousTask);
      setError(err instanceof Error ? err.message : "Failed to update checklist");
      console.error("[TaskDetailPanel] toggleChecklist error:", err);
    } finally {
      setLoading(null);
    }
  }

  const doneItems = displayedTask.checklistItems.filter((i) => i.isDone).length;
  const totalItems = displayedTask.checklistItems.length;
  const progressPct = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 0;

  const isTerminal = displayedTask.status === "COMPLETED" || displayedTask.status === "CANCELLED";
  const canFlag = !isTerminal && displayedTask.status !== "BLOCKED";

  return (
    <div className="flex flex-col h-full bg-zinc-950">
      {/* Error alert */}
      {error && (
        <div className="mx-6 mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2">
          <svg className="w-4 h-4 text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4v.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-xs text-red-400">{error}</span>
          <button
            onClick={() => setError(null)}
            className="ml-auto text-red-400 hover:text-red-300"
          >
            ✕
          </button>
        </div>
      )}

      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-zinc-800">
        <div className="flex items-start gap-3 mb-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-white leading-snug">{displayedTask.title}</h2>
            <div className="flex items-center gap-2 mt-1.5">
              <StatusBadge status={displayedTask.status} />
              <PriorityBadge priority={displayedTask.priority} size="sm" />
              <button
                onClick={() => setShowOrderView(true)}
                className="text-xs text-blue-400 hover:text-blue-300 hover:underline transition-colors"
                title="View order details"
              >
                Order #{displayedTask.entityId}
              </button>
            </div>
          </div>
          {/* Flag for help */}
          {canFlag && (
            <button
              onClick={flagForHelp}
              disabled={!!loading}
              title="Flag for help (marks as Blocked)"
              className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors text-xs font-medium disabled:opacity-50"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2zm9-13.5V9" />
              </svg>
              {loading === "flag" ? "..." : "Flag"}
            </button>
          )}
        </div>

        {/* SLA */}
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${
          displayedTask.status === "BREACHED" || new Date(displayedTask.slaDeadline) < new Date()
            ? "bg-red-500/10 border border-red-500/20"
            : new Date(displayedTask.slaDeadline).getTime() - Date.now() < 10 * 60_000
            ? "bg-amber-500/10 border border-amber-500/20"
            : "bg-zinc-900 border border-zinc-800"
        }`}>
          <svg className="w-3.5 h-3.5 text-zinc-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-xs text-zinc-400">SLA deadline: </span>
          <SlaCountdown deadline={displayedTask.slaDeadline} completedAt={displayedTask.completedAt ?? undefined} />
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">

        {/* Order metadata */}
        <div>
          <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Order Details</h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {[
              { label: "Patient", value: meta.patientName as string },
              { label: "Order Type", value: displayedTask.orderType.replace("_", " ") },
              { label: "Lab", value: (meta.labName as string) || "—" },
              { label: "Store", value: (meta.storeName as string) || "—" },
              { label: "Phlebo", value: (meta.phleboName as string) || "Not assigned" },
              { label: "Phone", value: (meta.phleboNumber as string) || "—" },
              {
                label: "Appointment",
                value: meta.appointmentTime
                  ? formatISTTimestamp(meta.appointmentTime as string, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })
                  : "—",
              },
              { label: "Order Status", value: (meta.orderStatus as string) ?? "—" },
            ].map(({ label, value }) => (
              <div key={label}>
                <div className="text-[10px] text-zinc-600 uppercase tracking-wider">{label}</div>
                <div className="text-sm text-zinc-200 mt-0.5">{value}</div>
              </div>
            ))}
          </div>
        </div>

        {/* W3 — Why this task? */}
        <WhyThisTask metadata={displayedTask.metadata} />

        {/* Phase 2 Feature 7: SLA Timeline Context - Not yet implemented */}
        {/* Uncomment when Phase 2 features are added
        {displayedTask.slaContext && (
          <SLADisplay
            slaContext={displayedTask.slaContext as any}
            slaStatus={displayedTask.slaStatus}
            mode="expanded"
          />
        )}
        */}

        {/* Phase 2: Assignment Audit Trail */}
        <AssignmentAuditTrail
          audit={displayedTask.metadata?.assignmentAudit as any}
          currentAssignee={displayedTask.assignedTo}
          taskId={displayedTask.id}
        />

        {/* Checklist */}
        {displayedTask.checklistItems.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                Checklist
              </h3>
              <span className="text-xs text-zinc-500">
                {doneItems}/{totalItems}
              </span>
            </div>

            {/* Progress bar */}
            <div className="h-1 bg-zinc-800 rounded-full mb-3 overflow-hidden">
              <div
                className="h-full bg-green-500 rounded-full transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>

            <div className="space-y-2">
              {displayedTask.checklistItems.map((item) => (
                <label
                  key={item.id}
                  className={`flex items-start gap-3 cursor-pointer group ${
                    isTerminal ? "cursor-default" : ""
                  }`}
                >
                  <div className="mt-0.5 shrink-0">
                    <input
                      type="checkbox"
                      checked={item.isDone}
                      disabled={isTerminal || loading === `check-${item.id}`}
                      onChange={(e) => toggleChecklist(item.id, e.target.checked)}
                      className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-green-500 focus:ring-green-500 focus:ring-offset-zinc-900 cursor-pointer"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className={`text-sm leading-snug ${
                      item.isDone ? "text-zinc-500 line-through" : "text-zinc-200"
                    }`}>
                      {item.stepText}
                    </span>
                    {item.isRequired && !item.isDone && (
                      <span className="ml-1.5 text-[10px] text-red-400 font-medium">required</span>
                    )}
                  </div>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* W2 — standalone Note field removed (was a UX trap: users assumed
            status-change saved the note too). Status changes now stand on
            their own; future in-task chat will be the comm channel. */}
      </div>

      {/* Action buttons */}
      {!isTerminal && actions.length > 0 && (
        <div className="px-6 py-4 border-t border-zinc-800 flex gap-2">
          {actions.map((action) => (
            <button
              key={action.status}
              onClick={() => updateStatus(action.status)}
              disabled={!!loading}
              className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${action.cls}`}
            >
              {loading === action.status ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Saving...
                </span>
              ) : (
                action.label
              )}
            </button>
          ))}
        </div>
      )}

      {isTerminal && (
        <div className="px-6 py-4 border-t border-zinc-800">
          <div className="flex items-center gap-2 text-xs text-zinc-600">
            <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Task {task.status.toLowerCase()}
          </div>
        </div>
      )}

      {/* Order quick-view slide-over */}
      {showOrderView && (
        <OrderQuickView
          orderId={displayedTask.entityId}
          onClose={() => setShowOrderView(false)}
        />
      )}
    </div>
  );
}
