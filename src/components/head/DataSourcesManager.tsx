/**
 * Data Sources Manager
 * Compact card list with inline polling status + edit drawer
 */
"use client";

import React, { useState, useEffect, useRef } from "react";

interface DataSource {
  id: string;
  sourceId: string;
  displayName: string;
  tableReference: string;
  primaryKeyField: string;
  typeFieldName: string;
  statusFieldName: string;
  queryTemplate: string;
  pollingIntervalMinutes: number;
  isActive: boolean;
  pollingType: string;
  syncStrategy: string;
  createdAt: string;
}

interface PollingStatus {
  sourceId: string;
  lastPoll?: { startedAt: string; status: string; tasksCreated: number };
  totalPolls: number;
  successfulPolls: number;
  failedPolls: number;
  health?: {
    isHealthy: boolean;
    openAlerts: Array<{
      id: number;
      severity: string;
      message: string;
      createdAt: string;
      metadata: { condition?: string; threshold?: string; observed?: string } | null;
    }>;
  };
}

interface Table { name: string; label: string }
interface Column { name: string; type: string; nullable: boolean; label: string }

// ── Icons ─────────────────────────────────────────────────────────────────────
const IconPlus = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
  </svg>
);
const IconRefresh = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
);
const IconEdit = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
  </svg>
);
const IconTrash = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);
const IconClose = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
  </svg>
);

// ── Helpers ───────────────────────────────────────────────────────────────────
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Extract bare table name from formats like public."Appointment" → "Appointment" */
function bareTableName(ref: string): string {
  return ref.replace(/^public\."?/, "").replace(/"?$/, "");
}

/** Build full SQL reference from bare name → public."Appointment" */
function fullTableRef(bare: string): string {
  return `public."${bare}"`;
}

/** Auto-generate query template from table reference */
function autoQueryTemplate(tableRef: string): string {
  return `SELECT * FROM ${tableRef} WHERE updated_at > $1 LIMIT $2`;
}

