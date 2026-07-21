"use client";

/**
 * OrderLoadPanel — "Order Load" analytics tab.
 *
 * Answers "which days and times carry the most order appointments" so
 * ops can plan phlebo shifts and staffing instead of discovering the
 * 6 AM pile every morning. Three views off one API call
 * (/api/analytics/order-load):
 *
 *   1. Day-of-week × hour heatmap (IST) — the recurring pattern, built
 *      from PAST days only so future bookings don't skew the norm.
 *   2. Busiest days ranking — actual dates in the window, with totals.
 *   3. Upcoming 7 days strip — booked-ahead load per day, the direct
 *      staffing signal.
 *
 * Order-type chips filter all three views client-side. The endpoint
 * measures labstack order volume directly (not tasks), so it reflects
 * demand even where no rule fires.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

interface LoadCell {
  istDate: string;
  istHour: number;
  orderType: string;
  count: number;
}

interface ApiResponse {
  days: number;
  lookaheadDays: number;
  todayIST: string;
  cells: LoadCell[];
}

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RANGE_OPTIONS = [7, 14, 30] as const;

// IST date string (YYYY-MM-DD) → day-of-week index 0-6. Parsing the
// date at UTC noon avoids any DST/offset edge on the date boundary.
function dowOf(istDate: string): number {
  return new Date(`${istDate}T12:00:00Z`).getUTCDay();
}

function fmtDay(istDate: string): string {
  return new Date(`${istDate}T12:00:00Z`).toLocaleDateString("en-IN", {
    weekday: "short", day: "numeric", month: "short",
  });
}

export default function OrderLoadPanel() {
  const [days, setDays] = useState<(typeof RANGE_OPTIONS)[number]>(14);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/analytics/order-load?days=${days}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      setData(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const types = useMemo(() => {
    const s = new Set<string>();
    data?.cells.forEach((c) => s.add(c.orderType));
    return Array.from(s).sort();
  }, [data]);

  const filtered = useMemo(
    () => (data?.cells ?? []).filter((c) => typeFilter === "all" || c.orderType === typeFilter),
    [data, typeFilter]
  );

  // Split past (pattern) vs today+future (upcoming) on the server's IST day.
  const { heat, maxHeat, dayTotals, upcoming } = useMemo(() => {
    const today = data?.todayIST ?? "9999-12-31";
    // 7×24 matrix of summed counts, past days only.
    const heat: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    // How many times each dow occurs in the past window — normalise so a
    // 30d window (4-5 occurrences of each dow) compares fairly.
    const dowOccurrences = new Map<number, Set<string>>();
    const dayTotals = new Map<string, number>();
    const upcoming = new Map<string, number>();

    for (const c of filtered) {
      if (c.istDate < today) {
        const d = dowOf(c.istDate);
        heat[d][c.istHour] += c.count;
        if (!dowOccurrences.has(d)) dowOccurrences.set(d, new Set());
        dowOccurrences.get(d)!.add(c.istDate);
        dayTotals.set(c.istDate, (dayTotals.get(c.istDate) ?? 0) + c.count);
      } else {
        upcoming.set(c.istDate, (upcoming.get(c.istDate) ?? 0) + c.count);
      }
    }

    // Average per occurrence so "Monday 6 AM" means a typical Monday.
    for (let d = 0; d < 7; d++) {
      const n = dowOccurrences.get(d)?.size ?? 0;
      if (n > 1) for (let h = 0; h < 24; h++) heat[d][h] = heat[d][h] / n;
    }
    const maxHeat = Math.max(1, ...heat.flat());
    return { heat, maxHeat, dayTotals, upcoming };
  }, [filtered, data]);

  const busiestDays = useMemo(
    () => Array.from(dayTotals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5),
    [dayTotals]
  );
  const upcomingDays = useMemo(
    () => Array.from(upcoming.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    [upcoming]
  );
  const maxUpcoming = Math.max(1, ...upcomingDays.map(([, n]) => n));

  if (loading) {
    return <div className="py-16 text-center text-sm text-zinc-500">Loading order load…</div>;
  }
  if (error) {
    return (
      <div className="py-16 text-center">
        <div className="text-sm text-red-400">{error}</div>
        <button onClick={fetchData} className="mt-3 px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-200 hover:bg-zinc-700">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider mr-1">Pattern window</span>
          {RANGE_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                days === d ? "bg-blue-600 border-blue-600 text-white" : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
        {types.length > 1 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider mr-1">Type</span>
            {["all", ...types].map((t) => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  typeFilter === t ? "bg-blue-600 border-blue-600 text-white" : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {t === "all" ? "All" : t.replace(/_/g, " ")}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Heatmap — typical appointments per day-of-week × hour */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
        <div className="font-semibold text-zinc-100">Appointment heatmap</div>
        <div className="text-xs text-zinc-500 mt-0.5 mb-4">
          avg appointments per hour (IST), by day of week — last {data?.days} days
        </div>
        <div className="overflow-x-auto">
          <table className="border-separate" style={{ borderSpacing: 2 }}>
            <thead>
              <tr>
                <th className="w-10" />
                {Array.from({ length: 24 }, (_, h) => (
                  <th key={h} className="text-[9px] font-normal text-zinc-600 text-center min-w-[26px]">
                    {h % 3 === 0 ? `${h}` : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <tr key={d}>
                  <td className="text-[10px] text-zinc-500 pr-2 text-right">{DOW_LABELS[d]}</td>
                  {Array.from({ length: 24 }, (_, h) => {
                    const v = heat[d][h];
                    const intensity = v / maxHeat;
                    return (
                      <td
                        key={h}
                        title={`${DOW_LABELS[d]} ${String(h).padStart(2, "0")}:00 — avg ${v.toFixed(1)} appointments`}
                        className="h-[26px] rounded-sm"
                        style={{
                          backgroundColor:
                            v === 0 ? "rgb(39 39 42)" : `rgba(59, 130, 246, ${0.15 + 0.85 * intensity})`,
                        }}
                      />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-2 mt-3 text-[10px] text-zinc-600">
          <span>low</span>
          {[0.15, 0.35, 0.6, 1].map((a) => (
            <span key={a} className="w-4 h-3 rounded-sm inline-block" style={{ backgroundColor: `rgba(59,130,246,${a})` }} />
          ))}
          <span>high · hours are IST</span>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Busiest actual days in the window */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <div className="font-semibold text-zinc-100 mb-3">Busiest days (last {data?.days}d)</div>
          {busiestDays.length === 0 ? (
            <div className="text-sm text-zinc-500">No appointments in window.</div>
          ) : (
            <div className="space-y-2">
              {busiestDays.map(([date, n]) => (
                <div key={date} className="flex items-center gap-3">
                  <span className="text-xs text-zinc-400 w-24 shrink-0">{fmtDay(date)}</span>
                  <div className="flex-1 h-4 bg-zinc-800 rounded overflow-hidden">
                    <div className="h-full bg-blue-600/70" style={{ width: `${(n / busiestDays[0][1]) * 100}%` }} />
                  </div>
                  <span className="text-xs text-zinc-300 w-10 text-right">{n}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Upcoming booked load */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <div className="font-semibold text-zinc-100 mb-3">Upcoming load (today + next {data?.lookaheadDays}d)</div>
          {upcomingDays.length === 0 ? (
            <div className="text-sm text-zinc-500">No upcoming appointments booked yet.</div>
          ) : (
            <div className="space-y-2">
              {upcomingDays.map(([date, n]) => (
                <div key={date} className="flex items-center gap-3">
                  <span className={`text-xs w-24 shrink-0 ${date === data?.todayIST ? "text-blue-300 font-medium" : "text-zinc-400"}`}>
                    {date === data?.todayIST ? "Today" : fmtDay(date)}
                  </span>
                  <div className="flex-1 h-4 bg-zinc-800 rounded overflow-hidden">
                    <div className="h-full bg-emerald-600/70" style={{ width: `${(n / maxUpcoming) * 100}%` }} />
                  </div>
                  <span className="text-xs text-zinc-300 w-10 text-right">{n}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
