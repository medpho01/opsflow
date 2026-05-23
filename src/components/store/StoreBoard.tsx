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
  // Joined from labstack in /api/tasks — see route.ts. Null when the task
  // has no storeId or the labstack join failed.
  store?: { id: number; storeName: string; city: string | null } | null;
}

interface StoreStats {
  open: number;
  breached: number;
  warning: number;
  // Subset of `warning` that's within the critical 10-min sub-window.
  // Rendered as "12 (3 critical)" alongside the headline. The previous
  // 10-min-only window fired too late to act on.
  warningCritical: number;
  completed: number;
  unassigned: number;
}

interface Store {
  id: number;
  storeName: string;
  city?: string | null;
}

// Per-store breakdown returned by /api/stores/overview when "All Stores"
// is selected and the user has more than one store in scope. Lets a
// multi-store admin see side-by-side counts and click into the worst
// store without flipping the selector dropdown.
interface PerStoreCounts {
  open: number;
  breached: number;
  completed: number;
  warning: number;
  warningCritical: number;
  unassigned: number;
}
interface PerStoreRow {
  storeId: number;
  storeName: string | null;
  city: string | null;
  counts: PerStoreCounts;
}

interface StoreBoardProps {
  user: AuthUser;
}

export default function StoreBoard({ user }: StoreBoardProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const ZERO_STATS: StoreStats = { open: 0, breached: 0, warning: 0, warningCritical: 0, completed: 0, unassigned: 0 };
  const [stats, setStats] = useState<StoreStats>(ZERO_STATS);
  const [perStore, setPerStore] = useState<PerStoreRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [sortBy, setSortBy] = useState<"createdAt" | "appointmentTime" | "slaDeadline" | "status" | "priority">("priority");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  // Default landing: All Stores when the user has multiple, otherwise the
  // only store they have. Previously hard-defaulted to the first store —
  // a multi-store admin would always land on the same one regardless of
  // where the fire was, and only discover problems at their other stores
  // by manually flipping the dropdown.
  const [selectedStoreId, setSelectedStoreId] = useState<number | null>(
    (user.storeIds?.length ?? 0) === 1 ? user.storeIds![0] : null
  );
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

  // Selected-store metadata (resolved from the overview endpoint, used in
  // the page title so a multi-store admin can tell at a glance which one
  // they're looking at without re-opening the dropdown).
  const [selectedStoreMeta, setSelectedStoreMeta] = useState<Store | null>(null);

  // Audit fix (feature 06): replaces the prior 4-fetch fan-out and the
  // limit=50 client-side filtering. One round-trip; the counts are real
  // SQL counts so "Unassigned" is no longer capped at 50.
  const fetchStats = useCallback(async () => {
    const url = storeId === null
      ? `/api/stores/overview`
      : `/api/stores/overview?storeId=${storeId}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        // Server-side scoping rejected the request (e.g. STORE_ADMIN
        // asking for a store outside their assignments). Reset rather
        // than show stale numbers.
        setStats(ZERO_STATS);
        setSelectedStoreMeta(null);
        setPerStore(null);
        return;
      }
      const data = await res.json();
      // Per-store breakdown — present only when "All Stores" is selected
      // AND the user has more than one store. The backend returns null
      // otherwise (single-store admins don't need this surface).
      setPerStore(data.perStore ?? null);
      setStats({
        open: data.counts?.open ?? 0,
        breached: data.counts?.breached ?? 0,
        warning: data.counts?.warning ?? 0,
        warningCritical: data.counts?.warningCritical ?? 0,
        unassigned: data.counts?.unassigned ?? 0,
        completed: data.counts?.completed ?? 0,
      });
      setSelectedStoreMeta(data.store ?? null);
    } catch {
      setStats(ZERO_STATS);
      setSelectedStoreMeta(null);
      setPerStore(null);
    }
  }, [storeId]);

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

  // STORE_ADMIN with no store assignments: the engine can't show them
  // anything meaningful here. Render an explicit empty state instead of
  // the previous behaviour where the dropdown said "All Stores", the
  // counts were 0, and the table was blank with no explanation.
  const isStoreAdminWithNoStores =
    user.role === "STORE_ADMIN" &&
    !storesLoading &&
    (!user.storeIds || user.storeIds.length === 0);
  if (isStoreAdminWithNoStores) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold text-white">Store Overview</h1>
        <div className="mt-8 max-w-lg rounded-lg border border-zinc-800 bg-zinc-900/40 p-6">
          <h2 className="text-sm font-semibold text-zinc-200">No stores assigned to you</h2>
          <p className="text-xs text-zinc-500 mt-2 leading-relaxed">
            Your account is set up as a Store Admin but no stores have
            been linked to it yet. Ask Ops Head to add you to one or more
            stores from the Team page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-8 py-6 space-y-6 max-w-7xl mx-auto">
      {/* Sticky Header Section.
          z-30 (not z-10) so the store-selector dropdown panel — which lives
          inside this wrapper — out-stacks the table's sticky <thead> below.
          Both are position:sticky elements; same z-index would let the later
          DOM node (the table) win the stacking and clip the dropdown. */}
      <div className="sticky top-0 bg-zinc-950 z-30 -mx-8 px-8 pt-8 pb-6 space-y-8">
        {/* Header with Store Selector */}
        <div className="flex items-start justify-between">
        <div>
          {/* Audit UX nit (feature 06): the title used to read "Store
              Overview" regardless of which store was selected, so a
              multi-store admin could only tell what they were looking
              at by re-opening the dropdown. Now the selected store
              name is the title. */}
          <h1 className="text-2xl font-bold text-white">
            {selectedStoreId === null
              ? "Store Overview · All Stores"
              : selectedStoreMeta?.storeName
              ? `Store Overview · ${selectedStoreMeta.storeName}`
              : "Store Overview"}
          </h1>
          <p className="text-sm text-zinc-400 mt-2">
            {user.role === "STORE_ADMIN"
              ? `Tasks for your store${user.storeIds?.length && user.storeIds.length > 1 ? "s" : ""}`
              : "Store-level task breakdown"}
            {selectedStoreId !== null && selectedStoreMeta?.city && (
              <span className="text-zinc-500"> · {selectedStoreMeta.city}</span>
            )}
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
        {([
          { label: "Open Tasks", value: stats.open, sub: null, color: "text-blue-400" },
          { label: "Breached", value: stats.breached, sub: null, color: "text-red-400" },
          // Near SLA: total within 30 min + critical (≤10 min) subset.
          // Surfaces both: the actionable horizon AND the burning-now slice.
          {
            label: "Near SLA",
            value: stats.warning,
            sub: stats.warningCritical > 0 ? `${stats.warningCritical} critical` : "within 30 min",
            color: "text-amber-400",
          },
          { label: "Unassigned", value: stats.unassigned, sub: null, color: "text-yellow-400" },
          // Completed is now time-windowed (today by default — backend
          // respects a ?range=today|7d param). The "Today" suffix makes the
          // number's meaning obvious; without it a Store Manager could
          // assume it's lifetime and reason wrongly about productivity.
          { label: "Completed Today", value: stats.completed, sub: null, color: "text-emerald-400" },
        ] as const).map((s) => (
          <div key={s.label} className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-xs text-zinc-500 mt-0.5">{s.label}</div>
            {s.sub && <div className="text-[10px] text-zinc-600 mt-0.5">{s.sub}</div>}
          </div>
        ))}
      </div>
      </div>{/* close sticky wrapper — per-store strip + filter tabs + table scroll naturally below */}

      {/* Per-store breakdown strip — appears only on "All Stores" view
          when the user has >1 stores. Sorted by breached desc, open desc
          so the store needing attention rises. Click a row → that store
          becomes the selection, the rest of the page narrows to it. */}
      {perStore && perStore.length > 1 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between">
            <div className="text-xs text-zinc-400 uppercase tracking-wider font-semibold">
              By Store · {perStore.length}
            </div>
            <div className="text-[10px] text-zinc-500">click a row to drill in</div>
          </div>
          <div className="divide-y divide-zinc-800">
            {/* Header row */}
            <div className="px-4 py-1.5 grid grid-cols-12 gap-2 text-[10px] text-zinc-500 uppercase tracking-wider">
              <div className="col-span-4">Store</div>
              <div className="col-span-1 text-right">Open</div>
              <div className="col-span-2 text-right">Breached</div>
              <div className="col-span-2 text-right">Near SLA</div>
              <div className="col-span-1 text-right">Unassigned</div>
              <div className="col-span-2 text-right">Done Today</div>
            </div>
            {perStore.map((row) => (
              <button
                key={row.storeId}
                onClick={() => setSelectedStoreId(row.storeId)}
                className="w-full px-4 py-2 grid grid-cols-12 gap-2 text-sm hover:bg-zinc-800/40 transition-colors text-left"
              >
                <div className="col-span-4 min-w-0">
                  <div className="font-medium text-zinc-200 truncate">
                    {row.storeName ?? `#${row.storeId}`}
                  </div>
                  {row.city && <div className="text-[10px] text-zinc-500 truncate">{row.city}</div>}
                </div>
                <div className="col-span-1 text-right text-zinc-300">{row.counts.open || "—"}</div>
                <div className={`col-span-2 text-right ${row.counts.breached > 0 ? "text-red-400 font-medium" : "text-zinc-600"}`}>
                  {row.counts.breached || "—"}
                </div>
                <div className={`col-span-2 text-right ${row.counts.warning > 0 ? "text-amber-400" : "text-zinc-600"}`}>
                  {row.counts.warning > 0
                    ? `${row.counts.warning}${row.counts.warningCritical > 0 ? ` (${row.counts.warningCritical}!)` : ""}`
                    : "—"}
                </div>
                <div className={`col-span-1 text-right ${row.counts.unassigned > 0 ? "text-yellow-400" : "text-zinc-600"}`}>
                  {row.counts.unassigned || "—"}
                </div>
                <div className="col-span-2 text-right text-emerald-400">
                  {row.counts.completed || "—"}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

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

      {/* Task table */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
        </div>
      ) : tasks.length === 0 ? (
        <div className="text-center py-16 text-zinc-600 text-sm">No tasks found</div>
      ) : (
        <div className="border border-zinc-800 rounded-xl overflow-hidden">
          {/* Removed the max-h calc clamp that hard-coded the sticky-region
              height (was max-h-[calc(100vh-480px)]). With the per-store
              strip and filter tabs now scrolling naturally, the table
              grows to fit its contents and the page scroll does the work. */}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-10 bg-zinc-950 border-b border-zinc-800">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-100">Task</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-100">Store</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-100">Data Source</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-100">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-100">Priority</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-100">SLA</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-100">Assigned</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-100">Order</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => {
                  // Prefer the server-joined store (always accurate,
                  // unbounded). Fall back to the local stores list for
                  // backward compatibility on rare cases where the join
                  // didn't run (e.g. cached older responses).
                  const store = task.store ?? (task.storeId == null ? null : stores.find((s) => s.id === task.storeId) ?? null);
                  return (
                  <tr key={task.id} className="border-b border-zinc-800 hover:bg-zinc-800/50 transition-colors">
                    <td className="px-4 py-3 text-sm">
                      <div className="font-medium text-zinc-100">{task.title}</div>
                      <div className="text-xs text-zinc-500 mt-0.5">Order #{task.entityId}</div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {store ? (
                        <div className="text-zinc-200">
                          <div className="font-medium truncate max-w-[180px]" title={store.storeName}>{store.storeName}</div>
                          {store.city && <div className="text-xs text-zinc-500 mt-0.5">{store.city}</div>}
                        </div>
                      ) : task.storeId != null ? (
                        <span className="text-xs text-zinc-500">#{task.storeId}</span>
                      ) : (
                        <span className="text-xs text-zinc-600">—</span>
                      )}
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
                  );
                })}
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
