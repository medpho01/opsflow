'use client';

/**
 * DataSourceSection — Step 1 of Rule Builder
 *
 * Lets the user pick which data source a rule applies to,
 * then dynamically loads the entity types and statuses
 * from that source so they can define exactly which entities trigger the rule.
 *
 * Outputs:
 *   dataSourceId    — the selected DataSource.id
 *   allowedTypes    — entity types that trigger this rule ([] = all types)
 *   allowedStatuses — entity statuses that trigger this rule ([] = all statuses)
 *   assignmentStrategy — how tasks from this rule get assigned
 */

import React, { useState, useEffect } from 'react';

interface DataSource {
  id: string;
  sourceId: string;
  displayName: string;
  tableReference: string;
  typeFieldName: string;
  statusFieldName: string;
  isActive: boolean;
}

interface DataSourceSectionProps {
  dataSourceId: string;
  allowedTypes: string[];
  allowedStatuses: string[];
  assignmentStrategy: string;
  onDataSourceChange: (id: string, source: DataSource | null) => void;
  onAllowedTypesChange: (types: string[]) => void;
  onAllowedStatusesChange: (statuses: string[]) => void;
  onAssignmentStrategyChange: (strategy: string) => void;
}

const ASSIGNMENT_STRATEGIES = [
  { value: 'default',        label: 'Default (Least Loaded)' },
  { value: 'round_robin',    label: 'Round Robin — distribute evenly' },
  { value: 'store_affinity', label: 'Store Affinity — route to store-assigned agents' },
  { value: 'skill_based',    label: 'Skill Based — match required skills' },
  { value: 'least_loaded',   label: 'Least Loaded — assign to agent with fewest tasks' },
];

