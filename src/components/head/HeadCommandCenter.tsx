"use client";

import { useEffect, useState, useCallback } from "react";
import SlaCountdown from "@/components/shared/SlaCountdown";
import PriorityBadge from "@/components/shared/PriorityBadge";
import StatusBadge from "@/components/shared/StatusBadge";
import CreateTaskModal from "@/components/head/CreateTaskModal";

interface Stats {
  activeOrders: number;
  openTasks: number;
  breachedTasks: number;
  warningTasks: number;
  slaHealthPercent: number;
  unassignedTasks: number;
  completedToday: number;
  breachedToday: number;
}

interface RiskItem {
  taskId: number;
  title: string;
  priority: string;
  status: string;
  entityId: number;
  orderType: string;
  storeId: number | null;
  slaDeadline: string;
  slaBreachedAt: string | null;
  assignedTo: { id: number; name: string } | null;
  metadata: Record<string, unknown>;
  minutesRemaining: number;
}

interface TeamMember {
  userId: number;
  name: string;
  role: string;
  rosterStatus: string;
  openTasks: number;
  maxTasks: number;
  storeIds: number[];
}

interface Alert {
  id: number;
  type: string;
  message: string;
  createdAt: string;
  task: { id: number; title: string; entityId: number } | null;
}

interface DashboardData {
  stats: Stats;
  riskItems: RiskItem[];
  team: TeamMember[];
  recentAlerts: Alert[];
  lastPollAt: string | null;
}

const ALERT_TYPE_COLORS: Record<string, string> = {
  SLA_BREACH: "text-red-400",
  SLA_WARNING: "text-amber-400",
  UNASSIGNED_TASK: "text-blue-400",
  ESCALATION: "text-purple-400",
};

