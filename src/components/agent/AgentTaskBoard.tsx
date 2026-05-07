"use client";

import { useEffect, useState, useCallback } from "react";
import SlaCountdown from "@/components/shared/SlaCountdown";
import PriorityBadge from "@/components/shared/PriorityBadge";
import StatusBadge from "@/components/shared/StatusBadge";
import TaskDetailPanel from "./TaskDetailPanel";

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

const STATUS_TABS = [
  { key: "active", label: "Active", statuses: "ASSIGNED,IN_PROGRESS,CREATED" },
  { key: "blocked", label: "Blocked", statuses: "BLOCKED,BREACHED" },
  { key: "done", label: "Done", statuses: "COMPLETED,CANCELLED" },
];

const ROSTER_STATUSES = [
  { key: "ACTIVE", label: "Active", color: "bg-green-500", textColor: "text-green-400" },
  { key: "ON_FIELD", label: "On Field", color: "bg-blue-500", textColor: "text-blue-400" },
  { key: "ON_LEAVE", label: "On Leave", color: "bg-amber-500", textColor: "text-amber-400" },
  { key: "OFF", label: "Off Duty", color: "bg-zinc-600", textColor: "text-zinc-500" },
];

function CheckInWidget() {
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetch("/api/team/me/roster")
      .then((r) => r.json())
      .then((d) => setStatus(d.roster?.status ?? "OFF"))
      .catch(() => {});
  }, []);

  async function setMyStatus(newStatus: string) {
    setSaving(true);
    try {
      const res = await fetch("/api/team/me/roster", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) setStatus(newStatus);
    } finally {
      setSaving(false);
      setOpen(false);
    }
  }

  const current = ROSTER_STATUSES.find((s) => s.key === status) ?? ROSTER_STATUSES[3];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={saving}
        className="flex items-center gap-1.5 px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors text-xs font-medium disabled:opacity-50"
        title="Set your status for today"
      >
        <div className={`w-2 h-2 rounded-full ${current.color}`} />
        <span className={current.textColor}>{current.label}</span>
        <svg className="w-3 h-3 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-30 bg-zinc-800 border border-zinc-700 rounded-xl shadow-xl py-1 w-36">
          {ROSTER_STATUSES.map((s) => (
            <button
              key={s.key}
              onClick={() => setMyStatus(s.key)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs hover:bg-zinc-700 transition-colors ${
                status === s.key ? "text-white font-medium" : "text-zinc-300"
              }`}
            >
              <div className={`w-2 h-2 rounded-full shrink-0 ${s.color}`} />
              {s.label}
              {status === s.key && (
                <svg className="w-3 h-3 ml-auto text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AgentTaskBoard({ userId, userName }: { userId: number; userName: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("active");
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [orderIdFilter, setOrderIdFilter] = useState("");

  const currentTab = STATUS_TABS.find((t) => t.key === activeTab)!;

  const fetchTasks = useCallback(async () => {
    try {
      let url = `/api/tasks?status=${currentTab.statuses}&limit=50`;
      if (orderIdFilter) {
        url += `&orderId=${orderIdFilter}`;
      }
      const res = await fetch(url);
      const data = await res.json();
      setTasks(data.tasks ?? []);
      // Keep selected task in sync
      if (selectedTask) {
        const refreshed = data.tasks?.find((t: Task) => t.id === selectedTask.id);
        if (refreshed) setSelectedTask(refreshed);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [currentTab.statuses, selectedTask?.id, orderIdFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setLoading(true);
    fetchTasks();
  }, [activeTab, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh every 30s
  useEffect(() => {
    const id = setInterval(() => setRefreshKey((k) => k + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const priorityOrder: Record<string, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const sorted = [...tasks].sort((a, b) => {
    const pd = (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3);
    if (pd !== 0) return pd;
    return new Date(a.slaDeadline).getTime() - new Date(b.slaDeadline).getTime();
  });

  return (
    <div className="flex h-full">
      {/* ── Left: Task List ── */}
      <div className="w-96 shrink-0 border-r border-zinc-800 flex flex-col bg-zinc-950">
        {/* Header */}
        <div className="px-4 pt-5 pb-3 border-b border-zinc-800">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h1 className="text-base font-semibold text-white">My Tasks</h1>
              <p className="text-xs text-zinc-500 mt-0.5">{userName}</p>
            </div>
            <div className="flex items-center gap-2">
              <CheckInWidget />
              <button
                onClick={() => setRefreshKey((k) => k + 1)}
                className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                title="Refresh"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 bg-zinc-900 rounded-lg p-1 mb-3">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => { setActiveTab(tab.key); setSelectedTask(null); }}
                className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors ${
                  activeTab === tab.key
                    ? "bg-zinc-700 text-white"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Order ID Filter */}
          <div className="relative">
            <input
              type="text"
              placeholder="Filter by Order ID..."
              value={orderIdFilter}
              onChange={(e) => setOrderIdFilter(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition-colors"
            />
            {orderIdFilter && (
              <button
                onClick={() => setOrderIdFilter("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
                title="Clear filter"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Task list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <div className="w-5 h-5 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
            </div>
          ) : sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-center px-4">
              <svg className="w-8 h-8 text-zinc-700 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <p className="text-sm text-zinc-600">No tasks here</p>
            </div>
          ) : (
            <div className="divide-y divide-zinc-800/60">
              {sorted.map((task) => {
                const isSelected = selectedTask?.id === task.id;
                const doneItems = task.checklistItems.filter((i) => i.isDone).length;
                const totalItems = task.checklistItems.length;

                return (
                  <button
                    key={task.id}
                    onClick={() => setSelectedTask(task)}
                    className={`w-full text-left px-4 py-3.5 transition-colors ${
                      isSelected ? "bg-blue-600/10 border-l-2 border-blue-500" : "hover:bg-zinc-900 border-l-2 border-transparent"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <span className="text-sm font-medium text-zinc-100 leading-snug line-clamp-2">{task.title}</span>
                      <PriorityBadge priority={task.priority} />
                    </div>

                    <div className="flex items-center gap-2 mb-1.5">
                      <StatusBadge status={task.status} />
                      <span className="text-[10px] text-zinc-600">#{task.entityId}</span>
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1 text-[10px] text-zinc-500">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <SlaCountdown deadline={task.slaDeadline} compact completedAt={task.completedAt ?? undefined} />
                      </div>
                      {totalItems > 0 && (
                        <span className={`text-[10px] font-medium ${doneItems === totalItems ? "text-green-500" : "text-zinc-500"}`}>
                          {doneItems}/{totalItems} steps
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Right: Task Detail ── */}
      <div className="flex-1 min-w-0">
        {selectedTask ? (
          <TaskDetailPanel
            task={selectedTask}
            onUpdate={() => setRefreshKey((k) => k + 1)}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <svg className="w-12 h-12 text-zinc-800 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            <p className="text-sm text-zinc-600 font-medium">Select a task to view details</p>
            <p className="text-xs text-zinc-700 mt-1">Pick any task from the list on the left</p>
          </div>
        )}
      </div>
    </div>
  );
}
