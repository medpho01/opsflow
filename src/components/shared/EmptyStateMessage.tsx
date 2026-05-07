"use client";

interface AppliedFilters {
  status?: string[];
  priority?: string[];
  assigneeId?: number[];
  dateFrom?: string;
  dateTo?: string;
  slaRiskOnly?: boolean;
}

interface EmptyStateMessageProps {
  filterCount: number;
  totalTasks: number;
  appliedFilters: AppliedFilters;
  onClearFilters: () => void;
  onRemoveFilter: (type: string, value?: string | number) => void;
}

export default function EmptyStateMessage({
  filterCount,
  totalTasks,
  appliedFilters,
  onClearFilters,
  onRemoveFilter,
}: EmptyStateMessageProps) {
  return (
    <div className="flex items-center justify-center min-h-96 px-4">
      <div className="max-w-md text-center space-y-4">
        {/* Icon */}
        <div className="text-5xl mb-4">🔍</div>

        {/* Main message */}
        <h2 className="text-xl font-semibold text-zinc-200">
          No tasks match your filters
        </h2>

        {/* Context */}
        <p className="text-sm text-zinc-400">
          You have <span className="font-medium text-zinc-300">{totalTasks}</span> total{" "}
          {totalTasks === 1 ? "task" : "tasks"}, but none match your current criteria.
        </p>

        {/* Active filters display */}
        {filterCount > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-zinc-500 uppercase">Active Filters:</p>
            <div className="flex flex-wrap gap-2 justify-center">
              {appliedFilters.status &&
                appliedFilters.status.map((status) => (
                  <button
                    key={`status-${status}`}
                    onClick={() => onRemoveFilter("status", status)}
                    className="px-2 py-1 bg-blue-500/20 border border-blue-500/50 rounded text-xs text-blue-300 hover:bg-blue-500/30 transition-colors flex items-center gap-1"
                  >
                    <span>Status: {status}</span>
                    <span className="ml-1 font-bold">✕</span>
                  </button>
                ))}

              {appliedFilters.priority &&
                appliedFilters.priority.map((priority) => (
                  <button
                    key={`priority-${priority}`}
                    onClick={() => onRemoveFilter("priority", priority)}
                    className="px-2 py-1 bg-purple-500/20 border border-purple-500/50 rounded text-xs text-purple-300 hover:bg-purple-500/30 transition-colors flex items-center gap-1"
                  >
                    <span>Priority: {priority}</span>
                    <span className="ml-1 font-bold">✕</span>
                  </button>
                ))}

              {appliedFilters.assigneeId &&
                appliedFilters.assigneeId.map((id) => (
                  <button
                    key={`assignee-${id}`}
                    onClick={() => onRemoveFilter("assigneeId", id)}
                    className="px-2 py-1 bg-cyan-500/20 border border-cyan-500/50 rounded text-xs text-cyan-300 hover:bg-cyan-500/30 transition-colors flex items-center gap-1"
                  >
                    <span>Assignee ID: {id}</span>
                    <span className="ml-1 font-bold">✕</span>
                  </button>
                ))}

              {appliedFilters.slaRiskOnly && (
                <button
                  onClick={() => onRemoveFilter("slaRiskOnly")}
                  className="px-2 py-1 bg-red-500/20 border border-red-500/50 rounded text-xs text-red-300 hover:bg-red-500/30 transition-colors flex items-center gap-1"
                >
                  <span>🔴 SLA Risk Only</span>
                  <span className="ml-1 font-bold">✕</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Recovery suggestions */}
        <div className="space-y-2 pt-4">
          <p className="text-xs font-semibold text-zinc-500 uppercase">Try:</p>
          <div className="flex flex-col gap-2">
            {filterCount > 0 && (
              <button
                onClick={onClearFilters}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded font-medium text-sm transition-colors"
              >
                Clear All Filters
              </button>
            )}

            {appliedFilters.status && appliedFilters.status.length > 0 && (
              <button
                onClick={() => onRemoveFilter("status")}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded font-medium text-sm transition-colors"
              >
                Show All Statuses
              </button>
            )}

            {appliedFilters.priority && appliedFilters.priority.length > 0 && (
              <button
                onClick={() => onRemoveFilter("priority")}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded font-medium text-sm transition-colors"
              >
                Show All Priorities
              </button>
            )}

            {appliedFilters.assigneeId && appliedFilters.assigneeId.length > 0 && (
              <button
                onClick={() => onRemoveFilter("assigneeId")}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded font-medium text-sm transition-colors"
              >
                Show All Assignees
              </button>
            )}

            {filterCount === 0 && totalTasks === 0 && (
              <div className="text-xs text-zinc-500 py-2">
                <p>No tasks have been created yet.</p>
                <p className="mt-1">Create a new task to get started.</p>
              </div>
            )}
          </div>
        </div>

        {/* Helpful footer */}
        {filterCount > 0 && (
          <p className="text-xs text-zinc-600 pt-2">
            Tip: Click the filter tags above to remove them one by one, or clear all at once.
          </p>
        )}
      </div>
    </div>
  );
}
