"use client";

import { useState, useEffect, useCallback } from "react";

interface PollingLog {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  ordersFound: number;
  tasksCreated: number;
  status: string;
  errorMessage: string | null;
}

interface Stats24h {
  cycles: number;
  errors: number;
  ordersFound: number;
  tasksCreated: number;
  avgDurationMs: number;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function fmtDuration(ms: number | null): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function EngineHealth() {
  const [logs, setLogs] = useState<PollingLog[]>([]);
  const [stats, setStats] = useState<Stats24h | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const fetchLogs = useCallback(async (pg: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/engine/logs?page=${pg}&limit=20`);
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs ?? []);
        setTotalPages(data.pagination?.pages ?? 1);
        setStats(data.stats24h ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchLogs(page); }, [page, fetchLogs]);

  const uptimePercent = stats && stats.cycles > 0
    ? Math.round(((stats.cycles - stats.errors) / stats.cycles) * 100)
    : 100;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-base font-semibold text-white">Engine Health</h2>
        <p className="text-xs text-zinc-500 mt-0.5">Polling engine activity and error log (last 24h stats)</p>
      </div>

      {/* 24h Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: "Poll Cycles", value: stats.cycles, color: "text-zinc-200" },
            { label: "Uptime", value: `${uptimePercent}%`, color: uptimePercent === 100 ? "text-emerald-400" : "text-amber-400" },
            { label: "Errors", value: stats.errors, color: stats.errors > 0 ? "text-red-400" : "text-zinc-600" },
            { label: "Orders Scanned", value: stats.ordersFound, color: "text-blue-400" },
            { label: "Tasks Created", value: stats.tasksCreated, color: "text-purple-400" },
          ].map((s) => (
            <div key={s.label} className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
              <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
              <div className="text-xs text-zinc-500 mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Avg duration badge */}
      {stats && (
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-xs text-zinc-400">
            <svg className="w-3.5 h-3.5 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Avg cycle duration: <span className="text-zinc-200 font-medium">{fmtDuration(stats.avgDurationMs)}</span>
          </div>
          <button
            onClick={() => fetchLogs(1)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>
      )}

      {/* Log table */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="w-5 h-5 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
        </div>
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className="text-left px-5 py-3 text-xs font-medium text-zinc-500">When</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500">Status</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500">Orders</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500">Tasks Created</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500">Duration</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-zinc-500">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {logs.map((log) => (
                <tr key={log.id} className={`hover:bg-zinc-800/30 transition-colors ${log.status === "ERROR" ? "bg-red-500/5" : ""}`}>
                  <td className="px-5 py-3">
                    <div className="text-xs text-zinc-300">{new Date(log.startedAt).toLocaleTimeString("en-IN")}</div>
                    <div className="text-[10px] text-zinc-600">{timeAgo(log.startedAt)}</div>
                  </td>
                  <td className="px-4 py-3">
                    {log.status === "SUCCESS" ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-500/10 text-emerald-400 text-[10px] font-semibold rounded-full border border-emerald-500/20">
                        <div className="w-1 h-1 rounded-full bg-emerald-400" />
                        OK
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-500/10 text-red-400 text-[10px] font-semibold rounded-full border border-red-500/20">
                        <div className="w-1 h-1 rounded-full bg-red-400" />
                        ERROR
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-zinc-400">{log.ordersFound}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={`text-xs font-medium ${log.tasksCreated > 0 ? "text-purple-400" : "text-zinc-600"}`}>
                      {log.tasksCreated > 0 ? `+${log.tasksCreated}` : "0"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-zinc-500">{fmtDuration(log.durationMs)}</td>
                  <td className="px-5 py-3 max-w-xs">
                    {log.errorMessage ? (
                      <span className="text-[10px] text-red-400 font-mono truncate block" title={log.errorMessage}>
                        {log.errorMessage}
                      </span>
                    ) : (
                      <span className="text-zinc-700 text-[10px]">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-5 py-3 border-t border-zinc-800 flex items-center justify-between">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 text-xs bg-zinc-800 text-zinc-400 rounded-lg disabled:opacity-40 hover:bg-zinc-700"
              >
                ← Prev
              </button>
              <span className="text-xs text-zinc-500">Page {page} / {totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1.5 text-xs bg-zinc-800 text-zinc-400 rounded-lg disabled:opacity-40 hover:bg-zinc-700"
              >
                Next →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
