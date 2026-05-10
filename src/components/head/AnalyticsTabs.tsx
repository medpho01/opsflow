"use client";

/**
 * AnalyticsTabs — top-level tab strip + transversal data-source slicer
 * for the Analytics page.
 *
 * Audit (feature 07) flagged the original page as "one long page with
 * two panels stacked — no tabs, no in-page nav". Tabs here lazily mount
 * each panel.
 *
 * The data-source slicer (W5) is a single dropdown at the top that
 * scopes EVERY panel — the audit's "every metric drillable by source".
 * Each panel accepts `dataSourceId` as a prop and forwards it to its
 * fetch. "All sources" is the default.
 *
 * Tabs:
 *   Agents       — per-agent leaderboard
 *   Daily        — per-day summary + poll-cycle health
 *   Sources      — W2 — per-data-source breakdown
 *   Rules        — W2 — per-rule breakdown
 *   Stores       — W2 — per-store breakdown
 *   Task Types   — W2 — per-task-type breakdown
 *   Trends       — W3 — time-series charts
 *   Cohorts      — W4 — agents grouped by hire-month
 */
import { useEffect, useRef, useState } from "react";
import AgentPerformancePanel from "./AgentPerformancePanel";
import DailySummaryPanel from "./DailySummaryPanel";
import BreakdownPanel from "./BreakdownPanel";
import TrendsPanel from "./TrendsPanel";
import CohortsPanel from "./CohortsPanel";

type Tab = "agents" | "sources" | "rules" | "stores" | "task-types" | "trends" | "cohorts" | "daily";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "agents",     label: "Agents" },
  { key: "sources",    label: "Sources" },
  { key: "rules",      label: "Rules" },
  { key: "stores",     label: "Stores" },
  { key: "task-types", label: "Task Types" },
  { key: "trends",     label: "Trends" },
  { key: "cohorts",    label: "Cohorts" },
  { key: "daily",      label: "Daily Summary" },
];

interface DataSource {
  id: string;
  sourceId: string;
  displayName: string;
}

export default function AnalyticsTabs() {
  const [tab, setTab] = useState<Tab>("agents");
  const [dataSourceId, setDataSourceId] = useState<string | null>(null);
  const [sources, setSources] = useState<DataSource[]>([]);
  // Custom popover for the source dropdown — the native <select> opens
  // an OS-themed white panel that breaks the dark UI; same dark-styled
  // pattern as SavedViewsDropdown / StoreBoard's selector.
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const sourceMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/data-sources")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const list: DataSource[] = (d?.sources ?? d?.dataSources ?? d ?? []).map((s: any) => ({
          id: s.id,
          sourceId: s.sourceId,
          displayName: s.displayName ?? s.sourceId,
        }));
        setSources(list);
      })
      .catch(() => undefined);
  }, []);

  // Close on outside click — matches the SavedViewsDropdown pattern.
  useEffect(() => {
    if (!sourceMenuOpen) return;
    function onDoc(e: MouseEvent) {
      if (sourceMenuRef.current && !sourceMenuRef.current.contains(e.target as Node)) {
        setSourceMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [sourceMenuOpen]);

  const selectedSource = dataSourceId ? sources.find((s) => s.id === dataSourceId) : null;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Analytics</h1>
          <p className="text-sm text-zinc-500 mt-1">Performance breakdowns across the operation.</p>
        </div>

        {/* W5 — Source slicer scopes every panel below. Custom dark
            popover so the OS's native white <select> menu doesn't
            break the theme. */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider font-semibold">Source</span>
          <div className="relative" ref={sourceMenuRef}>
            <button
              onClick={() => setSourceMenuOpen((o) => !o)}
              className="inline-flex items-center gap-2 min-w-[180px] px-3 py-1.5 text-sm bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-lg text-zinc-200 transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <span className="flex-1 text-left truncate">
                {selectedSource ? selectedSource.displayName : "All sources"}
              </span>
              <svg className={`w-3 h-3 text-zinc-500 shrink-0 transition-transform ${sourceMenuOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {sourceMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 min-w-[220px] bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-30 overflow-hidden py-1">
                {[
                  { id: null as string | null, label: "All sources" },
                  ...sources.map((s) => ({ id: s.id as string | null, label: s.displayName })),
                ].map((opt) => {
                  const isSelected = opt.id === dataSourceId;
                  return (
                    <button
                      key={opt.id ?? "all"}
                      onClick={() => { setDataSourceId(opt.id); setSourceMenuOpen(false); }}
                      className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-sm transition-colors text-left ${
                        isSelected
                          ? "bg-blue-600/20 text-blue-400"
                          : "text-zinc-300 hover:bg-zinc-800 hover:text-white"
                      }`}
                    >
                      {isSelected ? (
                        <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <span className="w-3.5 h-3.5 shrink-0" />
                      )}
                      <span className="truncate">{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="border-b border-zinc-800 flex gap-1 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === t.key
                ? "text-blue-400 border-blue-500"
                : "text-zinc-500 border-transparent hover:text-zinc-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div>
        {tab === "agents"     && <AgentPerformancePanel dataSourceId={dataSourceId} />}
        {tab === "sources"    && <BreakdownPanel dimension="source" dataSourceId={null} />}
        {tab === "rules"      && <BreakdownPanel dimension="rule" dataSourceId={dataSourceId} />}
        {tab === "stores"     && <BreakdownPanel dimension="store" dataSourceId={dataSourceId} />}
        {tab === "task-types" && <BreakdownPanel dimension="task-type" dataSourceId={dataSourceId} />}
        {tab === "trends"     && <TrendsPanel dataSourceId={dataSourceId} />}
        {tab === "cohorts"    && <CohortsPanel dataSourceId={dataSourceId} />}
        {tab === "daily"      && <DailySummaryPanel dataSourceId={dataSourceId} />}
      </div>
    </div>
  );
}