// ── Main Component ────────────────────────────────────────────────────────────
export function DataSourcesManager() {
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [pollingStatuses, setPollingStatuses] = useState<Record<string, PollingStatus>>({});
  const [loading, setLoading] = useState(true);
  const [drawerSource, setDrawerSource] = useState<DataSource | null>(null); // null = add, DataSource = edit
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [polling, setPolling] = useState<string | null>(null);
  const testTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [previewSource, setPreviewSource] = useState<DataSource | null>(null);

  useEffect(() => { loadAll(); }, []);
  // Clear timers on unmount
  useEffect(() => () => { Object.values(testTimers.current).forEach(clearTimeout); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const res = await fetch("/api/data-sources");
      const data = await res.json();
      const sources: DataSource[] = data.dataSources || [];
      setDataSources(sources);
      sources.forEach((s) => loadStatus(s.id));
    } finally {
      setLoading(false);
    }
  }

  async function loadStatus(id: string) {
    try {
      const res = await fetch(`/api/data-sources/${id}/polling-status`);
      const data = await res.json();
      setPollingStatuses((p) => ({ ...p, [id]: data }));
    } catch { /* non-fatal */ }
  }

  function scheduleTestResultDismiss(sourceId: string) {
    // Clear any existing timer for this source
    if (testTimers.current[sourceId]) clearTimeout(testTimers.current[sourceId]);
    testTimers.current[sourceId] = setTimeout(() => {
      setTestResults((p) => {
        const next = { ...p };
        delete next[sourceId];
        return next;
      });
    }, 5000);
  }

  async function handleTest(source: DataSource) {
    setTesting(source.id);
    setTestResults((p) => ({ ...p, [source.id]: { ok: false, message: "" } }));
    try {
      const res = await fetch("/api/data-sources/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceId: source.sourceId,
          // validate endpoint expects bare table name (no schema prefix)
          tableReference: bareTableName(source.tableReference),
          primaryKeyField: source.primaryKeyField,
          typeFieldName: source.typeFieldName,
          statusFieldName: source.statusFieldName,
        }),
      });
      const data = await res.json();
      // API returns { ok: boolean, message: string } with HTTP 200 — use body ok, not res.ok
      const passed = data.ok === true;
      setTestResults((p) => ({
        ...p,
        [source.id]: {
          ok: passed,
          message: data.message || (passed ? "Connection successful" : "Validation failed"),
        },
      }));
      scheduleTestResultDismiss(source.id);
    } catch (e) {
      setTestResults((p) => ({
        ...p,
        [source.id]: { ok: false, message: e instanceof Error ? e.message : "Error" },
      }));
      scheduleTestResultDismiss(source.id);
    } finally {
      setTesting(null);
    }
  }

  async function handleManualPoll(source: DataSource) {
    setPolling(source.id);
    try {
      await fetch(`/api/data-sources/${source.id}/manual-poll`, { method: "POST" });
      await loadStatus(source.id);
    } finally {
      setPolling(null);
    }
  }

  async function handleDeactivate(source: DataSource) {
    if (!window.confirm(`Deactivate "${source.displayName}"?`)) return;
    const res = await fetch(`/api/data-sources/${source.id}`, { method: "DELETE" });
    if (res.ok) setDataSources((p) => p.map((s) => s.id === source.id ? { ...s, isActive: false } : s));
  }

  function openAdd() { setDrawerSource(null); setDrawerOpen(true); }
  function openEdit(source: DataSource) { setDrawerSource(source); setDrawerOpen(true); }
  function closeDrawer() { setDrawerOpen(false); setDrawerSource(null); }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-zinc-400 gap-3">
        <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        Loading data sources…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Data Sources</h2>
          <p className="text-xs text-zinc-500 mt-0.5">{dataSources.length} configured · {dataSources.filter(s => s.isActive).length} active</p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors"
        >
          <IconPlus /> Register Source
        </button>
      </div>

      {/* Cards */}
      {dataSources.length === 0 ? (
        <div className="border border-zinc-700 rounded-lg p-10 text-center text-zinc-500 text-sm">
          No data sources configured. Register one to get started.
        </div>
      ) : (
        <div className="space-y-2">
          {dataSources.map((source) => (
            <SourceCard
              key={source.id}
              source={source}
              status={pollingStatuses[source.id]}
              testResult={testResults[source.id]}
              isTesting={testing === source.id}
              isPolling={polling === source.id}
              onEdit={() => openEdit(source)}
              onTest={() => handleTest(source)}
              onPreview={() => setPreviewSource(source)}
              onManualPoll={() => handleManualPoll(source)}
              onDeactivate={() => handleDeactivate(source)}
            />
          ))}
        </div>
      )}

      {/* Preview modal — opens when user clicks Preview on a source card */}
      {previewSource && (
        <PreviewModal source={previewSource} onClose={() => setPreviewSource(null)} />
      )}

      {/* Slide-in Drawer — matches TeamPanel max-w-md */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-black/50" onClick={closeDrawer} />
          <div className="w-full max-w-md bg-zinc-900 border-l border-zinc-800 flex flex-col overflow-hidden shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-700">
              <div>
                <h3 className="text-sm font-semibold text-white">
                  {drawerSource ? `Edit: ${drawerSource.displayName}` : "Register New Data Source"}
                </h3>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {drawerSource
                    ? "Only display name and polling interval can be changed"
                    : "Connect a database table as a task source"}
                </p>
              </div>
              <button onClick={closeDrawer} className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors">
                <IconClose />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <SourceForm
                existing={drawerSource}
                onSuccess={() => { loadAll(); closeDrawer(); }}
                onClose={closeDrawer}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Source Card ───────────────────────────────────────────────────────────────
function SourceCard({
  source, status, testResult, isTesting, isPolling,
  onEdit, onTest, onPreview, onManualPoll, onDeactivate,
}: {
  source: DataSource;
  status?: PollingStatus;
  testResult?: { ok: boolean; message: string };
  isTesting: boolean;
  isPolling: boolean;
  onEdit: () => void;
  onTest: () => void;
  onPreview: () => void;
  onManualPoll: () => void;
  onDeactivate: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const lastPoll = status?.lastPoll;
  const lastOk = lastPoll?.status === "SUCCESS";

  return (
    <div className="border border-zinc-700 rounded-lg bg-zinc-900 overflow-hidden">
      {/* Main row */}
      <div className="flex items-center gap-4 px-4 py-3">
        {/* Status dot — green when active and healthy, amber when degraded, grey when inactive */}
        <div
          className={`w-2 h-2 rounded-full flex-shrink-0 ${
            !source.isActive
              ? "bg-zinc-600"
              : status?.health && !status.health.isHealthy
                ? "bg-amber-500"
                : "bg-emerald-500"
          }`}
          title={
            !source.isActive
              ? "Inactive"
              : status?.health && !status.health.isHealthy
                ? `Health degraded: ${status.health.openAlerts.length} open alert(s)`
                : "Healthy"
          }
        />

        {/* Name + meta */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-white truncate">{source.displayName}</span>
            <code className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded">{source.tableReference}</code>
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-[11px] text-zinc-500">
            <span>Type: <span className="text-zinc-400">{source.typeFieldName}</span></span>
            <span>·</span>
            <span>Status: <span className="text-zinc-400">{source.statusFieldName}</span></span>
            <span>·</span>
            <span>Every <span className="text-zinc-400">{source.pollingIntervalMinutes}m</span></span>
            {lastPoll && (
              <>
                <span>·</span>
                <span className={lastOk ? "text-emerald-500" : "text-red-400"}>
                  {lastOk ? "✓" : "✗"} {relativeTime(lastPoll.startedAt)}
                  {lastOk && lastPoll.tasksCreated > 0 && ` · ${lastPoll.tasksCreated} tasks`}
                </span>
              </>
            )}
            {!lastPoll && (
              <>
                <span>·</span>
                <span className="text-zinc-600">No polls yet</span>
              </>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={onEdit}
            className="p-1.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
            title="Edit"
          >
            <IconEdit />
          </button>
          <button
            onClick={onTest}
            disabled={isTesting}
            className="p-1.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-700 disabled:opacity-40 transition-colors text-[11px] font-medium px-2"
            title="Test connection"
          >
            {isTesting ? "Testing…" : "Test"}
          </button>
          <button
            onClick={onPreview}
            className="p-1.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors text-[11px] font-medium px-2"
            title="Preview last 10 rows"
          >
            Preview
          </button>
          <button
            onClick={onManualPoll}
            disabled={isPolling}
            className="p-1.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-700 disabled:opacity-40 transition-colors"
            title="Manual poll"
          >
            <span className={isPolling ? "animate-spin inline-block" : ""}><IconRefresh /></span>
          </button>
          <button
            onClick={() => setExpanded((e) => !e)}
            className="p-1.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
            title={expanded ? "Collapse" : "Expand"}
          >
            <svg className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {source.isActive && (
            <button
              onClick={onDeactivate}
              className="p-1.5 rounded text-red-500 hover:text-red-400 hover:bg-zinc-700 transition-colors"
              title="Deactivate"
            >
              <IconTrash />
            </button>
          )}
        </div>
      </div>

      {/* Test result banner — auto-dismisses after 5s */}
      {testResult && testResult.message && (
        <div className={`flex items-center gap-2 text-xs px-4 py-2 border-t ${testResult.ok
          ? "bg-emerald-950 text-emerald-400 border-emerald-900"
          : "bg-red-950 text-red-400 border-red-900"}`}>
          <span>{testResult.ok ? "✓" : "✗"}</span>
          <span>{testResult.message}</span>
        </div>
      )}

      {/* Health-alert banner — one row per open SOURCE_HEALTH alert. */}
      {status?.health && !status.health.isHealthy && status.health.openAlerts.map((alert) => (
        <div
          key={alert.id}
          className="flex items-start gap-2 text-xs px-4 py-2 border-t bg-amber-950/60 text-amber-300 border-amber-900"
        >
          <span className="font-semibold">⚠</span>
          <div className="flex-1">
            <div>{alert.message}</div>
            {alert.metadata?.threshold && (
              <div className="text-[10px] text-amber-400/70 mt-0.5">
                threshold: {alert.metadata.threshold} · observed: {alert.metadata.observed}
              </div>
            )}
          </div>
          <span className="text-[10px] uppercase tracking-wider opacity-70">{alert.metadata?.condition}</span>
        </div>
      ))}

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-zinc-800 px-4 py-3 space-y-3 bg-zinc-950/50">
          {/* Polling stats */}
          {status && (
            <div className="flex items-center gap-6 text-xs">
              <span className="text-zinc-500">Polls:</span>
              <span className="text-zinc-300">{status.totalPolls} total</span>
              <span className="text-emerald-500">✓ {status.successfulPolls}</span>
              <span className="text-red-400">✗ {status.failedPolls}</span>
              {lastPoll && (
                <span className="text-zinc-500 ml-auto">
                  Last: {new Date(lastPoll.startedAt).toLocaleString()}
                </span>
              )}
            </div>
          )}

          {/* Query template */}
          <div>
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Query Template</p>
            <code className="block text-[11px] text-zinc-300 font-mono bg-zinc-800 px-3 py-2 rounded border border-zinc-700 whitespace-pre-wrap">
              {source.queryTemplate}
            </code>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Source Form (Add + Edit) ───────────────────────────────────────────────────
function SourceForm({
  existing,
  onSuccess,
  onClose,
}: {
  existing: DataSource | null;
  onSuccess: () => void;
  onClose: () => void;
}) {
  const isEdit = !!existing;

  const [displayName, setDisplayName] = useState(existing?.displayName ?? "");
  const [pollingIntervalMinutes, setPollingIntervalMinutes] = useState(existing?.pollingIntervalMinutes ?? 15);
  const [typeFieldName, setTypeFieldName] = useState(existing?.typeFieldName ?? "");
  const [statusFieldName, setStatusFieldName] = useState(existing?.statusFieldName ?? "");
  const [primaryKeyField, setPrimaryKeyField] = useState(existing?.primaryKeyField ?? "id");

  // Add-only fields
  const [sourceId, setSourceId] = useState("");
  const [selectedTable, setSelectedTable] = useState(""); // bare table name (add mode)

  // Derived from table selection (add mode)
  const tableRef = selectedTable ? fullTableRef(selectedTable) : "";
  const queryPreview = tableRef ? autoQueryTemplate(tableRef) : "";

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tables, setTables] = useState<Table[]>([]);
  const [columns, setColumns] = useState<Column[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [loadingColumns, setLoadingColumns] = useState(false);

  useEffect(() => {
    if (!isEdit) {
      loadTables();
    } else {
      // Load columns for existing table so type/status dropdowns work
      loadColumns(bareTableName(existing!.tableReference));
    }
  }, []);

  async function loadTables() {
    setLoadingTables(true);
    try {
      const res = await fetch("/api/data-sources/available-tables");
      const data = await res.json();
      setTables(data.tables || []);
    } finally {
      setLoadingTables(false);
    }
  }

  async function loadColumns(tableName: string) {
    if (!tableName) { setColumns([]); return; }
    setLoadingColumns(true);
    try {
      const res = await fetch(`/api/data-sources/table-columns?table=${encodeURIComponent(tableName)}`);
      const data = await res.json();
      setColumns(data.columns || []);
    } finally {
      setLoadingColumns(false);
    }
  }

  function handleTableChange(bare: string) {
    setSelectedTable(bare);
    setTypeFieldName("");
    setStatusFieldName("");
    loadColumns(bare);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const payload = isEdit
        ? { displayName, pollingIntervalMinutes, typeFieldName, statusFieldName, primaryKeyField }
        : {
            sourceId,
            displayName,
            tableReference: tableRef,
            primaryKeyField,
            typeFieldName,
            statusFieldName,
            queryTemplate: queryPreview,
            pollingIntervalMinutes,
          };

      const res = await fetch(
        isEdit ? `/api/data-sources/${existing!.id}` : "/api/data-sources",
        {
          method: isEdit ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      if (res.ok) {
        onSuccess();
      } else {
        const data = await res.json();
        setError(data.error || "Save failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  }

  const inputCls = "w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
  const labelCls = "block text-xs font-medium text-zinc-400 mb-1.5";

  return (
    <form onSubmit={handleSubmit} className="px-5 py-5 space-y-4">

      {/* ── Edit mode: immutable identity row ── */}
      {isEdit && (
        <div className="flex items-center gap-3 px-3 py-2.5 bg-zinc-800/40 rounded-lg border border-zinc-700/50">
          <div className="flex-1 min-w-0">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Source</p>
            <p className="text-xs font-medium text-zinc-300 truncate">{existing!.sourceId}</p>
          </div>
          <div className="w-px h-8 bg-zinc-700" />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Table</p>
            <p className="text-xs font-mono text-zinc-300 truncate">{existing!.tableReference}</p>
          </div>
        </div>
      )}

      {/* ── Add mode: source ID + display name ── */}
      {!isEdit && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Source ID <span className="text-red-400">*</span></label>
            <input
              type="text"
              required
              placeholder="e.g., appointments"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              className={inputCls}
            />
            <p className="text-[10px] text-zinc-600 mt-1">Unique slug, cannot be changed later</p>
          </div>
          <div>
            <label className={labelCls}>Display Name <span className="text-red-400">*</span></label>
            <input
              type="text"
              required
              placeholder="e.g., Appointments"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className={inputCls}
            />
          </div>
        </div>
      )}

      {/* ── Display name (edit mode) ── */}
      {isEdit && (
        <div>
          <label className={labelCls}>Display Name <span className="text-red-400">*</span></label>
          <input
            type="text"
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className={inputCls}
          />
        </div>
      )}

      {/* ── Add mode: table picker ── */}
      {!isEdit && (
        <div>
          <label className={labelCls}>Table <span className="text-red-400">*</span></label>
          <select
            required
            value={selectedTable}
            onChange={(e) => handleTableChange(e.target.value)}
            disabled={loadingTables}
            className={`${inputCls} disabled:opacity-50`}
          >
            <option value="">{loadingTables ? "Loading tables…" : "Select a table"}</option>
            {tables.map((t) => (
              <option key={t.name} value={t.name}>{t.label}</option>
            ))}
          </select>
        </div>
      )}

      {/* ── Type + Status field pickers (both modes) ── */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Type Field <span className="text-red-400">*</span></label>
          <select
            required
            value={typeFieldName}
            onChange={(e) => setTypeFieldName(e.target.value)}
            disabled={(!isEdit && !selectedTable) || loadingColumns}
            className={`${inputCls} disabled:opacity-50`}
          >
            <option value="">{loadingColumns ? "Loading…" : "Select"}</option>
            {columns.map((c) => <option key={c.name} value={c.name}>{c.label} ({c.type})</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Status Field <span className="text-red-400">*</span></label>
          <select
            required
            value={statusFieldName}
            onChange={(e) => setStatusFieldName(e.target.value)}
            disabled={(!isEdit && !selectedTable) || loadingColumns}
            className={`${inputCls} disabled:opacity-50`}
          >
            <option value="">{loadingColumns ? "Loading…" : "Select"}</option>
            {columns.map((c) => <option key={c.name} value={c.name}>{c.label} ({c.type})</option>)}
          </select>
        </div>
      </div>

      {/* ── Primary key ── */}
      <div>
        <label className={labelCls}>Primary Key Field</label>
        <input
          type="text"
          value={primaryKeyField}
          onChange={(e) => setPrimaryKeyField(e.target.value)}
          className={inputCls}
          placeholder="id"
        />
      </div>

      {/* ── Query template preview (add mode only) ── */}
      {!isEdit && queryPreview && (
        <div>
          <label className={labelCls}>Generated Query <span className="text-zinc-600 font-normal">(auto)</span></label>
          <code className="block text-[11px] text-zinc-400 font-mono bg-zinc-800/50 border border-zinc-700/50 px-3 py-2 rounded-lg">
            {queryPreview}
          </code>
          <p className="text-[10px] text-zinc-600 mt-1">$1 = timestamp filter · $2 = row limit</p>
        </div>
      )}

      {/* ── Polling interval ── */}
      <div>
        <label className={labelCls}>Polling Interval (minutes)</label>
        <input
          type="number"
          min="1"
          value={pollingIntervalMinutes}
          onChange={(e) => setPollingIntervalMinutes(parseInt(e.target.value) || 15)}
          className={inputCls}
        />
      </div>

      {error && (
        <div className="bg-red-950 border border-red-800 rounded-lg px-3 py-2">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      <div className="flex gap-3 justify-end pt-2 border-t border-zinc-700">
        <button
          type="button"
          onClick={onClose}
          disabled={loading}
          className="px-3 py-1.5 border border-zinc-600 rounded-lg text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 text-sm font-medium transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50 text-sm font-medium transition-colors"
        >
          {loading ? "Saving…" : isEdit ? "Save Changes" : "Register Source"}
        </button>
      </div>
    </form>
  );
}

// ── Preview Modal ─────────────────────────────────────────────────────────────
// Shows the last N rows from the source's underlying table so the head can
// sanity-check what the polling engine sees. Read-only.
function PreviewModal({
  source,
  onClose,
}: {
  source: DataSource;
  onClose: () => void;
}) {
  const [data, setData] = useState<{
    rows: Array<Record<string, unknown>>;
    columns: Array<{ column_name: string; data_type: string }>;
    meta: { rowCount: number; orderedBy: string | null; orderedDesc: boolean; limit: number };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(10);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/data-sources/${source.id}/preview?limit=${limit}`);
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(body?.error || `Failed (${res.status})`);
        } else {
          setData(body);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Network error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [source.id, limit]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-6xl max-h-[90vh] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-700">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-white truncate">
              Preview · {source.displayName}
            </h3>
            <div className="flex items-center gap-2 mt-0.5">
              <code className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded">
                {source.tableReference}
              </code>
              {data?.meta.orderedBy && (
                <span className="text-[10px] text-zinc-500">
                  · ordered by <code className="text-zinc-400">{data.meta.orderedBy}</code> {data.meta.orderedDesc ? "DESC" : ""}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-[11px] text-zinc-500">Rows:</label>
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="text-[11px] bg-zinc-800 border border-zinc-700 text-zinc-300 rounded px-1.5 py-1"
            >
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
            </select>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
            >
              <IconClose />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-zinc-400 gap-3">
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-sm">Fetching preview…</span>
            </div>
          ) : error ? (
            <div className="px-5 py-8 text-center">
              <div className="text-sm text-red-400">{error}</div>
              <div className="text-xs text-zinc-500 mt-2">Could not load preview from {source.tableReference}</div>
            </div>
          ) : !data || data.rows.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-zinc-500">
              No rows in {source.tableReference}.
            </div>
          ) : (
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-zinc-950 border-b border-zinc-800">
                <tr>
                  {data.columns.map((c) => (
                    <th
                      key={c.column_name}
                      className="text-left px-3 py-2 font-semibold text-zinc-300 whitespace-nowrap"
                      title={c.data_type}
                    >
                      <div>{c.column_name}</div>
                      <div className="text-[9px] text-zinc-600 font-normal mt-0.5">{c.data_type}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, i) => (
                  <tr key={i} className="border-b border-zinc-800/60 hover:bg-zinc-800/40">
                    {data.columns.map((c) => (
                      <td key={c.column_name} className="px-3 py-2 text-zinc-300 align-top">
                        {renderPreviewCell(row[c.column_name])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        {data && (
          <div className="px-5 py-2 border-t border-zinc-800 text-[11px] text-zinc-500">
            Showing {data.meta.rowCount} of {data.meta.limit} requested · live data from {source.tableReference}
          </div>
        )}
      </div>
    </div>
  );
}

function renderPreviewCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    // Truncate long strings to keep the table scannable
    return value.length > 80 ? value.slice(0, 80) + "…" : value;
  }
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  // Object/array — show a compact JSON snippet
  try {
    const json = JSON.stringify(value);
    return json.length > 80 ? json.slice(0, 80) + "…" : json;
  } catch {
    return "[object]";
  }
}
