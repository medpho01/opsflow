"use client";

/**
 * SavedViewsDropdown — head-side "Saved views" affordance for All Tasks.
 *
 * Lets the OPS_HEAD persist + reapply common filter combinations
 * ("My SLA risks", "Unassigned", etc.) without re-clicking the filter bar
 * every time. The schema/API already exists at /api/tasks/saved-filters
 * (model UserSavedFilter); this component is the UI hookup.
 *
 * Relationship to UnifiedFilterBar's "Recent:" pills + "💾 Save" button:
 *   - The FilterBar's pills are a one-click shortcut to recently-used
 *     saved filters, ordered by usageCount.
 *   - This dropdown is the canonical "manage saved views" surface — full
 *     list, save current, delete.
 * Both call the same API; the dropdown is the only place delete lives.
 *
 * Behaviour:
 *   - Click the trigger → list of the user's saved views, ordered by
 *     usageCount DESC, then recency.
 *   - Apply: calls onApply with the stored filter object. Parent owns
 *     the filter state, so this component never reads/writes URL.
 *   - Save: prompts for a name (inline), POSTs current filters; the API
 *     upserts on (userId, filterName) so re-saving with the same name
 *     overwrites — that's the rename-by-overwrite behaviour we want.
 *   - Delete: per-row × button, optimistic update with revert on error.
 *
 * Out of scope: shared/global views, auto-detection of "this is similar
 * to an existing view, want to update it?". Keep the surface minimal.
 */
import { useEffect, useRef, useState } from "react";

interface SavedView {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  usage?: number;
}

interface SavedViewsDropdownProps {
  // Whatever the parent's current AppliedFilters object is. Stored as JSON
  // when the user clicks Save.
  currentFilters: Record<string, unknown>;
  // Called with the saved view's filters when the user picks one.
  onApply: (filters: Record<string, unknown>) => void;
}

export default function SavedViewsDropdown({ currentFilters, onApply }: SavedViewsDropdownProps) {
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<SavedView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close the dropdown on outside click — standard popover behaviour.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Lazy-load the views the first time the user opens the dropdown.
  // Re-fetch on every open so a save/delete from another tab is visible.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    fetch("/api/tasks/saved-filters")
      .then((r) => r.json())
      .then((d) => setViews(d.filters ?? []))
      .catch(() => setError("Failed to load saved views"))
      .finally(() => setLoading(false));
  }, [open]);

  const hasFilters = Object.keys(currentFilters).some((k) => {
    const v = currentFilters[k];
    return v !== undefined && v !== null && (Array.isArray(v) ? v.length > 0 : true);
  });

  async function handleSave() {
    const name = saveName.trim();
    if (!name) return;
    try {
      const res = await fetch("/api/tasks/saved-filters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, filters: currentFilters }),
      });
      if (!res.ok) {
        const j = await res.json();
        throw new Error(j.error ?? "Save failed");
      }
      setSaveName("");
      // Re-fetch so the new view appears immediately
      const r = await fetch("/api/tasks/saved-filters");
      const d = await r.json();
      setViews(d.filters ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function handleDelete(view: SavedView) {
    if (!confirm(`Delete saved view "${view.name}"?`)) return;
    // Optimistic
    const previous = views;
    setViews((views ?? []).filter((v) => v.id !== view.id));
    try {
      const res = await fetch(`/api/tasks/saved-filters/${view.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
    } catch (e) {
      setViews(previous);
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="px-3 py-1 text-sm bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 rounded text-zinc-100 transition-colors inline-flex items-center gap-1.5"
        title="Saved filter views"
      >
        <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
        </svg>
        Saved views
        <svg className="w-3 h-3 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-72 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-30 overflow-hidden">
          {/* List of saved views */}
          <div className="max-h-64 overflow-y-auto">
            {loading ? (
              <div className="px-3 py-3 text-xs text-zinc-500">Loading…</div>
            ) : !views || views.length === 0 ? (
              <div className="px-3 py-3 text-xs text-zinc-500">No saved views yet.</div>
            ) : (
              views.map((v) => (
                <div
                  key={v.id}
                  className="group flex items-center gap-2 px-3 py-2 hover:bg-zinc-800 transition-colors border-b border-zinc-800/60 last:border-b-0"
                >
                  <button
                    onClick={() => {
                      onApply(v.filters);
                      setOpen(false);
                    }}
                    className="flex-1 text-left text-sm text-zinc-200 truncate"
                  >
                    {v.name}
                  </button>
                  <button
                    onClick={() => handleDelete(v)}
                    className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 transition-all p-1"
                    title="Delete saved view"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Save current view */}
          <div className="px-3 py-3 border-t border-zinc-800 bg-zinc-950/40">
            <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1.5">
              Save current view
            </div>
            <div className="flex gap-1.5">
              <input
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSave();
                }}
                placeholder="Name (e.g. My SLA risks)"
                className="flex-1 px-2 py-1 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button
                onClick={handleSave}
                disabled={!saveName.trim() || !hasFilters}
                className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-40"
                title={!hasFilters ? "Apply some filters first" : "Save"}
              >
                Save
              </button>
            </div>
            {!hasFilters && (
              <div className="text-[10px] text-zinc-600 mt-1">
                Apply some filters before saving.
              </div>
            )}
            {error && <div className="text-[10px] text-red-400 mt-1">{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
