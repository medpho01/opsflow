"use client";

/**
 * AnalyticsTabs — top-level tab strip for the Analytics page.
 *
 * Audit (feature 07) flagged the original page as "one long page with
 * two panels stacked — no tabs, no in-page nav". Tabs here lazily mount
 * each panel so cross-tab fetches don't fan out on first load.
 *
 * Tabs:
 *   Agents       — per-agent leaderboard (existing AgentPerformancePanel)
 *   Daily        — per-day summary + poll-cycle health (existing DailySummaryPanel)
 *   Sources      — W2 — per-data-source breakdown
 *   Rules        — W2 — per-rule breakdown
 *   Stores       — W2 — per-store breakdown
 *   Task Types   — W2 — per-task-type breakdown
 */
import { useState } from "react";
import AgentPerformancePanel from "./AgentPerformancePanel";
import DailySummaryPanel from "./DailySummaryPanel";
import BreakdownPanel from "./BreakdownPanel";
import TrendsPanel from "./TrendsPanel";

type Tab = "agents" | "sources" | "rules" | "stores" | "task-types" | "trends" | "daily";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "agents",     label: "Agents" },
  { key: "sources",    label: "Sources" },
  { key: "rules",      label: "Rules" },
  { key: "stores",     label: "Stores" },
  { key: "task-types", label: "Task Types" },
  { key: "trends",     label: "Trends" },
  { key: "daily",      label: "Daily Summary" },
];

export default function AnalyticsTabs() {
  const [tab, setTab] = useState<Tab>("agents");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Analytics</h1>
        <p className="text-sm text-zinc-500 mt-1">Performance breakdowns across the operation.</p>
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
        {tab === "agents"     && <AgentPerformancePanel />}
        {tab === "sources"    && <BreakdownPanel dimension="source" />}
        {tab === "rules"      && <BreakdownPanel dimension="rule" />}
        {tab === "stores"     && <BreakdownPanel dimension="store" />}
        {tab === "task-types" && <BreakdownPanel dimension="task-type" />}
        {tab === "trends"     && <TrendsPanel />}
        {tab === "daily"      && <DailySummaryPanel />}
      </div>
    </div>
  );
}
