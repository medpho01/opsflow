"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface AlertTask {
  id: number;
  title: string;
  entityId: number;
}

interface Alert {
  id: number;
  type: string;
  message: string;
  createdAt: string;
  task: AlertTask | null;
}

const ALERT_TYPE_COLOR: Record<string, string> = {
  SLA_BREACH: "text-red-400",
  SLA_WARNING: "text-amber-400",
  ESCALATION: "text-orange-400",
  UNASSIGNED_TASK: "text-yellow-400",
  AGENT_AT_CAPACITY: "text-blue-400",
  ORDER_STUCK: "text-purple-400",
  DAILY_SUMMARY: "text-zinc-400",
};

const ALERT_TYPE_DOT: Record<string, string> = {
  SLA_BREACH: "bg-red-500",
  SLA_WARNING: "bg-amber-500",
  ESCALATION: "bg-orange-500",
  UNASSIGNED_TASK: "bg-yellow-500",
  AGENT_AT_CAPACITY: "bg-blue-500",
  ORDER_STUCK: "bg-purple-500",
  DAILY_SUMMARY: "bg-zinc-500",
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function AlertBell() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setAlerts(data.alerts ?? []);
        setUnreadCount(data.unreadCount ?? 0);
      }
    } catch {
      // network error — silently ignore
    }
  }, []);

  useEffect(() => {
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 30_000);
    return () => clearInterval(interval);
  }, [fetchAlerts]);

  // Close panel on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  async function markAllRead() {
    if (alerts.length === 0) return;
    setLoading(true);
    try {
      await fetch("/api/alerts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markAll: true }),
      });
      setAlerts([]);
      setUnreadCount(0);
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }

  async function markOneRead(id: number) {
    try {
      await fetch("/api/alerts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      });
      setAlerts((prev) => prev.filter((a) => a.id !== id));
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch {
      // ignore
    }
  }

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell button */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative p-2 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
        aria-label={`${unreadCount} unread alerts`}
      >
        <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-0.5 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute right-0 top-10 w-96 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl z-50 overflow-hidden">
          {/* Header */}
          <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-zinc-100">Alerts</span>
              {unreadCount > 0 && (
                <span className="px-1.5 py-0.5 bg-red-500/15 text-red-400 text-[10px] font-semibold rounded-full">
                  {unreadCount} new
                </span>
              )}
            </div>
            {alerts.length > 0 && (
              <button
                onClick={markAllRead}
                disabled={loading}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors disabled:opacity-50"
              >
                Mark all read
              </button>
            )}
          </div>

          {/* Alert list */}
          <div className="max-h-80 overflow-y-auto divide-y divide-zinc-800/60">
            {alerts.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center mx-auto mb-2">
                  <svg className="w-4 h-4 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                  </svg>
                </div>
                <p className="text-xs text-zinc-500">No unread alerts</p>
              </div>
            ) : (
              alerts.map((alert) => (
                <div key={alert.id} className="px-4 py-3 hover:bg-zinc-800/40 transition-colors group">
                  <div className="flex items-start gap-2.5">
                    <div
                      className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${ALERT_TYPE_DOT[alert.type] ?? "bg-zinc-500"}`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs font-medium leading-snug ${ALERT_TYPE_COLOR[alert.type] ?? "text-zinc-300"}`}>
                        {alert.type.replace(/_/g, " ")}
                      </p>
                      <p className="text-xs text-zinc-400 mt-0.5 leading-relaxed">{alert.message}</p>
                      <p className="text-[10px] text-zinc-600 mt-1">{timeAgo(alert.createdAt)}</p>
                    </div>
                    <button
                      onClick={() => markOneRead(alert.id)}
                      className="shrink-0 mt-0.5 p-1 rounded text-zinc-600 hover:text-zinc-400 hover:bg-zinc-700 opacity-0 group-hover:opacity-100 transition-all"
                      title="Dismiss"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          {alerts.length > 0 && (
            <div className="px-4 py-2 border-t border-zinc-800 bg-zinc-900/80">
              <p className="text-[10px] text-zinc-600 text-center">
                Showing {alerts.length} most recent unread alerts
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
