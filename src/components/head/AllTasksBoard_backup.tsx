"use client";

import { useEffect, useState, useCallback } from "react";
import SlaCountdown from "@/components/shared/SlaCountdown";
import PriorityBadge from "@/components/shared/PriorityBadge";
import StatusBadge from "@/components/shared/StatusBadge";
import OrderQuickView from "@/components/shared/OrderQuickView";

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
  assignedTo: { id: number; name: string } | null;
  taskType: { name: string; label: string };
  metadata: Record<string, unknown>;
  // Foundation Features
  slaStatus?: "safe" | "warning" | "critical" | "breached";
  minutesRemaining?: number;
  assignmentMethod?: string;
  assignmentRuleId?: string;
}

interface Agent {
  id: number;
  name: string;
}

const STATUS_OPTIONS = ["", "CREATED", "ASSIGNED", "IN_PROGRESS", "BLOCKED", "BREACHED", "COMPLETED", "CANCELLED"];
const PRIORITY_OPTIONS = ["", "URGENT", "HIGH", "MEDIUM", "LOW"];
const TERMINAL_STATUSES = ["COMPLETED", "CANCELLED"];

export default function AllTasksBoard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [sortBy, setSortBy] = useState<"createdAt" | "appointmentTime" | "slaDeadline" | "status" | "priority">("priority");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [archiveStats, setArchiveStats] = useState<{ activeTasks: number; archivedTasks: number } | null>(null);

  // Foundation Feature: Refresh button + timestamp
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [lastUpdatedDisplay, setLastUpdatedDisplay] = useState<string>("now");

  // Foundation Feature: Status distribution widget
  const [statusDistribution, setStatusDistribution] = useState<Record<string, number> | null>(null);

  // Bulk selection
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkAction, setBulkAction] = useState<"reassign" | "cancel" | "block" | "">("");
  const [bulkAssigneeId, setBulkAssigneeId] = useState<number | "">("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkSuccess, setBulkSuccess] = useState<string | null>(null);

  // Order quick-view
  const [quickViewOrderId, setQuickViewOrderId] = useState<number | null>(null);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (priorityFilter) params.set("priority", priorityFilter);
      params.set("page", String(page));
      params.set("limit", "25");
      params.set("sortBy", sortBy);
      params.set("sortOrder", sortOrder);
      const res = await fetch(`/api/tasks?${params}`);
      if (!res.ok) {
        console.error(`[fetchTasks] HTTP ${res.status}`);
        setTasks([]);
        setTotalPages(1);
        setTotal(0);
        return;
      }
      const data = await res.json();
      setTasks(data.tasks ?? []);
      setTotalPages(data.pagination?.pages ?? 1);
      setTotal(data.pagination?.total ?? 0);
    } catch (err) {
      console.error("[fetchTasks] Error:", err);
      setTasks([]);
      setTotalPages(1);
      setTotal(0);
    } finally {
      setLoading(false);
      setSelected(new Set());
    }
  }, [statusFilter, priorityFilter, sortBy, sortOrder, page]);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  // Fetch agents for reassign dropdown (once)
  useEffect(() => {
    fetch("/api/roster").then((r) => r.json()).then((d) => {
      setAgents(
        (d.members ?? [])
          .filter((m: { rosterEntry?: { status: string } | null }) =>
            m.rosterEntry?.status === "ACTIVE" || m.rosterEntry?.status === "ON_FIELD"
          )
          .map((m: { userId: number; name: string }) => ({ id: m.userId, name: m.name }))
      );
    }).catch(() => {});
  }, []);

  // Fetch archive stats (once)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/tasks/archive");
        if (!res.ok) {
          console.warn(`[AllTasksBoard] Archive stats HTTP ${res.status}`);
          return;
        }
        const data = await res.json();
        console.log("[AllTasksBoard] Archive stats response:", data);

        if (data.stats && Array.isArray(data.stats)) {
          const stats = data.stats;
          const archiveData = {
            activeTasks: stats.find((s: any) => s.category === "Active Tasks")?.count ?? 0,
            archivedTasks: stats.find((s: any) => s.category === "Archived Tasks")?.count ?? 0,
          };
          console.log("[AllTasksBoard] Setting archive stats:", archiveData);
          setArchiveStats(archiveData);
        } else {
          console.warn("[AllTasksBoard] Unexpected stats format:", data);
        }
      } catch (err) {
        console.error("[AllTasksBoard] Archive stats fetch error:", err);
      }
    })();
  }, []);

  // ── Selection helpers ─────────────────────────────────────────────────────
  const nonTerminalIds = tasks
    .filter((t) => !TERMINAL_STATUSES.includes(t.status))
    .map((t) => t.id);

  function toggleAll() {
    if (selected.size === nonTerminalIds.length && nonTerminalIds.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(nonTerminalIds));
    }
  }

  function toggleOne(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // ── Bulk action ───────────────────────────────────────────────────────────
  async function executeBulk() {
    if (!bulkAction || selected.size === 0) return;
    if (bulkAction === "reassign" && !bulkAssigneeId) {
      setBulkError("Select an agent to reassign to");
      return;
    }
    setBulkLoading(true);
    setBulkError(null);
    setBulkSuccess(null);
    try {
      const res = await fetch("/api/tasks/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: Array.from(selected),
          action: bulkAction,
          assignedToId: bulkAction === "reassign" ? Number(bulkAssigneeId) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Bulk action failed");
      setBulkSuccess(`${data.affected} tasks updated`);
      setBulkAction("");
      setBulkAssigneeId("");
      setSelected(new Set());
      fetchTasks();
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBulkLoading(false);
    }
  }

  const allNonTerminalSelected =
    nonTerminalIds.length > 0 && nonTerminalIds.every((id) => selected.has(id));

  return (
    <div className="h-full flex flex-col bg-zinc-950">
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-zinc-800 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-base font-semibold text-white">Active Tasks</h1>
            <div className="flex gap-4 mt-2">
              <div>
                <p className="text-xs text-zinc-500">Currently active</p>
                <p className="text-sm font-semibold text-blue-400">{total} tasks</p>
              </div>
              {archiveStats && archiveStats.archivedTasks > 0 && (
                <div className="border-l border-zinc-700 pl-4">
                  <p className="text-xs text-zinc-500">In archive</p>
                  <p className="text-sm font-semibold text-zinc-400">{archiveStats.archivedTasks} tasks</p>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
              className="text-xs bg-zinc-900 border border-zinc-700 text-zinc-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">All statuses</option>
              {STATUS_OPTIONS.filter(Boolean).map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
              ))}
            </select>
            <select
              value={priorityFilter}
              onChange={(e) => { setPriorityFilter(e.target.value); setPage(1); }}
              className="text-xs bg-zinc-900 border border-zinc-700 text-zinc-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">All priorities</option>
              {PRIORITY_OPTIONS.filter(Boolean).map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>

            {/* Sort Controls */}
            <div className="flex items-center gap-1.5 border-l border-zinc-700 pl-2 ml-1">
              <label htmlFor="sort-by" className="text-xs text-zinc-500 font-medium">
                Sort:
              </label>
              <select
                id="sort-by"
                value={sortBy}
                onChange={(e) => {
                  setSortBy(e.target.value as typeof sortBy);
                  setPage(1);
                }}
                className="text-xs bg-zinc-900 border border-zinc-700 text-zinc-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="priority">Priority</option>
                <option value="createdAt">Created Date</option>
                <option value="appointmentTime">Appointment Date</option>
                <option value="slaDeadline">SLA Deadline</option>
                <option value="status">Status</option>
              </select>

              <button
                onClick={() => {
                  setSortOrder(sortOrder === "asc" ? "desc" : "asc");
                  setPage(1);
                }}
                className="px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded-lg text-xs text-zinc-300 hover:bg-zinc-800 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors font-medium"
                title={sortOrder === "asc" ? "Ascending" : "Descending"}
              >
                {sortOrder === "asc" ? "↑ ASC" : "↓ DESC"}
              </button>
            </div>

            {archiveStats && (
              <a
                href="/head/archive"
                className="text-sm font-medium bg-yellow-600/20 border border-yellow-600/40 text-yellow-300 hover:text-yellow-200 hover:bg-yellow-600/30 hover:border-yellow-600/60 rounded-lg px-3 py-1.5 transition-colors ml-auto"
              >
                📦 Archive {archiveStats.archivedTasks > 0 && `(${archiveStats.archivedTasks})`}
              </a>
            )}
          </div>
        </div>

        {/* Bulk action toolbar — shown when ≥1 task selected */}
        {selected.size > 0 && (
          <div className="flex items-center gap-2 py-2 px-3 bg-blue-600/10 border border-blue-500/20 rounded-lg flex-wrap">
            <span className="text-xs font-medium text-blue-400">{selected.size} selected</span>
            <div className="h-3 w-px bg-blue-500/30" />
            <select
              value={bulkAction}
              onChange={(e) => { setBulkAction(e.target.value as typeof bulkAction); setBulkError(null); }}
              className="text-xs bg-zinc-900 border border-zinc-700 text-zinc-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">Choose action…</option>
              <option value="reassign">Reassign</option>
              <option value="block">Mark Blocked</option>
              <option value="cancel">Cancel</option>
            </select>

            {bulkAction === "reassign" && (
              <select
                value={bulkAssigneeId}
                onChange={(e) => setBulkAssigneeId(e.target.value ? Number(e.target.value) : "")}
                className="text-xs bg-zinc-900 border border-zinc-700 text-zinc-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">Select agent…</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            )}

            <button
              onClick={executeBulk}
              disabled={bulkLoading || !bulkAction}
              className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/40 text-white text-xs font-medium rounded transition-colors flex items-center gap-1.5"
            >
              {bulkLoading && <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
              Apply
            </button>
            <button
              onClick={() => { setSelected(new Set()); setBulkAction(""); setBulkError(null); }}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Clear
            </button>

            {bulkError && <span className="text-xs text-red-400">{bulkError}</span>}
            {bulkSuccess && <span className="text-xs text-emerald-400">{bulkSuccess}</span>}
          </div>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-5 h-5 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
          </div>
        ) : (
          <table className="w-full">
            <thead className="sticky top-0 bg-zinc-900 z-10">
              <tr className="border-b border-zinc-800">
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={allNonTerminalSelected}
                    onChange={toggleAll}
                    className="rounded border-zinc-600 bg-zinc-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-zinc-900"
                  />
                </th>
                {["Task", "Type", "Status", "Priority", "SLA", "Assigned To", "Order"].map((h) => (
                  <th key={h} className="text-left text-[10px] font-semibold text-zinc-500 uppercase tracking-wider px-4 py-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {tasks.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-sm text-zinc-600">
                    No tasks match your filters
                  </td>
                </tr>
              ) : (
                tasks.map((task) => {
                  const isTerminal = TERMINAL_STATUSES.includes(task.status);
                  const isSelected = selected.has(task.id);
                  return (
                    <tr
                      key={task.id}
                      className={`hover:bg-zinc-900/50 transition-colors ${isSelected ? "bg-blue-600/5" : ""}`}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={isTerminal}
                          onChange={() => toggleOne(task.id)}
                          className="rounded border-zinc-600 bg-zinc-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-zinc-900 disabled:opacity-30"
                        />
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        <div className="text-sm font-medium text-zinc-100 line-clamp-1">{task.title}</div>
                        <div className="text-[10px] text-zinc-600 mt-0.5">#{task.id}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-zinc-400">{task.taskType.label}</span>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={task.status} />
                      </td>
                      <td className="px-4 py-3">
                        <PriorityBadge priority={task.priority} />
                      </td>
                      <td className="px-4 py-3">
                        <SlaCountdown deadline={task.slaDeadline} compact />
                      </td>
                      <td className="px-4 py-3">
                        {task.assignedTo ? (
                          <span className="text-xs text-zinc-300">{task.assignedTo.name}</span>
                        ) : (
                          <span className="text-xs text-zinc-600 italic">Unassigned</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setQuickViewOrderId(task.entityId)}
                          className="text-sm font-semibold text-blue-300 hover:text-blue-200 hover:underline transition-colors"
                        >
                          #{task.entityId}
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="px-6 py-3 border-t border-zinc-800 flex items-center justify-between">
          <span className="text-xs text-zinc-500">Page {page} of {totalPages}</span>
          <div className="flex gap-1.5">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-400 hover:text-zinc-200 disabled:opacity-40 transition-colors"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="px-3 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-400 hover:text-zinc-200 disabled:opacity-40 transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Order Quick-View */}
      {quickViewOrderId !== null && (
        <OrderQuickView
          orderId={quickViewOrderId}
          onClose={() => setQuickViewOrderId(null)}
        />
      )}
    </div>
  );
}
