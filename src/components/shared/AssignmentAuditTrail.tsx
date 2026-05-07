"use client";

interface AssignmentAudit {
  method?: string;
  ruleId?: string;
  ruleName?: string;
  ruleType?: string;
  ruleTriggerCondition?: Record<string, unknown>;
  evaluatedAt?: string;
  matchResult?: string;
  reasonForManual?: string;
  overriddenBy?: { id: number; name: string };
  overriddenAt?: string;
}

interface AssignmentAuditTrailProps {
  audit: AssignmentAudit | undefined;
  currentAssignee: { id: number; name: string } | null;
  taskId?: number;
}

export default function AssignmentAuditTrail({
  audit,
  currentAssignee,
  taskId,
}: AssignmentAuditTrailProps) {
  if (!audit && !currentAssignee) {
    return null;
  }

  const isAutoAssigned = audit?.method === "auto" || (!audit?.method && audit?.ruleId);
  const isManualAssigned = audit?.method === "manual";

  const formatCondition = (condition: Record<string, unknown> | undefined) => {
    if (!condition) return null;
    return Object.entries(condition)
      .map(([key, value]) => {
        if (Array.isArray(value)) {
          return `${key}: [${(value as string[]).join(", ")}]`;
        }
        return `${key}: ${JSON.stringify(value)}`;
      })
      .join(", ");
  };

  const formatDate = (dateStr: string | undefined) => {
    if (!dateStr) return null;
    try {
      const date = new Date(dateStr);
      return date.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="space-y-4 py-4 px-4 bg-zinc-900/50 rounded-lg border border-zinc-800">
      <div className="flex items-start justify-between">
        <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">
          Assignment Audit
        </h3>
        {isAutoAssigned && (
          <span className="text-xs px-2 py-1 bg-green-500/20 text-green-400 rounded border border-green-500/30">
            Auto-assigned
          </span>
        )}
        {isManualAssigned && (
          <span className="text-xs px-2 py-1 bg-blue-500/20 text-blue-400 rounded border border-blue-500/30">
            Manual assignment
          </span>
        )}
      </div>

      {/* Initial Assignment */}
      {audit && isAutoAssigned && (
        <div className="space-y-2">
          <div className="flex items-start gap-3">
            <div className="mt-1">
              <div className="w-6 h-6 rounded-full bg-green-500/20 border border-green-500/50 flex items-center justify-center">
                <span className="text-xs">✓</span>
              </div>
            </div>
            <div className="flex-1">
              <div className="text-sm font-medium text-zinc-300">
                {audit.ruleName || audit.ruleId || "Rule matched"}
              </div>
              {audit.ruleType && (
                <div className="text-xs text-zinc-500 mt-1">
                  Type: <span className="font-mono">{audit.ruleType}</span>
                </div>
              )}
              {audit.ruleTriggerCondition && (
                <div className="text-xs text-zinc-500 mt-1 bg-zinc-800/30 p-2 rounded border border-zinc-700/30 font-mono break-words">
                  {formatCondition(audit.ruleTriggerCondition) || "No conditions"}
                </div>
              )}
              {currentAssignee && (
                <div className="text-xs text-zinc-400 mt-2">
                  Assigned to: <span className="font-medium text-zinc-200">{currentAssignee.name}</span>
                </div>
              )}
              {audit.evaluatedAt && (
                <div className="text-xs text-zinc-500 mt-1">
                  Evaluated: {formatDate(audit.evaluatedAt)}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Manual Assignment */}
      {audit && isManualAssigned && (
        <div className="space-y-2">
          <div className="flex items-start gap-3">
            <div className="mt-1">
              <div className="w-6 h-6 rounded-full bg-blue-500/20 border border-blue-500/50 flex items-center justify-center">
                <span className="text-xs">⚙</span>
              </div>
            </div>
            <div className="flex-1">
              <div className="text-sm font-medium text-zinc-300">Manual Assignment</div>
              {audit.reasonForManual && (
                <div className="text-xs text-zinc-400 mt-1 italic">
                  Reason: {audit.reasonForManual}
                </div>
              )}
              {currentAssignee && (
                <div className="text-xs text-zinc-400 mt-2">
                  Assigned to: <span className="font-medium text-zinc-200">{currentAssignee.name}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* No Audit Info */}
      {!audit && currentAssignee && (
        <div className="text-sm text-zinc-400">
          Assigned to: <span className="font-medium text-zinc-200">{currentAssignee.name}</span>
        </div>
      )}

      {/* Override History */}
      {audit?.overriddenBy && (
        <div className="pt-2 border-t border-zinc-800">
          <div className="flex items-start gap-3">
            <div className="mt-1">
              <div className="w-6 h-6 rounded-full bg-amber-500/20 border border-amber-500/50 flex items-center justify-center">
                <span className="text-xs">!</span>
              </div>
            </div>
            <div className="flex-1">
              <div className="text-sm font-medium text-amber-400">Override by {audit.overriddenBy.name}</div>
              {audit.overriddenAt && (
                <div className="text-xs text-zinc-500 mt-1">
                  {formatDate(audit.overriddenAt)}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Assignment Method Badge */}
      {!audit && currentAssignee && (
        <div className="text-xs text-zinc-500 border-t border-zinc-800 pt-2">
          Assignment method not tracked for this task
        </div>
      )}
    </div>
  );
}
