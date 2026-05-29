"use client";

/**
 * ChecklistEditor — manages a task type's checklist template inside the
 * RuleForm "Checklist" tab. Add, remove, reorder, toggle required.
 *
 * Important context: a checklist belongs to the TaskType, not the rule.
 * Multiple rules can share a task type, and editing the checklist here
 * affects every rule that uses it. We surface that via the activeRuleCount
 * pill so operators don't accidentally edit a shared template thinking
 * it's rule-scoped.
 *
 * Existing in-flight tasks (TaskChecklistItem rows already copied at
 * creation time) are NOT updated — the new template only applies to
 * tasks created after the save. Surface this in the help text so an
 * operator doesn't expect their open-task list to refresh.
 */
import { useState, useEffect, useCallback } from "react";

interface ChecklistItem {
  id?: number;
  stepText: string;
  isRequired: boolean;
  stepOrder: number;
}

interface ChecklistEditorProps {
  taskTypeId: number | null;
}

export default function ChecklistEditor({ taskTypeId }: ChecklistEditorProps) {
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [taskTypeLabel, setTaskTypeLabel] = useState<string>("");
  const [activeRuleCount, setActiveRuleCount] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    if (!taskTypeId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/task-types/${taskTypeId}/checklist`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems((data.items ?? []) as ChecklistItem[]);
      setTaskTypeLabel(data.taskType?.label ?? data.taskType?.name ?? "");
      setActiveRuleCount(data.activeRuleCount ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load checklist");
    } finally {
      setLoading(false);
    }
  }, [taskTypeId]);

  useEffect(() => { load(); }, [load]);

  const addItem = () => {
    setItems((xs) => [...xs, { stepText: "", isRequired: true, stepOrder: xs.length }]);
  };

  const removeItem = (idx: number) => {
    setItems((xs) => xs.filter((_, i) => i !== idx).map((it, i) => ({ ...it, stepOrder: i })));
  };

  const updateText = (idx: number, text: string) => {
    setItems((xs) => xs.map((it, i) => (i === idx ? { ...it, stepText: text } : it)));
  };

  const toggleRequired = (idx: number) => {
    setItems((xs) => xs.map((it, i) => (i === idx ? { ...it, isRequired: !it.isRequired } : it)));
  };

  const move = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[idx], next[target]] = [next[target], next[idx]];
    setItems(next.map((it, i) => ({ ...it, stepOrder: i })));
  };

  const save = async () => {
    if (!taskTypeId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/task-types/${taskTypeId}/checklist`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: items.map((it, i) => ({
          stepText: it.stepText,
          isRequired: it.isRequired,
          stepOrder: i,
        })) }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setItems(data.items ?? []);
      setSavedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (!taskTypeId) {
    return (
      <div className="bg-white p-6 rounded-lg border border-gray-200">
        <h3 className="text-lg font-semibold mb-2">Checklist</h3>
        <p className="text-sm text-gray-500">
          Pick a task type in Basic Settings first — the checklist belongs to
          the task type, not the rule.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white p-6 rounded-lg border border-gray-200 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold">Checklist</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Steps copied to every new task of type{" "}
            <span className="font-medium text-gray-700">{taskTypeLabel || "—"}</span>.
            Editing here affects new tasks only — existing open tasks keep their
            current steps.
          </p>
        </div>
        {activeRuleCount > 1 && (
          <span className="px-2 py-1 text-[11px] rounded bg-amber-50 text-amber-700 border border-amber-200">
            shared by {activeRuleCount} active rules
          </span>
        )}
      </div>

      {loading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (
        <>
          <div className="space-y-2">
            {items.length === 0 && (
              <div className="text-sm text-gray-500 italic py-3">
                No checklist steps yet. Click &quot;Add step&quot; to start.
              </div>
            )}
            {items.map((it, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <div className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => move(idx, -1)}
                    disabled={idx === 0}
                    className="text-xs text-gray-400 hover:text-gray-700 disabled:opacity-30 leading-none"
                    title="Move up"
                  >▲</button>
                  <button
                    type="button"
                    onClick={() => move(idx, 1)}
                    disabled={idx === items.length - 1}
                    className="text-xs text-gray-400 hover:text-gray-700 disabled:opacity-30 leading-none"
                    title="Move down"
                  >▼</button>
                </div>
                <span className="text-xs text-gray-400 w-5">{idx + 1}.</span>
                <input
                  type="text"
                  value={it.stepText}
                  onChange={(e) => updateText(idx, e.target.value)}
                  placeholder="e.g. Call patient to confirm appointment time"
                  className="flex-1 px-3 py-1.5 border border-gray-300 rounded text-sm"
                />
                <label className="flex items-center gap-1 text-xs text-gray-600 shrink-0">
                  <input
                    type="checkbox"
                    checked={it.isRequired}
                    onChange={() => toggleRequired(idx)}
                  />
                  required
                </label>
                <button
                  type="button"
                  onClick={() => removeItem(idx)}
                  className="text-xs text-red-500 hover:text-red-700 shrink-0"
                  title="Remove"
                >✕</button>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-gray-100">
            <button
              type="button"
              onClick={addItem}
              className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
            >
              + Add step
            </button>
            <div className="flex items-center gap-3">
              {savedAt && !error && (
                <span className="text-xs text-green-600">
                  Saved {savedAt.toLocaleTimeString()}
                </span>
              )}
              {error && (
                <span className="text-xs text-red-600">{error}</span>
              )}
              <button
                type="button"
                onClick={save}
                disabled={saving || items.some((it) => !it.stepText.trim())}
                className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-300"
              >
                {saving ? "Saving…" : "Save checklist"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
