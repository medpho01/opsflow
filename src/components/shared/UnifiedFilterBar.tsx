"use client";

import { useEffect, useState } from "react";

interface FilterSchema {
  statuses: string[];
  priorities: string[];
  assignees: Array<{ id: number; name: string; avatar: string | null; isActive: boolean }>;
  dataSources: Array<{ id: string; sourceId: string; displayName: string }>;
  dateRangePresets: Array<{ label: string; value: string }>;
}

interface AppliedFilters {
  status?: string[];
  priority?: string[];
  assigneeId?: number[];
  dataSourceId?: string[];
  dateFrom?: string;
  dateTo?: string;
  slaRiskOnly?: boolean;
}

interface SavedFilter {
  id: string;
  name: string;
  filters: AppliedFilters;
  usage: number;
}

interface UnifiedFilterBarProps {
  appliedFilters: AppliedFilters;
  onFilterChange: (filters: AppliedFilters) => void;
  onClearAll: () => void;
}

export default function UnifiedFilterBar({
  appliedFilters,
  onFilterChange,
  onClearAll,
}: UnifiedFilterBarProps) {
  const [schema, setSchema] = useState<FilterSchema | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [savingFilterName, setSavingFilterName] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Load filter schema on mount
  useEffect(() => {
    const fetchSchema = async () => {
      try {
        const res = await fetch("/api/tasks/filters/schema");
        if (res.ok) {
          const data = await res.json();
          setSchema(data);
        }
      } catch (err) {
        console.error("[UnifiedFilterBar] Error fetching schema:", err);
      }
    };

    const fetchSavedFilters = async () => {
      try {
        const res = await fetch("/api/tasks/saved-filters");
        if (res.ok) {
          const data = await res.json();
          setSavedFilters(data.filters || []);
        }
      } catch (err) {
        console.error("[UnifiedFilterBar] Error fetching saved filters:", err);
      }
    };

    fetchSchema();
    fetchSavedFilters();
  }, []);

  const handleStatusChange = (status: string) => {
    const current = appliedFilters.status || [];
    const updated = current.includes(status)
      ? current.filter((s) => s !== status)
      : [...current, status];
    onFilterChange({ ...appliedFilters, status: updated.length > 0 ? updated : undefined });
  };

  const handlePriorityChange = (priority: string) => {
    const current = appliedFilters.priority || [];
    const updated = current.includes(priority)
      ? current.filter((p) => p !== priority)
      : [...current, priority];
    onFilterChange({ ...appliedFilters, priority: updated.length > 0 ? updated : undefined });
  };

  const handleAssigneeChange = (assigneeId: number) => {
    const current = appliedFilters.assigneeId || [];
    const updated = current.includes(assigneeId)
      ? current.filter((a) => a !== assigneeId)
      : [...current, assigneeId];
    onFilterChange({ ...appliedFilters, assigneeId: updated.length > 0 ? updated : undefined });
  };

  const handleDataSourceChange = (dataSourceId: string) => {
    const current = appliedFilters.dataSourceId || [];
    const updated = current.includes(dataSourceId)
      ? current.filter((d) => d !== dataSourceId)
      : [...current, dataSourceId];
    onFilterChange({ ...appliedFilters, dataSourceId: updated.length > 0 ? updated : undefined });
  };

  const handleSlaRiskToggle = () => {
    onFilterChange({ ...appliedFilters, slaRiskOnly: !appliedFilters.slaRiskOnly });
  };

  const handleRemoveFilter = (filterType: string, value?: string | number) => {
    if (filterType === "slaRiskOnly") {
      onFilterChange({ ...appliedFilters, slaRiskOnly: undefined });
    } else if (filterType === "status" && value) {
      handleStatusChange(value as string);
    } else if (filterType === "priority" && value) {
      handlePriorityChange(value as string);
    } else if (filterType === "assigneeId" && value) {
      handleAssigneeChange(value as number);
    } else if (filterType === "dataSourceId" && value) {
      handleDataSourceChange(value as string);
    } else if (filterType === "dateFrom") {
      onFilterChange({ ...appliedFilters, dateFrom: undefined });
    } else if (filterType === "dateTo") {
      onFilterChange({ ...appliedFilters, dateTo: undefined });
    }
  };

  const handleSaveFilter = async () => {
    if (!savingFilterName.trim()) return;

    setIsSaving(true);
    try {
      const res = await fetch("/api/tasks/saved-filters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: savingFilterName,
          filters: appliedFilters,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setSavedFilters([data, ...savedFilters]);
        setSavingFilterName("");
        setShowSaveDialog(false);
      }
    } catch (err) {
      console.error("[UnifiedFilterBar] Error saving filter:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleApplySavedFilter = (filter: SavedFilter) => {
    onFilterChange(filter.filters);
    // Increment usage count
    fetch(`/api/tasks/saved-filters/${filter.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ incrementUsage: true }),
    }).catch(console.error);
  };

  const filterCount = Object.values(appliedFilters).filter((v) => v && (Array.isArray(v) ? v.length > 0 : true)).length;
  const getAssigneeName = (id: number) => schema?.assignees.find((a) => a.id === id)?.name || `Agent ${id}`;
  const getDataSourceName = (id: string) =>
    schema?.dataSources.find((d) => d.id === id)?.displayName || id;

  return (
    <div className="px-6 py-3 border-b border-zinc-800 space-y-3">
      {/* Filter button and active filter tags */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <button
            onClick={() => setShowDropdown(!showDropdown)}
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded font-medium flex items-center gap-2 transition-colors"
          >
            <span>⚙️</span>
            Filters
            {filterCount > 0 && (
              <span className="ml-2 px-1.5 py-0.5 bg-blue-700 rounded text-xs font-semibold">{filterCount}</span>
            )}
          </button>

          {/* Dropdown menu */}
          {showDropdown && schema && (
            <div className="absolute top-full left-0 mt-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-lg z-50 w-96 p-4">
              {/* Statuses */}
              <div className="mb-4">
                <label className="text-xs font-semibold text-zinc-400 uppercase mb-2 block">Statuses</label>
                <div className="space-y-2">
                  {schema.statuses.map((status) => (
                    <label key={status} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={appliedFilters.status?.includes(status) || false}
                        onChange={() => handleStatusChange(status)}
                        className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-blue-600"
                      />
                      <span className="text-zinc-300">{status}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Priorities */}
              <div className="mb-4">
                <label className="text-xs font-semibold text-zinc-400 uppercase mb-2 block">Priorities</label>
                <div className="space-y-2">
                  {schema.priorities.map((priority) => (
                    <label key={priority} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={appliedFilters.priority?.includes(priority) || false}
                        onChange={() => handlePriorityChange(priority)}
                        className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-blue-600"
                      />
                      <span className="text-zinc-300">{priority}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Assignees */}
              <div className="mb-4">
                <label className="text-xs font-semibold text-zinc-400 uppercase mb-2 block">Assignees</label>
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {schema.assignees.map((assignee) => (
                    <label key={assignee.id} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={appliedFilters.assigneeId?.includes(assignee.id) || false}
                        onChange={() => handleAssigneeChange(assignee.id)}
                        className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-blue-600"
                      />
                      <span className="text-zinc-300">{assignee.name}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Data Sources */}
              {schema.dataSources && schema.dataSources.length > 0 && (
                <div className="mb-4">
                  <label className="text-xs font-semibold text-zinc-400 uppercase mb-2 block">Data Source</label>
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    {schema.dataSources.map((ds) => (
                      <label key={ds.id} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={appliedFilters.dataSourceId?.includes(ds.id) || false}
                          onChange={() => handleDataSourceChange(ds.id)}
                          className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-blue-600"
                        />
                        <span className="text-zinc-300">{ds.displayName}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* SLA Risk Only */}
              <div className="mb-4">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={appliedFilters.slaRiskOnly || false}
                    onChange={handleSlaRiskToggle}
                    className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-red-600"
                  />
                  <span className="text-zinc-300">SLA Risk Only (Warning + Critical)</span>
                </label>
              </div>

              {/* Action buttons */}
              <div className="flex gap-2 pt-3 border-t border-zinc-700">
                <button
                  onClick={() => setShowDropdown(false)}
                  className="flex-1 px-2 py-1 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors"
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Active filter tags */}
        {appliedFilters.status && appliedFilters.status.map((status) => (
          <div key={`status-${status}`} className="px-2.5 py-1 bg-blue-500/20 border border-blue-500/50 rounded text-sm text-blue-300 flex items-center gap-2">
            <span>{status}</span>
            <button
              onClick={() => handleRemoveFilter("status", status)}
              className="ml-1 text-blue-400 hover:text-blue-200 font-bold"
            >
              ✕
            </button>
          </div>
        ))}

        {appliedFilters.priority && appliedFilters.priority.map((priority) => (
          <div key={`priority-${priority}`} className="px-2.5 py-1 bg-purple-500/20 border border-purple-500/50 rounded text-sm text-purple-300 flex items-center gap-2">
            <span>{priority}</span>
            <button
              onClick={() => handleRemoveFilter("priority", priority)}
              className="ml-1 text-purple-400 hover:text-purple-200 font-bold"
            >
              ✕
            </button>
          </div>
        ))}

        {appliedFilters.assigneeId && appliedFilters.assigneeId.map((id) => (
          <div key={`assignee-${id}`} className="px-2.5 py-1 bg-cyan-500/20 border border-cyan-500/50 rounded text-sm text-cyan-300 flex items-center gap-2">
            <span>{getAssigneeName(id)}</span>
            <button
              onClick={() => handleRemoveFilter("assigneeId", id)}
              className="ml-1 text-cyan-400 hover:text-cyan-200 font-bold"
            >
              ✕
            </button>
          </div>
        ))}

        {appliedFilters.dataSourceId && appliedFilters.dataSourceId.map((id) => (
          <div key={`ds-${id}`} className="px-2.5 py-1 bg-emerald-500/20 border border-emerald-500/50 rounded text-sm text-emerald-300 flex items-center gap-2">
            <span>📡 {getDataSourceName(id)}</span>
            <button
              onClick={() => handleRemoveFilter("dataSourceId", id)}
              className="ml-1 text-emerald-400 hover:text-emerald-200 font-bold"
            >
              ✕
            </button>
          </div>
        ))}

        {appliedFilters.slaRiskOnly && (
          <div className="px-2.5 py-1 bg-red-500/20 border border-red-500/50 rounded text-sm text-red-300 flex items-center gap-2">
            <span>🔴 SLA Risk</span>
            <button
              onClick={() => handleRemoveFilter("slaRiskOnly")}
              className="ml-1 text-red-400 hover:text-red-200 font-bold"
            >
              ✕
            </button>
          </div>
        )}

        {/* Clear all button */}
        {filterCount > 0 && (
          <button
            onClick={onClearAll}
            className="ml-auto px-3 py-1 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 rounded transition-colors"
          >
            Clear All
          </button>
        )}

        {/* Save this combination button */}
        {filterCount > 0 && !showSaveDialog && (
          <button
            onClick={() => setShowSaveDialog(true)}
            className="px-3 py-1 text-sm bg-green-600/20 hover:bg-green-600/30 border border-green-600/50 text-green-400 rounded transition-colors"
          >
            💾 Save
          </button>
        )}

        {/* Save dialog */}
        {showSaveDialog && (
          <div className="flex items-center gap-2 ml-2">
            <input
              type="text"
              value={savingFilterName}
              onChange={(e) => setSavingFilterName(e.target.value)}
              placeholder="Filter name..."
              className="px-2 py-1 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600"
              autoFocus
            />
            <button
              onClick={handleSaveFilter}
              disabled={isSaving || !savingFilterName.trim()}
              className="px-2 py-1 text-sm bg-green-600 hover:bg-green-500 text-white rounded disabled:opacity-50 transition-colors"
            >
              {isSaving ? "..." : "Save"}
            </button>
            <button
              onClick={() => setShowSaveDialog(false)}
              className="px-2 py-1 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Saved filters quick access */}
      {savedFilters.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-zinc-600 font-medium">Recent:</span>
          {savedFilters.slice(0, 5).map((filter) => (
            <button
              key={filter.id}
              onClick={() => handleApplySavedFilter(filter)}
              className="px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white rounded transition-colors"
              title={`Used ${filter.usage} times`}
            >
              {filter.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
