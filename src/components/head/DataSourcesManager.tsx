/**
 * Data Sources Manager Component
 * Allows OPS_HEAD to manage multi-source configuration
 *
 * Features:
 * - View all registered data sources
 * - Add new data sources
 * - Test source connections
 * - View polling status
 * - Deactivate sources
 */

"use client";

import React, { useState, useEffect } from "react";

interface DataSource {
  id: string;
  sourceId: string;
  displayName: string;
  description?: string;
  tableReference: string;
  primaryKeyField: string;
  typeFieldName: string;
  statusFieldName: string;
  queryTemplate: string;
  metadataFieldMapping?: Record<string, string> | null;
  pollingIntervalMinutes: number;
  isActive: boolean;
  pollingType: string;
  syncStrategy: string;
  backfillEnabled: boolean;
  backfillCompleted: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PollingStatus {
  sourceId: string;
  lastPoll?: {
    startedAt: string;
    status: string;
    tasksCreated: number;
  };
  totalPolls: number;
  successfulPolls: number;
  failedPolls: number;
}

export function DataSourcesManager() {
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [pollingStatuses, setPollingStatuses] = useState<Record<string, PollingStatus>>({});
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    sourceId: string;
    ok: boolean;
    message: string;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<"all" | "active">("all");

  useEffect(() => {
    loadDataSources();
  }, []);

  const loadDataSources = async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/data-sources");
      const data = await response.json();
      setDataSources(data.dataSources || []);

      for (const source of data.dataSources || []) {
        loadPollingStatus(source.id);
      }
    } catch (error) {
      console.error("Error loading data sources:", error);
    } finally {
      setLoading(false);
    }
  };

  const loadPollingStatus = async (sourceId: string) => {
    try {
      const response = await fetch(`/api/data-sources/${sourceId}/polling-status`);
      const data = await response.json();
      setPollingStatuses((prev) => ({
        ...prev,
        [sourceId]: data,
      }));
    } catch (error) {
      console.error(`Error loading polling status for ${sourceId}:`, error);
    }
  };

  const handleTestConnection = async (source: DataSource) => {
    setIsTesting(true);
    setTestResult(null);

    try {
      const response = await fetch("/api/data-sources/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceId: source.sourceId,
          tableReference: source.tableReference,
          primaryKeyField: "id",
          typeFieldName: "type",
          statusFieldName: "status",
        }),
      });

      const data = await response.json();
      setTestResult({
        sourceId: source.sourceId,
        ok: response.ok,
        message: data.message || (response.ok ? "Connection successful" : "Connection failed"),
      });
    } catch (error) {
      setTestResult({
        sourceId: source.sourceId,
        ok: false,
        message: error instanceof Error ? error.message : "Test failed",
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleDeactivate = async (source: DataSource) => {
    if (!window.confirm(`Deactivate source "${source.displayName}"?`)) return;

    try {
      const response = await fetch(`/api/data-sources/${source.id}`, {
        method: "DELETE",
      });

      if (response.ok) {
        setDataSources((prev) =>
          prev.map((s) =>
            s.id === source.id ? { ...s, isActive: false } : s
          )
        );
      }
    } catch (error) {
      console.error("Error deactivating source:", error);
    }
  };

  const handleTriggerPolling = async (source: DataSource) => {
    try {
      const response = await fetch(`/api/data-sources/${source.id}/manual-poll`, {
        method: "POST",
      });

      if (response.ok) {
        await loadPollingStatus(source.id);
      }
    } catch (error) {
      console.error("Error triggering polling:", error);
    }
  };

  const activeSources = dataSources.filter((s) => s.isActive);
  const displayedSources = activeTab === "active" ? activeSources : dataSources;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        <span className="ml-3 text-gray-400">Loading data sources...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-2xl font-bold text-white">Data Sources</h2>
          <p className="text-gray-400 mt-1">Manage multi-source task creation</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Register New Source
        </button>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-700">
        <div className="flex gap-8">
          <button
            onClick={() => setActiveTab("all")}
            className={`py-3 px-1 border-b-2 font-medium text-sm transition-colors ${
              activeTab === "all"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-400 hover:text-gray-200"
            }`}
          >
            All Sources ({dataSources.length})
          </button>
          <button
            onClick={() => setActiveTab("active")}
            className={`py-3 px-1 border-b-2 font-medium text-sm transition-colors ${
              activeTab === "active"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-400 hover:text-gray-200"
            }`}
          >
            Active ({activeSources.length})
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="space-y-4">
        {displayedSources.length === 0 ? (
          <div className="border border-gray-700 rounded-lg p-8 text-center">
            <p className="text-gray-500">
              {activeTab === "active"
                ? "No active data sources"
                : "No data sources configured. Register one to get started."}
            </p>
          </div>
        ) : (
          displayedSources.map((source) => (
            <SourceCard
              key={source.id}
              source={source}
              pollingStatus={pollingStatuses[source.id]}
              onTest={handleTestConnection}
              onTriggerPolling={handleTriggerPolling}
              onDeactivate={handleDeactivate}
              isTesting={isTesting}
              testResult={testResult?.sourceId === source.sourceId ? testResult : null}
            />
          ))
        )}
      </div>

      {/* Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="w-full max-w-lg bg-gray-900 rounded-lg shadow-xl overflow-hidden border border-gray-700">
            <div className="px-6 py-4 border-b border-gray-700 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-white">Register New Data Source</h3>
                <p className="text-sm text-gray-400 mt-1">Configure a new table as a task source</p>
              </div>
              <button
                onClick={() => setShowForm(false)}
                className="p-2 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <SourceForm
              onSuccess={() => {
                loadDataSources();
                setShowForm(false);
              }}
              onClose={() => setShowForm(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function SourceCard({
  source,
  pollingStatus,
  onTest,
  onTriggerPolling,
  onDeactivate,
  isTesting,
  testResult,
}: {
  source: DataSource;
  pollingStatus?: PollingStatus;
  onTest: (source: DataSource) => void;
  onTriggerPolling: (source: DataSource) => void;
  onDeactivate: (source: DataSource) => void;
  isTesting: boolean;
  testResult: { ok: boolean; message: string } | null;
}) {
  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden bg-gray-800">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-700 bg-gray-900">
        <div className="flex justify-between items-start">
          <div>
            <h3 className="text-lg font-semibold text-white">{source.displayName}</h3>
            <div className="flex gap-3 mt-2 text-sm">
              <code className="bg-gray-700 px-2 py-1 rounded text-gray-200">{source.sourceId}</code>
              <span className="text-gray-400">Table: <code className="bg-gray-700 px-2 py-1 rounded text-gray-200">{source.tableReference}</code></span>
            </div>
          </div>
          <span className={`px-3 py-1 rounded-full text-sm font-medium ${
            source.isActive
              ? "bg-green-100 text-green-800"
              : "bg-gray-100 text-gray-800"
          }`}>
            {source.isActive ? "Active" : "Inactive"}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="px-6 py-6 space-y-6">
        {/* Configuration */}
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-gray-400 font-medium">Polling Interval</p>
              <p className="mt-1 text-white">{source.pollingIntervalMinutes} minutes</p>
            </div>
            <div>
              <p className="text-gray-400 font-medium">Polling Type</p>
              <p className="mt-1 text-white">{source.pollingType}</p>
            </div>
            <div>
              <p className="text-gray-400 font-medium">Sync Strategy</p>
              <p className="mt-1 text-white">{source.syncStrategy}</p>
            </div>
            <div>
              <p className="text-gray-400 font-medium">Created</p>
              <p className="mt-1 text-white">{new Date(source.createdAt).toLocaleDateString()}</p>
            </div>
          </div>

          {/* Column Mappings */}
          <div className="border-t border-gray-700 pt-4">
            <p className="text-sm font-semibold text-white mb-3">Column Mappings</p>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-gray-400 font-medium">Type Field</p>
                <p className="mt-1 text-white">{source.typeFieldName || "—"}</p>
              </div>
              <div>
                <p className="text-gray-400 font-medium">Status Field</p>
                <p className="mt-1 text-white">{source.statusFieldName || "—"}</p>
              </div>
              <div>
                <p className="text-gray-400 font-medium">Primary Key</p>
                <p className="mt-1 text-white">{source.primaryKeyField || "id"}</p>
              </div>
            </div>
          </div>

          {/* Query Template */}
          {source.queryTemplate && (
            <div className="border-t border-gray-700 pt-4">
              <p className="text-sm font-semibold text-white mb-2">Query Template</p>
              <div className="bg-gray-900 border border-gray-700 rounded p-3">
                <code className="text-xs text-gray-300 font-mono break-all">{source.queryTemplate}</code>
              </div>
            </div>
          )}
        </div>

        {/* Polling Status */}
        {pollingStatus && (
          <div className="border-t pt-6">
            <p className="font-semibold text-white mb-4">Polling Status</p>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-gray-600">Total Polls</p>
                <p className="text-2xl font-bold text-white mt-1">{pollingStatus.totalPolls}</p>
              </div>
              <div>
                <p className="text-gray-600">Successful</p>
                <p className="text-2xl font-bold text-green-600 mt-1">{pollingStatus.successfulPolls}</p>
              </div>
              <div>
                <p className="text-gray-600">Failed</p>
                <p className="text-2xl font-bold text-red-600 mt-1">{pollingStatus.failedPolls}</p>
              </div>
            </div>
            {pollingStatus.lastPoll && (
              <p className="text-xs text-gray-600 mt-3">
                Last poll: {new Date(pollingStatus.lastPoll.startedAt).toLocaleString()} —
                <span className={pollingStatus.lastPoll.status === "SUCCESS" ? " text-green-600" : " text-red-600"}>
                  {" " + pollingStatus.lastPoll.status}
                </span>
                {" (" + pollingStatus.lastPoll.tasksCreated + " tasks)"}
              </p>
            )}
          </div>
        )}

        {/* Test Result */}
        {testResult?.sourceId === source.sourceId && (
          <div className={`border-t pt-6 p-4 rounded-lg ${testResult.ok ? "bg-green-50" : "bg-red-50"}`}>
            <div className="flex gap-3">
              {testResult.ok ? (
                <svg className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
              )}
              <div>
                <p className={`font-medium ${testResult.ok ? "text-green-900" : "text-red-900"}`}>
                  {testResult.ok ? "Connection Successful" : "Connection Failed"}
                </p>
                <p className={`text-sm mt-1 ${testResult.ok ? "text-green-700" : "text-red-700"}`}>
                  {testResult.message}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="border-t pt-6 flex gap-2">
          <button
            onClick={() => onTest(source)}
            disabled={isTesting}
            className="px-4 py-2 border border-gray-600 rounded-lg text-gray-200 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium text-sm"
          >
            {isTesting ? "Testing..." : "Test Connection"}
          </button>
          <button
            onClick={() => onTriggerPolling(source)}
            className="px-4 py-2 border border-gray-600 rounded-lg text-gray-200 hover:bg-gray-700 transition-colors font-medium text-sm flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Manual Poll
          </button>
          {source.isActive && (
            <button
              onClick={() => onDeactivate(source)}
              className="px-4 py-2 border border-red-300 bg-red-50 rounded-lg text-red-700 hover:bg-red-100 transition-colors font-medium text-sm flex items-center gap-2 ml-auto"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              Deactivate
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface Table {
  name: string;
  label: string;
}

interface Column {
  name: string;
  type: string;
  nullable: boolean;
  label: string;
}

function SourceForm({
  onSuccess,
  onClose,
}: {
  onSuccess: () => void;
  onClose: () => void;
}) {
  const [formData, setFormData] = useState({
    sourceId: "",
    displayName: "",
    tableReference: "",
    primaryKeyField: "id",
    typeFieldName: "",
    statusFieldName: "",
    queryTemplate: "",
    pollingIntervalMinutes: 5,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tables, setTables] = useState<Table[]>([]);
  const [columns, setColumns] = useState<Column[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [loadingColumns, setLoadingColumns] = useState(false);;

  // Load available tables on mount
  React.useEffect(() => {
    loadTables();
  }, []);

  const loadTables = async () => {
    try {
      setLoadingTables(true);
      const response = await fetch("/api/data-sources/available-tables");
      const data = await response.json();
      setTables(data.tables || []);
    } catch (err) {
      console.error("Error loading tables:", err);
    } finally {
      setLoadingTables(false);
    }
  };

  const handleTableChange = async (tableName: string) => {
    setFormData({
      ...formData,
      tableReference: tableName,
      typeFieldName: "",
      statusFieldName: "",
    });
    setColumns([]);

    if (!tableName) return;

    try {
      setLoadingColumns(true);
      const response = await fetch(`/api/data-sources/table-columns?table=${tableName}`);
      const data = await response.json();
      setColumns(data.columns || []);
    } catch (err) {
      console.error("Error loading columns:", err);
    } finally {
      setLoadingColumns(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/data-sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (response.ok) {
        onSuccess();
      } else {
        const data = await response.json();
        setError(data.error || "Failed to register source");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
      <div>
        <label className="block text-xs font-medium text-gray-200 mb-1.5">
          Source ID <span className="text-red-400">*</span>
        </label>
        <input
          type="text"
          required
          placeholder="e.g., appointments, camps"
          value={formData.sourceId}
          onChange={(e) => setFormData({ ...formData, sourceId: e.target.value })}
          className="w-full px-3 py-2 border border-gray-600 rounded-lg text-sm placeholder-gray-400 bg-gray-800 text-white focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
        <p className="text-xs text-gray-400 mt-1">Unique identifier for this source</p>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-200 mb-1.5">
          Display Name <span className="text-red-400">*</span>
        </label>
        <input
          type="text"
          required
          placeholder="e.g., Patient Appointments"
          value={formData.displayName}
          onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
          className="w-full px-3 py-2 border border-gray-600 rounded-lg text-sm placeholder-gray-400 bg-gray-800 text-white focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-200 mb-1.5">
          Table Reference <span className="text-red-400">*</span>
        </label>
        <select
          required
          value={formData.tableReference}
          onChange={(e) => handleTableChange(e.target.value)}
          disabled={loadingTables}
          className="w-full px-3 py-2 border border-gray-600 rounded-lg text-sm placeholder-gray-400 bg-gray-800 text-white focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <option value="">
            {loadingTables ? "Loading tables..." : "Select a table"}
          </option>
          {tables.map((table) => (
            <option key={table.name} value={table.name}>
              {table.label}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-200 mb-1.5">
            Type Field <span className="text-red-400">*</span>
          </label>
          <select
            required
            value={formData.typeFieldName}
            onChange={(e) => setFormData({ ...formData, typeFieldName: e.target.value })}
            disabled={!formData.tableReference || loadingColumns}
            className="w-full px-3 py-2 border border-gray-600 rounded-lg text-sm bg-gray-800 text-white focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">
              {loadingColumns ? "Loading..." : "Select type field"}
            </option>
            {columns.map((col) => (
              <option key={col.name} value={col.name}>
                {col.label} ({col.type})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-200 mb-1.5">
            Status Field <span className="text-red-400">*</span>
          </label>
          <select
            required
            value={formData.statusFieldName}
            onChange={(e) => setFormData({ ...formData, statusFieldName: e.target.value })}
            disabled={!formData.tableReference || loadingColumns}
            className="w-full px-3 py-2 border border-gray-600 rounded-lg text-sm bg-gray-800 text-white focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">
              {loadingColumns ? "Loading..." : "Select status field"}
            </option>
            {columns.map((col) => (
              <option key={col.name} value={col.name}>
                {col.label} ({col.type})
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-200 mb-1.5">
          Query Template <span className="text-red-400">*</span>
        </label>
        <textarea
          required
          rows={3}
          placeholder="e.g., SELECT * FROM table_name WHERE updated_at > $1 ORDER BY created_at DESC"
          value={formData.queryTemplate}
          onChange={(e) => setFormData({ ...formData, queryTemplate: e.target.value })}
          className="w-full px-3 py-2 border border-gray-600 rounded-lg text-sm placeholder-gray-400 bg-gray-800 text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
        <p className="text-xs text-gray-400 mt-1">SQL query template for polling. Use $1 for timestamp parameter.</p>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-200 mb-1.5">
          Polling Interval (minutes)
        </label>
        <input
          type="number"
          min="1"
          value={formData.pollingIntervalMinutes}
          onChange={(e) =>
            setFormData({ ...formData, pollingIntervalMinutes: parseInt(e.target.value) || 5 })
          }
          className="w-full px-3 py-2 border border-gray-600 rounded-lg text-sm placeholder-gray-400 bg-gray-800 text-white focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      {error && (
        <div className="bg-red-900 border border-red-700 rounded-lg p-3">
          <p className="text-sm text-red-200">{error}</p>
        </div>
      )}

      <div className="flex gap-3 justify-end border-t border-gray-700 pt-4">
        <button
          type="button"
          onClick={onClose}
          disabled={loading}
          className="px-4 py-2 border border-gray-600 rounded-lg text-gray-200 hover:bg-gray-700 disabled:opacity-50 transition-colors font-medium"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors font-medium"
        >
          {loading ? "Registering..." : "Register Source"}
        </button>
      </div>
    </form>
  );
}