export default function DataSourceSection({
  dataSourceId,
  allowedTypes,
  allowedStatuses,
  assignmentStrategy,
  onDataSourceChange,
  onAllowedTypesChange,
  onAllowedStatusesChange,
  onAssignmentStrategyChange,
}: DataSourceSectionProps) {
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [loadingSources, setLoadingSources] = useState(true);
  const [availableTypes, setAvailableTypes] = useState<string[]>([]);
  const [availableStatuses, setAvailableStatuses] = useState<string[]>([]);
  const [loadingTypes, setLoadingTypes] = useState(false);
  const [loadingStatuses, setLoadingStatuses] = useState(false);
  const [selectedSource, setSelectedSource] = useState<DataSource | null>(null);

  // Load data sources on mount
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/data-sources');
        if (res.ok) {
          const data = await res.json();
          const active = (data.dataSources || []).filter((s: DataSource) => s.isActive);
          setDataSources(active);
        }
      } catch (err) {
        console.error('Failed to load data sources:', err);
      } finally {
        setLoadingSources(false);
      }
    };
    load();
  }, []);

  // When a source is selected, load its entity types and statuses
  useEffect(() => {
    if (!dataSourceId || !selectedSource) {
      setAvailableTypes([]);
      setAvailableStatuses([]);
      return;
    }
    loadEnumValues(selectedSource);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSourceId, selectedSource]);

  const loadEnumValues = async (source: DataSource) => {
    const table = source.tableReference.replace(/^.*\./, ''); // strip schema prefix

    // Load entity types
    setLoadingTypes(true);
    try {
      const res = await fetch(
        `/api/data-sources/column-enums?table=${encodeURIComponent(table)}&column=${encodeURIComponent(source.typeFieldName)}`
      );
      if (res.ok) {
        const data = await res.json();
        setAvailableTypes(data.values || []);
      }
    } catch (err) {
      console.error('Failed to load entity types:', err);
    } finally {
      setLoadingTypes(false);
    }

    // Load entity statuses
    setLoadingStatuses(true);
    try {
      const res = await fetch(
        `/api/data-sources/column-enums?table=${encodeURIComponent(table)}&column=${encodeURIComponent(source.statusFieldName)}`
      );
      if (res.ok) {
        const data = await res.json();
        setAvailableStatuses(data.values || []);
      }
    } catch (err) {
      console.error('Failed to load entity statuses:', err);
    } finally {
      setLoadingStatuses(false);
    }
  };

  const handleSourceSelect = (id: string) => {
    const source = dataSources.find((s) => s.id === id) || null;
    setSelectedSource(source);
    onDataSourceChange(id, source);
    // Clear type/status selections when source changes
    onAllowedTypesChange([]);
    onAllowedStatusesChange([]);
  };

  const toggleType = (type: string) => {
    const next = allowedTypes.includes(type)
      ? allowedTypes.filter((t) => t !== type)
      : [...allowedTypes, type];
    onAllowedTypesChange(next);
  };

  const toggleStatus = (status: string) => {
    const next = allowedStatuses.includes(status)
      ? allowedStatuses.filter((s) => s !== status)
      : [...allowedStatuses, status];
    onAllowedStatusesChange(next);
  };

  return (
    <div className="bg-slate-800 p-6 rounded-lg border border-blue-700 space-y-5">
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold text-white">1</div>
        <h3 className="text-lg font-semibold text-white">Data Source &amp; Trigger</h3>
      </div>

      {/* Data Source Picker */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">
          Data Source <span className="text-red-400">*</span>
        </label>
        {loadingSources ? (
          <div className="text-gray-400 text-sm py-2">Loading sources...</div>
        ) : dataSources.length === 0 ? (
          <div className="text-amber-400 text-sm py-2 flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3a9 9 0 100 18A9 9 0 0012 3z" />
            </svg>
            No active data sources. Register one in the Data Sources panel first.
          </div>
        ) : (
          <select
            value={dataSourceId}
            onChange={(e) => handleSourceSelect(e.target.value)}
            className="w-full px-3 py-2 border border-slate-600 bg-slate-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">— Select a data source —</option>
            {dataSources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName} ({s.sourceId})
              </option>
            ))}
          </select>
        )}
        {selectedSource && (
          <p className="text-xs text-gray-400 mt-1">
            Table: <code className="bg-slate-700 px-1 rounded">{selectedSource.tableReference}</code>
            &nbsp;· Type field: <code className="bg-slate-700 px-1 rounded">{selectedSource.typeFieldName}</code>
            &nbsp;· Status field: <code className="bg-slate-700 px-1 rounded">{selectedSource.statusFieldName}</code>
          </p>
        )}
      </div>

      {/* Entity Type Filter */}
      {selectedSource && (
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Trigger when entity type is…
            <span className="ml-1 text-gray-500 font-normal">(leave empty to match all types)</span>
          </label>
          {loadingTypes ? (
            <div className="text-gray-400 text-sm">Loading types...</div>
          ) : availableTypes.length === 0 ? (
            <div className="text-gray-500 text-sm italic">No enum types found — all entity types will match</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {availableTypes.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => toggleType(type)}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                    allowedTypes.includes(type)
                      ? 'bg-blue-600 border-blue-500 text-white'
                      : 'bg-slate-700 border-slate-600 text-gray-300 hover:border-blue-500'
                  }`}
                >
                  {type}
                  {allowedTypes.includes(type) && <span className="ml-1">✓</span>}
                </button>
              ))}
            </div>
          )}
          {allowedTypes.length === 0 && availableTypes.length > 0 && (
            <p className="text-xs text-amber-400 mt-1">ℹ All entity types will trigger this rule</p>
          )}
        </div>
      )}

      {/* Entity Status Filter */}
      {selectedSource && (
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Trigger when entity status is…
            <span className="ml-1 text-gray-500 font-normal">(leave empty to match all statuses)</span>
          </label>
          {loadingStatuses ? (
            <div className="text-gray-400 text-sm">Loading statuses...</div>
          ) : availableStatuses.length === 0 ? (
            <div className="text-gray-500 text-sm italic">No enum statuses found — all entity statuses will match</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {availableStatuses.map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => toggleStatus(status)}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                    allowedStatuses.includes(status)
                      ? 'bg-emerald-600 border-emerald-500 text-white'
                      : 'bg-slate-700 border-slate-600 text-gray-300 hover:border-emerald-500'
                  }`}
                >
                  {status}
                  {allowedStatuses.includes(status) && <span className="ml-1">✓</span>}
                </button>
              ))}
            </div>
          )}
          {allowedStatuses.length === 0 && availableStatuses.length > 0 && (
            <p className="text-xs text-amber-400 mt-1">ℹ All entity statuses will trigger this rule</p>
          )}
        </div>
      )}

      {/* Assignment Strategy */}
      {selectedSource && (
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Assignment Strategy
          </label>
          <select
            value={assignmentStrategy}
            onChange={(e) => onAssignmentStrategyChange(e.target.value)}
            className="w-full px-3 py-2 border border-slate-600 bg-slate-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {ASSIGNMENT_STRATEGIES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <p className="text-xs text-gray-400 mt-1">
            How tasks created by this rule will be assigned to agents
          </p>
        </div>
      )}
    </div>
  );
}
