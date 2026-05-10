"use client";

/**
 * CohortsPanel — agents grouped by hire-month cohort.
 *
 * Helps the head answer "agents added this month vs last month — are
 * the new ones keeping up?". Shows agent_count + completed + breached
 * + SLA % + avg-completion-minutes per cohort, ordered newest-first.
 */
import { useEffect, useState } from "react";

interface Cohort {
  cohortMonth: string; // "YYYY-MM"
  agentCount: number;
  completed: number;
  breached: number;
  slaPercent: number;
  avgCompletionMinutes: number | null;
}

function formatCohortLabel(yyyyMM: string): string {
  // "2026-05" → "May 2026"
  const d = new Date(`${yyyyMM}-01T00:00:00`);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

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

export default function CohortsPanel({ dataSourceId }: { dataSourceId: string | null }) {
  const [cohorts, setCohorts] = useState<Cohort[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    let cancelled = false;
    const ds = dataSourceId ? `?dataSourceId=${encodeURIComponent(dataSourceId)}` : "";
    fetch(`/api/analytics/cohorts${ds}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setCohorts(d?.cohorts ?? []); })
      .catch(() => { if (!cancelled) setCohorts(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [dataSourceId]);

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-white">Cohorts</h2>
        <p className="text-xs text-zinc-500 mt-1">
          Agents grouped by the month they were added — compare new joiners against tenured staff.
        </p>
      </div>

      {loading ? (
        <div className="text-sm text-zinc-500 py-12 text-center">Loading…</div>
      ) : !cohorts || cohorts.length === 0 ? (
        <div className="text-sm text-zinc-500 py-12 text-center">No cohorts yet.</div>
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase px-4 py-2.5">Cohort</th>
                <th className="text-right text-[10px] font-semibold text-zinc-500 uppercase px-3 py-2.5">Agents</th>
                <th className="text-right text-[10px] font-semibold text-zinc-500 uppercase px-3 py-2.5">Completed</th>
                <th className="text-right text-[10px] font-semibold text-zinc-500 uppercase px-3 py-2.5">Breached</th>
                <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase px-3 py-2.5">SLA</th>
                <th className="text-right text-[10px] font-semibold text-zinc-500 uppercase px-3 py-2.5">Avg time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {cohorts.map((c) => (
                <tr key={c.cohortMonth} className="hover:bg-zinc-800/30 transition-colors">
                  <td className="px-4 py-3 text-sm text-zinc-100 font-medium">{formatCohortLabel(c.cohortMonth)}</td>
                  <td className="px-3 py-3 text-sm text-right text-zinc-300">{c.agentCount}</td>
                  <td className="px-3 py-3 text-sm text-right text-zinc-300">{c.completed}</td>
                  <td className={`px-3 py-3 text-sm text-right ${c.breached > 0 ? "text-red-400" : "text-zinc-500"}`}>
                    {c.breached}
                  </td>
                  <td className="px-3 py-3 text-sm">
                    <div className="flex items-center gap-2">
                      <div className="w-20 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                        <div className={`h-full ${slaBarCls(c.slaPercent)} transition-all`} style={{ width: `${c.slaPercent}%` }} />
                      </div>
                      <span className={`text-xs font-semibold ${slaCls(c.slaPercent)}`}>{c.slaPercent}%</span>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-sm text-right text-zinc-300">
                    {c.avgCompletionMinutes !== null ? `${c.avgCompletionMinutes}m` : "—"}
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
