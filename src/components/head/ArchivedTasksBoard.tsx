"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
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
  dataSource?: { id: string; displayName: string } | null;
  metadata: Record<string, unknown>;
}

export default function ArchivedTasksBoard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [quickViewOrderId, setQuickViewOrderId] = useState<number | null>(null);

  const fetchArchivedTasks = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch from archive endpoint with pagination
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", "25");

      const res = await fetch(`/api/tasks/archive?${params}`);
      if (!res.ok) {
        console.error(`[ArchivedTasksBoard] HTTP ${res.status}`);
        setLoading(false);
        return;
      }

      const data = await res.json();
      console.log("[ArchivedTasksBoard] Fetched tasks:", data);

      // Show archived tasks
      if (data.tasks && Array.isArray(data.tasks)) {
        setTasks(data.tasks);
        if (data.pagination) {
          setTotal(data.pagination.total);
          setTotalPages(data.pagination.totalPages);
        }
      } else {
        console.warn("[ArchivedTasksBoard] No tasks in response:", data);
      }
    } catch (error) {
      console.error("[ArchivedTasksBoard] Fetch error:", error);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    fetchArchivedTasks();
  }, [fetchArchivedTasks, page]);

  return (
    <div className="h-full flex flex-col bg-zinc-950">
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-zinc-800 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Link
                href="/head/tasks"
                className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
              >
                ← Back to Active
              </Link>
              <h1 className="text-base font-semibold text-white">Archived Tasks</h1>
            </div>
            <p className="text-xs text-zinc-500 mt-1">
              {total} {total === 1 ? "task" : "tasks"} archived from old orders
            </p>
          </div>
        </div>
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
                <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase tracking-wider px-4 py-3">
                  Task
                </th>
                <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase tracking-wider px-4 py-3">
                  Type
                </th>
                <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase tracking-wider px-4 py-3">
                  Data Source
                </th>
                <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase tracking-wider px-4 py-3">
                  Status
                </th>
                <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase tracking-wider px-4 py-3">
                  Priority
                </th>
                <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase tracking-wider px-4 py-3">
                  SLA
                </th>
                <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase tracking-wider px-4 py-3">
                  Days Since Appt
                </th>
                <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase tracking-wider px-4 py-3">
                  Order
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {tasks.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-sm text-zinc-600">
                    No archived tasks
                  </td>
                </tr>
              ) : (
                tasks.map((task) => (
                  <tr key={task.id} className="hover:bg-zinc-900/50 transition-colors">
                    <td className="px-4 py-3 max-w-xs">
                      <div className="text-sm font-medium text-zinc-100 line-clamp-1">
                        {task.title}
                      </div>
                      <div className="text-[10px] text-zinc-600 mt-0.5">#{task.id}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-zinc-400">
                        {task.taskType?.label || "N/A"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {task.dataSource ? (
                        <span className="inline-block px-2 py-0.5 text-xs rounded bg-zinc-800 text-zinc-200 border border-zinc-700">
                          {task.dataSource.displayName}
                        </span>
                      ) : (
                        <span className="text-zinc-600 text-xs">—</span>
                      )}
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
                      <span className="text-xs text-zinc-400">
                        {(task as any).daysSinceAppointment ?? "—"} days
                      </span>
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
                ))
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
