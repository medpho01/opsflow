"use client";

import { useState, useEffect, useCallback } from "react";

interface SummaryData {
  date: string;
  summary: {
    createdToday: number;
    completedToday: number;
    breachedToday: number;
    openCarryover: number;
    slaHealthPercent: number;
  };
  agentBreakdown: { name: string; completed: number; slaCompliant: number }[];
  pollSummary: {
    cycles: number;
    errors: number;
    totalOrders: number;
    totalTasksCreated: number;
    avgDurationMs: number;
  };
}

function formatDateDisplay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (dateStr === todayStr) return "Today";
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

function getDateStr(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function DailySummaryPanel({ dataSourceId = null }: { dataSourceId?: string | null }) {
  const [data, setData] = useState<SummaryData | null>(null);
  const [selectedDate, setSelectedDate] = useState(getDateStr(0));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async (date: string, ds: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const dsParam = ds ? `&dataSourceId=${encodeURIComponent(ds)}` : "";
      const res = await fetch(`/api/analytics/summary?date=${date}${dsParam}`);
      if (!res.ok) throw new Error("Failed to load summary");
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load summary");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSummary(selectedDate, dataSourceId); }, [selectedDate, dataSourceId, fetchSummary]);

  const quickDates = [
    { label: "Today", value: getDateStr(0) },
    { label: "Yesterday", value: getDateStr(-1) },
    { label: "2 days ago", value: getDateStr(-2) },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-white">Daily Summary</h2>
          <p className="text-xs text-zinc-500 mt-0.5">End-of-shift digest for any date</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {quickDates.map((qd) => (
            <button
              key={qd.value}
              onClick={() => setSelectedDate(qd.value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                selectedDate === qd.value
                  ? "bg-blue-600/15 border-blue-500/40 text-blue-400"
                  : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300"
              }`}
            >
              {qd.label}
            </button>
          ))}
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="px-3 py-1.5 text-xs bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-5 h-5 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">{error}</div>
      ) : data ? (
        <>
          {/* Date heading */}
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-zinc-300">{formatDateDisplay(data.date)}</div>
            <div className="text-xs text-zinc-600">{data.date}</div>
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {[
              { label: "Tasks Created", value: data.summary.createdToday, color: "text-zinc-200" },
              { label: "Completed", value: data.summary.completedToday, color: "text-emerald-400" },
              { label: "Breached", value: data.summary.breachedToday, color: data.summary.breachedToday > 0 ? "text-red-400" : "text-zinc-600" },
              { label: "Still Open", value: data.summary.openCarryover, color: "text-amber-400" },
              {
                label: "SLA Score",
                value: `${data.summary.slaHealthPercent}%`,
                color: data.summary.slaHealthPercent >= 90 ? "text-emerald-400" : data.summary.slaHealthPercent >= 70 ? "text-amber-400" : "text-red-400",
              },
            ].map((s) => (
              <div key={s.label} className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
                <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
                <div className="text-xs text-zinc-500 mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>

          {/* SLA health bar */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-5 py-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-zinc-400">SLA Health</span>
              <span className={`text-xs font-bold ${data.summary.slaHealthPercent >= 90 ? "text-emerald-400" : data.summary.slaHealthPercent >= 70 ? "text-amber-400" : "text-red-400"}`}>
                {data.summary.slaHealthPercent}%
              </span>
            </div>
            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${data.summary.slaHealthPercent >= 90 ? "bg-emerald-500" : data.summary.slaHealthPercent >= 70 ? "bg-amber-500" : "bg-red-500"}`}
                style={{ width: `${data.summary.slaHealthPercent}%` }}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Agent leaderboard */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-zinc-800">
                <h3 className="text-xs font-semibold text-zinc-300">Agent Leaderboard</h3>
              </div>
              {data.agentBreakdown.length === 0 ? (
                <div className="px-5 py-6 text-center text-xs text-zinc-600">No completions recorded</div>
              ) : (
                <div className="divide-y divide-zinc-800/60">
                  {data.agentBreakdown.map((a, idx) => {
                    const compliance = a.completed > 0 ? Math.round((a.slaCompliant / a.completed) * 100) : 100;
                    return (
                      <div key={a.name} className="px-5 py-3 flex items-center gap-3">
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                          idx === 0 ? "bg-amber-500/20 text-amber-400" : idx === 1 ? "bg-zinc-600/30 text-zinc-400" : "bg-zinc-800 text-zinc-500"
                        }`}>
                          {idx + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-zinc-200 truncate">{a.name}</div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${compliance >= 90 ? "bg-emerald-500" : compliance >= 70 ? "bg-amber-500" : "bg-red-500"}`}
                                style={{ width: `${compliance}%` }} />
                            </div>
                            <span className="text-[10px] text-zinc-500">{compliance}%</span>
                          </div>
                        </div>
                        <div className="text-sm font-bold text-blue-400 shrink-0">{a.completed}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Engine summary */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-zinc-800">
                <h3 className="text-xs font-semibold text-zinc-300">Engine Activity</h3>
              </div>
              <div className="px-5 py-4 space-y-3">
                {[
                  { label: "Poll Cycles", value: data.pollSummary.cycles },
                  { label: "Errors", value: data.pollSummary.errors, alert: data.pollSummary.errors > 0 },
                  { label: "Orders Scanned", value: data.pollSummary.totalOrders },
                  { label: "Tasks Auto-Created", value: data.pollSummary.totalTasksCreated },
                  {
                    label: "Avg Cycle Time",
                    value: data.pollSummary.avgDurationMs > 0
                      ? `${(data.pollSummary.avgDurationMs / 1000).toFixed(1)}s`
                      : "—",
                  },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between">
                    <span className="text-xs text-zinc-500">{row.label}</span>
                    <span className={`text-xs font-semibold ${row.alert ? "text-red-400" : "text-zinc-200"}`}>
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
