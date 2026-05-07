"use client";

import { useEffect, useState, useCallback } from "react";
import SlaCountdown from "@/components/shared/SlaCountdown";
import SLADisplay from "@/components/shared/SLADisplay";
import EmptyStateMessage from "@/components/shared/EmptyStateMessage";
import TaskAgingIndicator from "@/components/shared/TaskAgingIndicator";
import KanbanBoard from "@/components/shared/KanbanBoard";
import PriorityBadge from "@/components/shared/PriorityBadge";
import StatusBadge from "@/components/shared/StatusBadge";
import ClickableStatusBadge from "@/components/shared/ClickableStatusBadge";
import OrderQuickView from "@/components/shared/OrderQuickView";
import UnifiedFilterBar from "@/components/shared/UnifiedFilterBar";

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
  slaStatus?: "safe" | "warning" | "critical" | "breached";
  minutesRemaining?: number;
  assignmentMethod?: string;
  assignmentRuleId?: string;
  // Multi-source fields
  source?: string;
  sourceType?: string;
  sourceStatus?: string;
  sourceEntityId?: number;
}

interface Agent {
  id: number;
  name: string;
}

interface StatusDistribution {
  CREATED: number;
  ASSIGNED: number;
  IN_PROGRESS: number;
  BLOCKED: number;
  BREACHED: number;
  COMPLETED: number;
  CANCELLED: number;
}

const STATUS_OPTIONS = ["", "CREATED", "ASSIGNED", "IN_PROGRESS", "BLOCKED", "BREACHED", "COMPLETED", "CANCELLED"];
const PRIORITY_OPTIONS = ["", "URGENT", "HIGH", "MEDIUM", "LOW"];
const TERMINAL_STATUSES = ["COMPLETED", "CANCELLED"];

// Feature 3: Color-coded urgency mapping
const getSlaRowColor = (slaStatus?: string): string => {
  switch (slaStatus) {
    case "safe":
      return "bg-green-500/10 hover:bg-green-500/15";
    case "warning":
      return "bg-yellow-500/10 hover:bg-yellow-500/15";
    case "critical":
      return "bg-orange-500/10 hover:bg-orange-500/15";
    case "breached":
      return "bg-red-500/10 hover:bg-red-500/15";
    default:
      return "hover:bg-zinc-900/50";
  }
};

interface AppliedFilters {
  status?: string[];
  priority?: string[];
  assigneeId?: number[];
  dateFrom?: string;
  dateTo?: string;
  slaRiskOnly?: boolean;
  source?: string[];
  sourceType?: string[];
}

