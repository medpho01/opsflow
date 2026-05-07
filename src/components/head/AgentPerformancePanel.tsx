"use client";

import { useState, useEffect, useCallback } from "react";

type Range = "today" | "week" | "month";

interface AgentMetric {
  userId: number;
  name: string;
  email: string;
  role: string;
  rosterStatus: string;
  maxConcurrentTasks: number;
  completedCount: number;
  openCount: number;
  breachedCount: number;
  urgentBreaches: number;
  slaCompliance: number;
  avgCompletionMinutes: number | null;
  loadPercent: number;
}

const ROSTER_CONFIG: Record<string, { label: string; dot: string; text: string }> = {
  ACTIVE: { label: "Active", dot: "bg-emerald-400", text: "text-emerald-400" },
  ON_FIELD: { label: "On Field", dot: "bg-blue-400", text: "text-blue-400" },
  ON_LEAVE: { label: "On Leave", dot: "bg-amber-400", text: "text-amber-400" },
  OFF: { label: "Off", dot: "bg-zinc-600", text: "text-zinc-500" },
};

function fmtDuration(mins: number | null): string {
  if (mins === null) return "—";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function SlaBar({ value }: { value: number }) {
  const color = value >= 90 ? "bg-emerald-500" : value >= 70 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className={`text-xs font-medium w-9 text-right ${value >= 90 ? "text-emerald-400" : value >= 70 ? "text-amber-400" : "text-red-400"}`}>
        {value}%
      </span>
    </div>
  );
}

function LoadBar({ value }: { value: number }) {
  const color = value >= 80 ? "bg-red-500" : value >= 60 ? "bg-amber-500" : "bg-blue-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <span className="text-xs text-zinc-500 w-9 text-right">{value}%</span>
    </div>
  );
}

export default function AgentPerformancePanel() {
  const [metrics, setMetrics] = useState<AgentMetric[]>([]);
  const [range, setRange] = useState<Range>("today");
  const [loading, setLoading] = useState(true);

  const fetchMetrics = useCallback(async (r: Range) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/analytics/agents?range=${r}`);
      if (res.ok) {
        const data = await res.json();
        setMetrics(data.metrics ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMetrics(range); }, [range, fetchMetrics]);

  const rangeLabels: Record<Range, string> = { today: "Today", week: "Last 7 Days", month: "Last 30 Days" };

  // Totals
  const totalCompleted = metrics.reduce((s, m) => s + m.completedCount, 0);
  const totalBreached = metrics.reduce((s, m) => s + m.breachedCount, 0);
  const avgSla = metrics.length > 0 ? Math.round(metrics.reduce((s, m) => s + m.slaCompliance, 0) / metrics.length) : 100;
  const activeCount = metrics.filter((m) => m.rosterStatus === "ACTIVE" || m.rosterStatus === "ON_FIELD").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">Agent Performance</h2>
          <p className="text-xs text-zinc-500 mt-0.5">Task completion and SLA compliance by agent</p>
        </div>
        <div className="flex items-center gap-1 p-1 bg-zinc-900 border border-zinc-800 rounded-lg">
          {(["today", "week", "month"] as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                range === r ? "bg-blue-600 text-white" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {rangeLabels[r]}
            </button>
          ))}
        </div>
      </div>

      {/* Team summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Active Agents", value: activeCount, color: "text-emerald-400" },
          { label: "Tasks Completed", value: totalCompleted, color: "text-blue-400" },
          { label: "SLA Breaches", value: totalBreached, color: "text-red-400" },
          { label: "Avg SLA Score", value: `${avgSla}%`, color: avgSla >= 90 ? "text-emerald-400" : avgSla >= 70 ? "text-amber-400" : "text-red-400" },
        ].map((s) => (
          <div key={s.label} className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-xs text-zinc-500 mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Agent table */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-5 h-5 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
        </div>
      ) : metrics.length === 0 ? (
        <div className="text-center py-12 text-zinc-600 text-sm">No agents found</div>
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className="text-left px-5 py-3 text-xs font-medium text-zinc-500">Agent</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-zinc-500">Status</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-zinc-500">Completed</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-zinc-500">Open</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-zinc-500">Breached</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-zinc-500">Avg Time</th>
                <th className="px-5 py-3 text-xs font-medium text-zinc-500">SLA Score</th>
                <th className="px-5 py-3 text-xs font-medium text-zinc-500">Load</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {metrics.map((m, idx) => {
                const rCfg = ROSTER_CONFIG[m.rosterStatus] ?? ROSTER_CONFIG.OFF;
                return (
                  <tr key={m.userId} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-semibold text-zinc-300 shrink-0">
                          {idx + 1}
                        </div>
                        <div>
                          <div className="text-xs font-medium text-zinc-200">{m.name}</div>
                          <div className="text-[10px] text-zinc-600">{m.role === "STORE_ADMIN" ? "Store Admin" : "Ops Agent"}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="inline-flex items-center gap-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full ${rCfg.dot}`} />
                        <span className={`text-[10px] font-medium ${rCfg.text}`}>{rCfg.label}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-sm font-semibold ${m.completedCount > 0 ? "text-blue-400" : "text-zinc-600"}`}>
                        {m.completedCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-sm font-semibold ${m.openCount > 0 ? "text-zinc-300" : "text-zinc-600"}`}>
                        {m.openCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-sm font-semibold ${m.breachedCount > 0 ? "text-red-400" : "text-zinc-600"}`}>
                        {m.breachedCount}
                        {m.urgentBreaches > 0 && (
                          <span className="ml-1 text-[10px] text-red-500">({m.urgentBreaches} U)</span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center text-xs text-zinc-400">
                      {fmtDuration(m.avgCompletionMinutes)}
                    </td>
                    <td className="px-5 py-3 min-w-32">
                      <SlaBar value={m.slaCompliance} />
                    </td>
                    <td className="px-5 py-3 min-w-32">
                      <div className="text-[10px] text-zinc-600 mb-1">{m.openCount}/{m.maxConcurrentTasks} tasks</div>
                      <LoadBar value={m.loadPercent} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
