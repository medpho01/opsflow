"use client";

/**
 * BreakdownPanel — generic per-dimension analytics table.
 *
 * Renders the response from /api/analytics/breakdown for any of the
 * four supported dimensions (source / rule / store / task-type).
 * Same columns regardless of dimension; only the row identity changes.
 *
 * Each row shows the dimension's name + open / completed / breached
 * counts over the selected range + an SLA % bar with traffic-light
 * coloring (matches AgentPerformancePanel's convention so the head's
 * eye reads colour the same way across panels).
 */
import { useEffect, useState } from "react";

type Dimension = "source" | "rule" | "store" | "task-type";
type Range = "today" | "week" | "month";

interface BreakdownRow {
  key: string | number;
  name: string;
  open: number;
  completed: number;
  breached: number;
  slaCompliance: number;
  total: number;
}

interface BreakdownResponse {
  dimension: Dimension;
  range: Range;
  since: string;
  breakdown: BreakdownRow[];
}

const DIMENSION_LABELS: Record<Dimension, { title: string; rowHeader: string }> = {
  source:      { title: "By Data Source", rowHeader: "Source" },
  rule:        { title: "By Task Rule",   rowHeader: "Rule" },
  store:       { title: "By Store",       rowHeader: "Store" },
  "task-type": { title: "By Task Type",   rowHeader: "Task Type" },
};

function slaCls(pct: number) {
  if (pct >= 95) return "text-emerald-400";
  if (pct >= 80) return "text-amber-400";
  return "text-red-400";
}
function slaBarCls(pct: number) {
  if (pct >= 95) return "bg-emerald-500";
  if (pct >= 80) return "bg-amber-500";
  return "bg-red-500";
}

export default function BreakdownPanel({ dimension }: { dimension: Dimension }) {
  const [range, setRange] = useState<Range>("week");
  const [data, setData] = useState<BreakdownResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    let cancelled = false;
    fetch(`/api/analytics/breakdown?dimension=${dimension}&range=${range}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [dimension, range]);

  const labels = DIMENSION_LABELS[dimension];

  return (
    <div>
      <div className="flex items-end justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-white">{labels.title}</h2>
          <p className="text-xs text-zinc-500 mt-1">
            Open + completed / breached over the selected range, with SLA compliance.
          </p>
        </div>
        <div className="inline-flex rounded-lg bg-zinc-900 border border-zinc-800 p-0.5">
          {(["today", "week", "month"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                range === r ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {r === "today" ? "Today" : r === "week" ? "7d" : "30d"}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-zinc-500 py-8 text-center">Loading…</div>
      ) : !data || data.breakdown.length === 0 ? (
        <div className="text-sm text-zinc-500 py-8 text-center">No data yet for this range.</div>
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase px-4 py-2.5">{labels.rowHeader}</th>
                <th className="text-right text-[10px] font-semibold text-zinc-500 uppercase px-3 py-2.5">Open</th>
                <th className="text-right text-[10px] font-semibold text-zinc-500 uppercase px-3 py-2.5">Completed</th>
                <th className="text-right text-[10px] font-semibold text-zinc-500 uppercase px-3 py-2.5">Breached</th>
                <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase px-3 py-2.5">SLA</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {data.breakdown.map((row) => (
                <tr key={row.key} className="hover:bg-zinc-800/30 transition-colors">
                  <td className="px-4 py-3 text-sm text-zinc-100">{row.name}</td>
                  <td className="px-3 py-3 text-sm text-right text-zinc-300">{row.open}</td>
                  <td className="px-3 py-3 text-sm text-right text-zinc-300">{row.completed}</td>
                  <td className={`px-3 py-3 text-sm text-right ${row.breached > 0 ? "text-red-400" : "text-zinc-500"}`}>
                    {row.breached}
                  </td>
                  <td className="px-3 py-3 text-sm">
                    <div className="flex items-center gap-2">
                      <div className="w-20 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full ${slaBarCls(row.slaCompliance)} transition-all`}
                          style={{ width: `${row.slaCompliance}%` }}
                        />
                      </div>
                      <span className={`text-xs font-semibold ${slaCls(row.slaCompliance)}`}>
                        {row.slaCompliance}%
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