export default function AllTasksBoard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [appliedFilters, setAppliedFilters] = useState<AppliedFilters>({});
  const [sortBy, setSortBy] = useState<"createdAt" | "appointmentTime" | "slaDeadline" | "status" | "priority">("priority");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [archiveStats, setArchiveStats] = useState<{ activeTasks: number; archivedTasks: number } | null>(null);

  // Phase 3: View toggle
  const [viewMode, setViewMode] = useState<"table" | "kanban">("table");

  // Feature 1: Refresh button + timestamp
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [lastUpdatedDisplay, setLastUpdatedDisplay] = useState<string>("now");
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Feature 4: Status distribution widget
  const [statusDistribution, setStatusDistribution] = useState<StatusDistribution | null>(null);

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

  // Feature 5: Assignment tooltip hover state
  const [hoveredAssignmentTaskId, setHoveredAssignmentTaskId] = useState<number | null>(null);

  // Feature 1: Fetch status distribution
  const fetchStatusDistribution = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks/status-distribution");
      if (res.ok) {
        const data = await res.json();
        setStatusDistribution(data);
      }
    } catch (err) {
      console.error("[fetchStatusDistribution] Error:", err);
    }
  }, []);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();

      // Build query params from appliedFilters
      if (appliedFilters.status?.length) {
        params.set("status", appliedFilters.status.join(","));
      }
      if (appliedFilters.priority?.length) {
        params.set("priority", appliedFilters.priority.join(","));
      }
      if (appliedFilters.assigneeId?.length) {
        params.set("assigneeId", appliedFilters.assigneeId.join(","));
      }
      if (appliedFilters.dateFrom) {
        params.set("dateFrom", appliedFilters.dateFrom);
      }
      if (appliedFilters.dateTo) {
        params.set("dateTo", appliedFilters.dateTo);
      }
      if (appliedFilters.slaRiskOnly) {
        params.set("slaRiskOnly", "true");
      }
      if (appliedFilters.source?.length) {
        params.set("source", appliedFilters.source.join(","));
      }
      if (appliedFilters.sourceType?.length) {
        params.set("sourceType", appliedFilters.sourceType.join(","));
      }

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
      setLastUpdated(new Date());
    } catch (err) {
      console.error("[fetchTasks] Error:", err);
      setTasks([]);
      setTotalPages(1);
      setTotal(0);
    } finally {
      setLoading(false);
      setSelected(new Set());
      setIsRefreshing(false);
    }
  }, [appliedFilters, sortBy, sortOrder, page]);

  useEffect(() => {
    fetchTasks();
    fetchStatusDistribution();
  }, [page, appliedFilters, sortBy, sortOrder]);

  // Fetch agents for reassign dropdown (once)
  useEffect(() => {
    fetch("/api/team")
      .then((r) => r.json())
      .then((d) => {
        setAgents(
          (d.members ?? [])
            .map((m: { userId: number; name: string; role: string }) => ({
              id: m.userId,
              name: m.name,
              role: m.role
            }))
        );
      })
      .catch((err) => console.error("[Team fetch] Error:", err));
  }, []);

  // Feature 1: Update last updated timestamp display every 10 seconds
  useEffect(() => {
    const updateTimestamp = () => {
      const now = new Date();
      const diff = Math.floor((now.getTime() - lastUpdated.getTime()) / 1000);
      if (diff < 60) {
        setLastUpdatedDisplay("now");
      } else if (diff < 120) {
        setLastUpdatedDisplay("1m ago");
      } else if (diff < 3600) {
        const mins = Math.floor(diff / 60);
        setLastUpdatedDisplay(`${mins}m ago`);
      } else {
        const hours = Math.floor(diff / 3600);
        setLastUpdatedDisplay(`${hours}h ago`);
      }
    };

    updateTimestamp();
    const interval = setInterval(updateTimestamp, 10000);
    return () => clearInterval(interval);
  }, [lastUpdated]);


  // Feature 1: Manual refresh button handler
  const handleRefresh = async () => {
    setIsRefreshing(true);
    await fetchTasks();
    await fetchStatusDistribution();
  };

  // Bulk actions
  const handleBulkAction = async () => {
    if (!bulkAction || selected.size === 0) return;

    setBulkLoading(true);
    setBulkError(null);
    setBulkSuccess(null);

    try {
      const body: Record<string, unknown> = {
        ids: Array.from(selected),
        action: bulkAction,
      };

      if (bulkAction === "reassign" && bulkAssigneeId) {
        body.assignedToId = Number(bulkAssigneeId);
      }

      const res = await fetch("/api/tasks/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const error = await res.json();
        setBulkError(error.error || "Action failed");
        return;
      }

      setBulkSuccess(`${selected.size} task(s) ${bulkAction}`);
      setSelected(new Set());
      setBulkAction("");
      setBulkAssigneeId("");

      await fetchTasks();
    } catch (err) {
      setBulkError(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setBulkLoading(false);
    }
  };

  const toggleTaskSelection = (taskId: number) => {
    const newSelected = new Set(selected);
    if (newSelected.has(taskId)) {
      newSelected.delete(taskId);
    } else {
      newSelected.add(taskId);
    }
    setSelected(newSelected);
  };

  const selectAllVisible = () => {
    const allIds = new Set(tasks.map((t) => t.id));
    setSelected(allIds.size === selected.size ? new Set() : allIds);
  };

  const handleTableStatusChange = async (taskId: number, newStatus: string) => {
    // Optimistic update
    const previousTasks = tasks;
    setTasks(
      tasks.map((t) =>
        t.id === taskId ? { ...t, status: newStatus } : t
      )
    );

    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });

      if (!res.ok) {
        throw new Error("Failed to update task status");
      }

      const data = await res.json();
      // Update with server response
      setTasks(
        tasks.map((t) =>
          t.id === taskId ? { ...t, ...data.task } : t
        )
      );
      await fetchStatusDistribution();
    } catch (err) {
      // Revert optimistic update
      setTasks(previousTasks);
      console.error("[AllTasksBoard] Error updating task status:", err);
    }
  };

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      {/* Header with Feature 1: Refresh Button and Feature 4: Status Widget */}
      <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold">All Tasks</h1>

          {/* Feature 1: Refresh button with timestamp */}
          <div className="flex items-center gap-3 ml-6 text-sm text-zinc-400">
            <button
              onClick={handleRefresh}
              disabled={isRefreshing || loading}
              className="flex items-center gap-2 px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 transition-colors"
            >
              <span className={isRefreshing ? "animate-spin" : ""}>🔄</span>
              Refresh
            </button>
            <span>Last updated: {lastUpdatedDisplay}</span>
          </div>
        </div>

        {/* Feature 4: Status Distribution Widget */}
        {statusDistribution && (
          <div className="flex items-center gap-4 text-xs font-mono">
            <div className="flex gap-3">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-gray-400"></span>
                <strong>{statusDistribution.CREATED}</strong> CREATED
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-blue-400"></span>
                <strong>{statusDistribution.ASSIGNED}</strong> ASSIGNED
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-purple-400"></span>
                <strong>{statusDistribution.IN_PROGRESS}</strong> IN_PROGRESS
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-orange-400"></span>
                <strong>{statusDistribution.BLOCKED}</strong> BLOCKED
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-red-500"></span>
                <strong>{statusDistribution.BREACHED}</strong> BREACHED
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Phase 2: Unified Filter Bar */}
      <UnifiedFilterBar
        appliedFilters={appliedFilters}
        onFilterChange={(filters) => {
          setAppliedFilters(filters);
          setPage(1);
        }}
        onClearAll={() => {
          setAppliedFilters({});
          setPage(1);
        }}
      />

      {/* Sort & View Controls */}
      <div className="px-6 py-3 border-b border-zinc-800 flex items-center gap-3 justify-between">
        <div className="flex items-center gap-3">
          <select
            value={sortBy}
            onChange={(e) => {
              setSortBy(e.target.value as typeof sortBy);
              setPage(1);
            }}
            className="px-3 py-1 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-100"
          >
            <option value="priority">Sort: Priority</option>
            <option value="createdAt">Sort: Created Date</option>
            <option value="appointmentTime">Sort: Appointment Time</option>
            <option value="slaDeadline">Sort: SLA Deadline</option>
            <option value="status">Sort: Status</option>
          </select>

          <button
            onClick={() => setSortOrder(sortOrder === "asc" ? "desc" : "asc")}
            className="px-3 py-1 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-100 hover:bg-zinc-700"
          >
            {sortOrder === "asc" ? "↑ Ascending" : "↓ Descending"}
          </button>
        </div>

        {/* Phase 3: View Toggle */}
        <div className="flex items-center gap-1.5 bg-zinc-800 border border-zinc-700 rounded p-1">
          <button
            onClick={() => setViewMode("table")}
            className={`px-3 py-1 text-sm rounded transition-colors ${
              viewMode === "table"
                ? "bg-blue-600 text-white"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
            title="Table view"
          >
            📋
          </button>
          <button
            onClick={() => setViewMode("kanban")}
            className={`px-3 py-1 text-sm rounded transition-colors ${
              viewMode === "kanban"
                ? "bg-blue-600 text-white"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
            title="Kanban view"
          >
            📊
          </button>
        </div>
      </div>

      {/* Bulk Actions Panel */}
      {selected.size > 0 && (
        <div className="px-6 py-3 bg-zinc-900 border-b border-zinc-800 flex items-center gap-3">
          <span className="text-sm text-zinc-400">{selected.size} selected</span>

          <select
            value={bulkAction}
            onChange={(e) => setBulkAction(e.target.value as typeof bulkAction)}
            className="px-3 py-1 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-100"
          >
            <option value="">Select action...</option>
            <option value="reassign">Reassign</option>
            <option value="cancel">Cancel</option>
            <option value="block">Block</option>
          </select>

          {bulkAction === "reassign" && (
            <select
              value={bulkAssigneeId}
              onChange={(e) => setBulkAssigneeId(Number(e.target.value) || "")}
              className="px-3 py-1 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-100"
            >
              <option value="">Select agent...</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}

          <button
            onClick={handleBulkAction}
            disabled={bulkLoading || (!bulkAction || (bulkAction === "reassign" && !bulkAssigneeId))}
            className="px-4 py-1 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded transition-colors"
          >
            {bulkLoading ? "Processing..." : "Apply"}
          </button>

          {bulkError && <span className="text-sm text-red-400">{bulkError}</span>}
          {bulkSuccess && <span className="text-sm text-green-400">{bulkSuccess}</span>}
        </div>
      )}

      {/* Task View (Table or Kanban) */}
      <div className="flex-1 overflow-auto flex flex-col">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-zinc-400">Loading tasks...</div>
        ) : viewMode === "kanban" && tasks.length > 0 ? (
          <KanbanBoard
            tasks={tasks.map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              priority: t.priority,
              slaStatus: t.slaStatus,
              aging: t.aging as any,
            }))}
            onStatusChange={async (taskId, newStatus) => {
              // Optimistic update: update task status immediately
              const previousTasks = tasks;
              setTasks(
                tasks.map((t) =>
                  t.id === taskId ? { ...t, status: newStatus } : t
                )
              );

              try {
                const res = await fetch(`/api/tasks/${taskId}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ status: newStatus }),
                });

                if (!res.ok) {
                  throw new Error("Failed to update task status");
                }

                const data = await res.json();
                // Update with server response to ensure consistency
                setTasks(
                  tasks.map((t) =>
                    t.id === taskId ? { ...t, ...data.task } : t
                  )
                );
                await fetchStatusDistribution();
              } catch (err) {
                // Revert optimistic update on error
                setTasks(previousTasks);
                console.error("[AllTasksBoard] Error updating task status:", err);
              }
            }}
          />
        ) : tasks.length === 0 ? (
          <EmptyStateMessage
            filterCount={Object.values(appliedFilters).filter((v) => v && (Array.isArray(v) ? v.length > 0 : true)).length}
            totalTasks={total}
            appliedFilters={appliedFilters}
            onClearFilters={() => {
              setAppliedFilters({});
              setPage(1);
            }}
            onRemoveFilter={(type, value) => {
              if (type === "slaRiskOnly") {
                setAppliedFilters({ ...appliedFilters, slaRiskOnly: undefined });
              } else if (type === "status" && value) {
                const updated = (appliedFilters.status || []).filter((s) => s !== value);
                setAppliedFilters({ ...appliedFilters, status: updated.length > 0 ? updated : undefined });
              } else if (type === "priority" && value) {
                const updated = (appliedFilters.priority || []).filter((p) => p !== value);
                setAppliedFilters({ ...appliedFilters, priority: updated.length > 0 ? updated : undefined });
              } else if (type === "assigneeId" && value) {
                const updated = (appliedFilters.assigneeId || []).filter((a) => a !== value);
                setAppliedFilters({ ...appliedFilters, assigneeId: updated.length > 0 ? updated : undefined });
              }
              setPage(1);
            }}
          />
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10 bg-zinc-900 border-b border-zinc-800">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold w-10">
                  <input
                    type="checkbox"
                    checked={selected.size === tasks.length && tasks.length > 0}
                    onChange={selectAllVisible}
                    className="rounded"
                    title="Select all visible tasks"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold">Task</th>
                <th className="px-4 py-3 text-left text-xs font-semibold">Status</th>
                <th className="px-4 py-3 text-left text-xs font-semibold">Priority</th>
                <th className="px-4 py-3 text-left text-xs font-semibold">SLA</th>
                <th className="px-4 py-3 text-left text-xs font-semibold">Aging</th>
                <th className="px-4 py-3 text-left text-xs font-semibold">Assigned</th>
                <th className="px-4 py-3 text-left text-xs font-semibold">Assignment</th>
                <th className="px-4 py-3 text-left text-xs font-semibold">Order</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr
                  key={task.id}
                  className={`border-b border-zinc-800 transition-colors ${getSlaRowColor(task.slaStatus)}`}
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(task.id)}
                      onChange={() => toggleTaskSelection(task.id)}
                      disabled={TERMINAL_STATUSES.includes(task.status)}
                      className="rounded disabled:opacity-40"
                    />
                  </td>
                  <td className="px-4 py-3 text-sm font-medium">{task.title}</td>
                  <td className="px-4 py-3 text-sm">
                    <ClickableStatusBadge
                      status={task.status}
                      onStatusChange={(newStatus) => handleTableStatusChange(task.id, newStatus)}
                      disabled={TERMINAL_STATUSES.includes(task.status)}
                    />
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <PriorityBadge priority={task.priority} />
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <SLADisplay
                      slaContext={task.slaContext as any}
                      slaStatus={task.slaStatus}
                      mode="compact"
                    />
                  </td>
                  {/* Phase 3 Feature 13: Task Aging Indicator */}
                  <td className="px-4 py-3 text-sm">
                    <TaskAgingIndicator aging={task.aging as any} compact={true} />
                  </td>
                  <td className="px-4 py-3 text-sm">{task.assignedTo?.name || "-"}</td>

                  {/* Feature 5: Assignment Status Badge */}
                  <td className="px-4 py-3 text-sm relative">
                    <div
                      className="cursor-help text-xs px-2 py-1 rounded bg-zinc-800 inline-block"
                      onMouseEnter={() => setHoveredAssignmentTaskId(task.id)}
                      onMouseLeave={() => setHoveredAssignmentTaskId(null)}
                    >
                      {task.assignmentMethod === "manual" ? "🔄 Manual" : "✓ Auto"}

                      {hoveredAssignmentTaskId === task.id && (
                        <div className="absolute bottom-full left-0 mb-2 bg-zinc-800 border border-zinc-700 rounded p-2 text-xs whitespace-nowrap z-10 shadow-lg">
                          <div><strong>Method:</strong> {task.assignmentMethod === "manual" ? "Manual Override" : "Automatic"}</div>
                          {task.assignmentRuleId && <div><strong>Rule:</strong> {task.assignmentRuleId}</div>}
                        </div>
                      )}
                    </div>
                  </td>

                  <td className="px-4 py-3 text-sm">
                    <button
                      onClick={() => setQuickViewOrderId(task.entityId)}
                      className="text-blue-300 hover:text-blue-200 hover:underline transition-colors"
                    >
                      #{task.entityId}
                    </button>
                  </td>
                </tr>
              ))}
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