export default function HeadCommandCenter() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<number>>(new Set());
  const [showCreateModal, setShowCreateModal] = useState(false);

  const fetchDashboard = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard");
      if (!res.ok) {
        console.error(`[Dashboard] HTTP ${res.status}:`, res.statusText);
        setLoading(false);
        return;
      }
      const json = await res.json();
      setData(json);
    } catch (error) {
      console.error("[Dashboard] Error:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
  }, [refreshKey, fetchDashboard]);

  // Auto-refresh every 60s
  useEffect(() => {
    const id = setInterval(() => setRefreshKey((k) => k + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  async function dismissAlert(id: number) {
    setDismissedAlerts((prev) => new Set([...prev, id]));
    await fetch("/api/alerts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [id] }),
    }).catch(() => {});
  }

  async function assignTask(taskId: number, userId: number) {
    await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedToId: userId }),
    });
    setRefreshKey((k) => k + 1);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-6 h-6 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        Failed to load dashboard
      </div>
    );
  }

  const { stats, riskItems, team, recentAlerts, lastPollAt } = data;
  const visibleAlerts = recentAlerts.filter((a) => !dismissedAlerts.has(a.id));

  return (
    <div className="h-full overflow-y-auto bg-zinc-950">
      {/* Top bar */}
      <div className="sticky top-0 z-10 bg-zinc-950/90 backdrop-blur border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-white">Command Center</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            Last synced: {lastPollAt ? new Date(lastPollAt).toLocaleTimeString("en-IN") : "—"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs text-white font-medium transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Create Task
          </button>
          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>
      </div>

      <div className="px-6 py-5 space-y-6">
        {/* ── Stats bar ── */}
        <div className="grid grid-cols-4 xl:grid-cols-8 gap-3">
          {[
            { label: "Active Orders", value: stats.activeOrders, cls: "text-white" },
            { label: "Open Tasks", value: stats.openTasks, cls: "text-white" },
            { label: "Breached", value: stats.breachedTasks, cls: stats.breachedTasks > 0 ? "text-red-400" : "text-white" },
            { label: "Near SLA", value: stats.warningTasks, cls: stats.warningTasks > 0 ? "text-amber-400" : "text-white" },
            { label: "Unassigned", value: stats.unassignedTasks, cls: stats.unassignedTasks > 0 ? "text-blue-400" : "text-white" },
            { label: "SLA Health", value: `${stats.slaHealthPercent}%`, cls: stats.slaHealthPercent >= 90 ? "text-green-400" : stats.slaHealthPercent >= 70 ? "text-amber-400" : "text-red-400" },
            { label: "Done Today", value: stats.completedToday, cls: "text-green-400" },
            { label: "Breached Today", value: stats.breachedToday, cls: stats.breachedToday > 0 ? "text-red-400" : "text-zinc-400" },
          ].map(({ label, value, cls }) => (
            <div key={label} className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
              <div className="text-xs text-zinc-500 mb-1">{label}</div>
              <div className={`text-2xl font-bold ${cls}`}>{value}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-5">
          {/* ── Risk Zone ── */}
          <div className="col-span-2">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-white">Risk Zone</h2>
              <span className="text-xs text-zinc-500">{riskItems.length} items</span>
            </div>

            {riskItems.length === 0 ? (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 text-center">
                <div className="w-8 h-8 rounded-full bg-green-500/15 flex items-center justify-center mx-auto mb-2">
                  <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-sm text-zinc-400 font-medium">All clear</p>
                <p className="text-xs text-zinc-600 mt-0.5">No tasks at risk right now</p>
              </div>
            ) : (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-zinc-800">
                      <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase px-4 py-2.5">Task</th>
                      <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase px-3 py-2.5">Status</th>
                      <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase px-3 py-2.5">SLA</th>
                      <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase px-3 py-2.5">Assigned</th>
                      <th className="px-3 py-2.5"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60">
                    {riskItems.map((item) => (
                      <tr key={item.taskId} className="hover:bg-zinc-800/30 transition-colors">
                        <td className="px-4 py-3">
                          <div className="text-sm font-medium text-zinc-100 leading-snug line-clamp-1 mb-0.5">
                            {item.title}
                          </div>
                          <div className="flex items-center gap-1.5">
                            <PriorityBadge priority={item.priority} />
                            <span className="text-[10px] text-zinc-600">#{item.entityId}</span>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <StatusBadge status={item.status} />
                        </td>
                        <td className="px-3 py-3">
                          <SlaCountdown deadline={item.slaDeadline} compact />
                        </td>
                        <td className="px-3 py-3">
                          {item.assignedTo ? (
                            <span className="text-xs text-zinc-300">{item.assignedTo.name}</span>
                          ) : (
                            <span className="text-xs text-zinc-600 italic">Unassigned</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          {!item.assignedTo && team.filter((m) => m.rosterStatus !== "OFF").length > 0 && (
                            <select
                              className="text-xs bg-zinc-800 border border-zinc-700 text-zinc-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                              defaultValue=""
                              onChange={(e) => {
                                if (e.target.value) assignTask(item.taskId, parseInt(e.target.value, 10));
                              }}
                            >
                              <option value="" disabled>Assign →</option>
                              {team
                                .filter((m) => m.rosterStatus !== "OFF" && m.openTasks < m.maxTasks)
                                .map((m) => (
                                  <option key={m.userId} value={m.userId}>
                                    {m.name} ({m.openTasks} open)
                                  </option>
                                ))}
                            </select>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Right column: Alerts + Team ── */}
          <div className="space-y-5">
            {/* Alerts */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-white">Live Alerts</h2>
                {visibleAlerts.length > 0 && (
                  <span className="text-[10px] bg-red-500/20 text-red-400 border border-red-500/30 px-1.5 py-0.5 rounded font-medium">
                    {visibleAlerts.length}
                  </span>
                )}
              </div>

              <div className="space-y-2">
                {visibleAlerts.length === 0 ? (
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 text-center">
                    <p className="text-xs text-zinc-600">No active alerts</p>
                  </div>
                ) : (
                  visibleAlerts.slice(0, 8).map((alert) => (
                    <div
                      key={alert.id}
                      className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 flex items-start justify-between gap-2"
                    >
                      <div className="flex-1 min-w-0">
                        <p className={`text-xs font-medium ${ALERT_TYPE_COLORS[alert.type] ?? "text-zinc-400"}`}>
                          {alert.type.replace("_", " ")}
                        </p>
                        <p className="text-xs text-zinc-400 mt-0.5 line-clamp-2">{alert.message}</p>
                        <p className="text-[10px] text-zinc-600 mt-1">
                          {new Date(alert.createdAt).toLocaleTimeString("en-IN")}
                        </p>
                      </div>
                      <button
                        onClick={() => dismissAlert(alert.id)}
                        className="shrink-0 text-zinc-600 hover:text-zinc-400 transition-colors mt-0.5"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Team panel */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-white">Team Status</h2>
                <span className="text-xs text-zinc-500">
                  {team.filter((m) => m.rosterStatus !== "OFF").length} active
                </span>
              </div>

              <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                {team.length === 0 ? (
                  <div className="p-4 text-center text-xs text-zinc-600">No team members</div>
                ) : (
                  <div className="divide-y divide-zinc-800/60">
                    {team.map((member) => {
                      const loadPct = member.maxTasks > 0 ? (member.openTasks / member.maxTasks) * 100 : 0;
                      const isActive = member.rosterStatus !== "OFF";
                      return (
                        <div key={member.userId} className="px-4 py-3">
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-2">
                              <div className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-green-500" : "bg-zinc-600"}`} />
                              <span className="text-xs font-medium text-zinc-200">{member.name}</span>
                            </div>
                            <span className={`text-[10px] font-medium ${
                              loadPct >= 80 ? "text-red-400" : loadPct >= 60 ? "text-amber-400" : "text-zinc-400"
                            }`}>
                              {member.openTasks}/{member.maxTasks}
                            </span>
                          </div>
                          <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${
                                loadPct >= 80 ? "bg-red-500" : loadPct >= 60 ? "bg-amber-500" : "bg-green-500"
                              }`}
                              style={{ width: `${Math.min(100, loadPct)}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Create Task Modal */}
      {showCreateModal && (
        <CreateTaskModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
