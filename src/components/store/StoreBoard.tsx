"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import SlaCountdown from "@/components/shared/SlaCountdown";
import PriorityBadge from "@/components/shared/PriorityBadge";
import StatusBadge from "@/components/shared/StatusBadge";
import { AuthUser } from "@/types";

interface Task {
  id: number;
  title: string;
  priority: string;
  status: string;
  entityId: number;
  storeId: number | null;
  slaDeadline: string;
  slaBreachedAt: string | null;
  completedAt: string | null;
  assignedTo: { id: number; name: string } | null;
  taskType: { label: string } | null;
  dataSource?: { id: string; displayName: string } | null;
}

interface StoreStats {
  open: number;
  breached: number;
  warning: number;
  completed: number;
  unassigned: number;
}

interface Store {
  id: number;
  storeName: string;
  city?: string | null;
}

interface StoreBoardProps {
  user: AuthUser;
}

export default function StoreBoard({ user }: StoreBoardProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState<StoreStats>({ open: 0, breached: 0, warning: 0, completed: 0, unassigned: 0 });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [sortBy, setSortBy] = useState<"createdAt" | "appointmentTime" | "slaDeadline" | "status" | "priority">("priority");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [selectedStoreId, setSelectedStoreId] = useState<number | null>(user.storeIds?.[0] ?? null);
  const [orderIdFilter, setOrderIdFilter] = useState("");
  const [stores, setStores] = useState<Store[]>([]);
  const [storesLoading, setStoresLoading] = useState(true);
  const [storeDropdownOpen, setStoreDropdownOpen] = useState(false);
  const storeDropdownRef = useRef<HTMLDivElement>(null);

  const storeId = selectedStoreId; // allow manual selection

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (storeDropdownRef.current && !storeDropdownRef.current.contains(e.target as Node)) {
        setStoreDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Fetch stores on mount
  useEffect(() => {
    const fetchStores = async () => {
      try {
        const res = await fetch("/api/stores");
        if (res.ok) {
          const data = await res.json();
          setStores(data.stores ?? []);
        }
      } catch (err) {
        console.error("Failed to fetch stores:", err);
      } finally {
        setStoresLoading(false);
      }
    };
    fetchStores();
  }, []);

  const buildQuery = useCallback((pg: number, sf: string) => {
    const params = new URLSearchParams({ page: pg.toString(), limit: "15" });
    if (sf !== "ALL") {
      if (sf === "OPEN") {
        params.set("status", "CREATED,ASSIGNED,IN_PROGRESS,BLOCKED");
      } else {
        params.set("status", sf);
      }
    }
    if (storeId) params.set("storeId", storeId.toString());
    if (orderIdFilter) params.set("orderId", orderIdFilter);
    // Include sort parameters for deep linking and state persistence
    params.set("sortBy", sortBy);
    params.set("sortOrder", sortOrder);
    return `/api/tasks?${params.toString()}`;
  }, [storeId, user.role, orderIdFilter, sortBy, sortOrder]);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(buildQuery(page, statusFilter));
      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks ?? []);
        setTotalPages(data.pagination?.pages ?? 1);
        setTotal(data.pagination?.total ?? 0);
      }
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, buildQuery]);

  const fetchStats = useCallback(async () => {
    const storeQuery = storeId ? `?storeId=${storeId}` : "";
    const [openRes, breachedRes, completedRes] = await Promise.all([
      fetch(`/api/tasks?status=CREATED,ASSIGNED,IN_PROGRESS,BLOCKED${storeQuery ? "&" + storeQuery.slice(1) : ""}&limit=1`),
      fetch(`/api/tasks?status=BREACHED${storeQuery ? "&" + storeQuery.slice(1) : ""}&limit=1`),
      fetch(`/api/tasks?status=COMPLETED${storeQuery ? "&" + storeQuery.slice(1) : ""}&limit=1`),
    ]);

    const [openData, breachedData, completedData] = await Promise.all([
      openRes.ok ? openRes.json() : { pagination: { total: 0 } },
      breachedRes.ok ? breachedRes.json() : { pagination: { total: 0 } },
      completedRes.ok ? completedRes.json() : { pagination: { total: 0 } },
    ]);

    const now = new Date();
    const warnThreshold = new Date(now.getTime() + 10 * 60_000);

    // Count warnings from the open tasks
    const warnRes = await fetch(`/api/tasks?status=CREATED,ASSIGNED,IN_PROGRESS,BLOCKED${storeQuery ? "&" + storeQuery.slice(1) : ""}&limit=50`);
    const warnData = warnRes.ok ? await warnRes.json() : { tasks: [] };
    const warningCount = (warnData.tasks as Task[]).filter(
      (t) => new Date(t.slaDeadline) <= warnThreshold && new Date(t.slaDeadline) > now
    ).length;
    const unassignedCount = (warnData.tasks as Task[]).filter(
      (t) => t.status === "CREATED" && !t.assignedTo
    ).length;

    setStats({
      open: openData.pagination?.total ?? 0,
      breached: breachedData.pagination?.total ?? 0,
      completed: completedData.pagination?.total ?? 0,
      warning: warningCount,
      unassigned: unassignedCount,
    });
  }, [storeId, user.role]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 60_000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  function changeFilter(f: string) {
    setStatusFilter(f);
    setPage(1);
  }

  const filters = [
    { label: "All", value: "ALL" },
    { label: "Open", value: "OPEN" },
    { label: "Breached", value: "BREACHED" },
    { label: "Completed", value: "COMPLETED" },
  ];

  return (
    <div className="p-8 space-y-8">
      {/* Sticky Header Section */}
      <div className="sticky top-0 bg-zinc-950 z-10 -mx-8 px-8 pt-8 pb-6 space-y-8">
        {/* Header with Store Selector */}
        <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Store Overview</h1>
          <p className="text-sm text-zinc-400 mt-2">
            {user.role === "STORE_ADMIN"
              ? `Tasks for your store${user.storeIds?.length && user.storeIds.length > 1 ? "s" : ""}`
              : "Store-level task breakdown"}
          </p>
        </div>
        <div className="relative" ref={storeDropdownRef}>
          <button
            onClick={() => !storesLoading && setStoreDropdownOpen((o) => !o)}
            disabled={storesLoading}
            className="flex items-center gap-2 px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white hover:bg-zinc-700 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 cursor-pointer min-w-[160px]"
          >
            <svg className="w-3.5 h-3.5 text-zinc-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
            <span className="flex-1 text-left truncate">
              {storesLoading ? "Loading…" : (selectedStoreId ? stores.find((s) => s.id === selectedStoreId)?.storeName ?? `Store #${selectedStoreId}` : "All Stores")}
            </span>
            <svg className={`w-3.5 h-3.5 text-zinc-400 shrink-0 transition-transform ${storeDropdownOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {storeDropdownOpen && (
            <div className="absolute top-full right-0 mt-1.5 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-50 min-w-[220px] max-h-72 overflow-y-auto py-1">
              {/* All Stores option */}
              <button
                onClick={() => { setSelectedStoreId(null); setPage(1); setStoreDropdownOpen(false); }}
                className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-sm transition-colors ${
                  selectedStoreId === null
                    ? "bg-blue-600/20 text-blue-400"
                    : "text-zinc-300 hover:bg-zinc-800 hover:text-white"
                }`}
              >
                {selectedStoreId === null && (
                  <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
                <span className={selectedStoreId === null ? "" : "ml-6"}>All Stores</span>
              </button>

              {stores.length > 0 && <div className="my-1 border-t border-zinc-800" />}

              {stores.map((store) => (
                <button
                  key={store.id}
                  onClick={() => { setSelectedStoreId(store.id); setPage(1); setStoreDropdownOpen(false); }}
                  className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-sm transition-colors ${
                    selectedStoreId === store.id
                      ? "bg-blue-600/20 text-blue-400"
                      : "text-zinc-300 hover:bg-zinc-800 hover:text-white"
                  }`}
                >
                  {selectedStoreId === store.id ? (
                    <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <span className="w-3.5 h-3.5 shrink-0" />
                  )}
                  <span className="truncate">{store.storeName}</span>
                  {store.city && <span className="ml-auto text-xs text-zinc-500 shrink-0">{store.city}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: "Open Tasks", value: stats.open, color: "text-blue-400" },
          { label: "Breached", value: stats.breached, color: "text-red-400" },
          { label: "Near SLA", value: stats.warning, color: "text-amber-400" },
          { label: "Unassigned", value: stats.unassigned, color: "text-yellow-400" },
          { label: "Completed", value: stats.completed, color: "text-emerald-400" },
        ].map((s) => (
          <div key={s.label} className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-xs text-zinc-500 mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filter tabs and Order ID search */}
      <div className="space-y-2">
        <div className="flex items-center gap-1 border-b border-zinc-800">
          {filters.map((f) => (
            <button
              key={f.value}
              onClick={() => changeFilter(f.value)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                statusFilter === f.value
                  ? "text-blue-400 border-blue-500"
                  : "text-zinc-500 border-transparent hover:text-zinc-300"
              }`}
            >
              {f.label}
            </button>
          ))}
          <span className="ml-auto text-xs text-zinc-600 pb-2.5">{total} tasks</span>
        </div>
      </div>
      </div>

      {/* Task table */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
        </div>
      ) : tasks.length === 0 ? (
        <div className="text-center py-16 text-zinc-600 text-sm">No tasks found</div>
      ) : (
        <div className="border-t border-b border-zinc-800 -mx-8 -mt-6">
          <div className="overflow-y-auto max-h-[calc(100vh-480px)]">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-10 bg-zinc-950 border-b border-zinc-800">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-100">Task</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-100">Data Source</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-100">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-100">Priority</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-100">SLA</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-100">Assigned</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-100">Order</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.id} className="border-b border-zinc-800 hover:bg-zinc-800/50 transition-colors">
                    <td className="px-4 py-3 text-sm">
                      <div className="font-medium text-zinc-100">{task.title}</div>
                      <div className="text-xs text-zinc-500 mt-0.5">Order #{task.entityId}</div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {task.dataSource ? (
                        <span className="inline-block px-2 py-0.5 text-xs rounded bg-zinc-800 text-zinc-200 border border-zinc-700">
                          {task.dataSource.displayName}
                        </span>
                      ) : (
                        <span className="text-zinc-500 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <StatusBadge status={task.status as never} />
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <PriorityBadge priority={task.priority as never} />
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <SlaCountdown deadline={task.slaDeadline} completedAt={task.completedAt ?? undefined} />
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-300">
                      {task.assignedTo ? task.assignedTo.name : (
                        <span className="text-amber-500">Unassigned</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-blue-300">
                      #{task.entityId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-8 py-3 bg-zinc-900 border-t border-zinc-800 flex items-center justify-between">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 text-xs bg-zinc-800 text-zinc-400 rounded disabled:opacity-40 hover:bg-zinc-700 transition-colors"
              >
                ← Prev
              </button>
              <span className="text-xs text-zinc-500">Page {page} of {totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1.5 text-xs bg-zinc-800 text-zinc-400 rounded disabled:opacity-40 hover:bg-zinc-700 transition-colors"
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
