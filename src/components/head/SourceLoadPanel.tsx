"use client";

/**
 * SourceLoadPanel — "Source Load" analytics tab.
 *
 * ONE panel for every registered source (orders / requests /
 * appointments / whatever lands in the analytics registry next).
 * Renders by tier, exactly what the source's contract unlocks:
 *
 *   T0  day-of-week × hour heatmap (avg per occurrence, past days only),
 *       busiest days, upcoming booked load (sources with lookahead)
 *   T1  current status distribution (raw vocabulary — ground truth)
 *   T2  fulfillment split + open-backlog aging
 *   T3  first-dimension chips (e.g. orderType / requestType) filter T0
 *
 * Capacity-planning framing throughout: the heatmap answers "when does
 * demand arrive", aging answers "is the backlog growing old", and the
 * fulfillment tiles answer "how much of what arrives do we finish".
 * Contract warnings from the API render as a visible amber strip — a
 * mis-guessed column shrinks the panel and says so, never hides it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

interface LoadCell { istDate: string; istHour: number; type: string; count: number }
interface ApiResponse {
  source: {
    key: string; label: string; eventTimeLabel: string; lookaheadDays: number;
    hasStatus: boolean; hasFulfillment: boolean;
    dimension: { key: string; label: string } | null;
  };
  availableSources: Array<{ key: string; label: string }>;
  days: number;
  todayIST: string;
  warnings: string[];
  cells: LoadCell[];
  statusCounts: Array<{ status: string; count: number }> | null;
  fulfillment: Record<string, number> | null;
  aging: Record<string, number> | null;
}

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RANGE_OPTIONS = [7, 14, 30] as const;

function dowOf(istDate: string): number {
  return new Date(`${istDate}T12:00:00Z`).getUTCDay();
}
function fmtDay(istDate: string): string {
  return new Date(`${istDate}T12:00:00Z`).toLocaleDateString("en-IN", {
    weekday: "short", day: "numeric", month: "short",
  });
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
        active ? "bg-blue-600 border-blue-600 text-white" : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}

export default function SourceLoadPanel() {
  const [source, setSource] = useState("orders");
  const [days, setDays] = useState<(typeof RANGE_OPTIONS)[number]>(14);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/analytics/source-load?source=${source}&days=${days}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      setData(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [source, days]);

  useEffect(() => { fetchData(); }, [fetchData]);
  // Reset the type filter when switching sources — types don't carry over.
  useEffect(() => { setTypeFilter("all"); }, [source]);

  const types = useMemo(() => {
    const s = new Set<string>();
    data?.cells.forEach((c) => { if (c.type) s.add(c.type); });
    return Array.from(s).sort();
  }, [data]);

  const filtered = useMemo(
    () => (data?.cells ?? []).filter((c) => typeFilter === "all" || c.type === typeFilter),
    [data, typeFilter]
  );

  const { heat, maxHeat, dayTotals, upcoming } = useMemo(() => {
    const today = data?.todayIST ?? "9999-12-31";
    const heat: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
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

  // Full chronological per-day series over the window (zero-filled so
  // quiet days are visible as gaps, not silently absent) + the headline
  // capacity number: average per day.
  const { perDay, avgPerDay, maxPerDay } = useMemo(() => {
    const today = data?.todayIST ?? new Date().toISOString().slice(0, 10);
    const windowDays = data?.days ?? 14;
    const series: Array<{ date: string; count: number }> = [];
    const anchor = new Date(`${today}T12:00:00Z`);
    for (let i = windowDays; i >= 1; i--) {
      const d = new Date(anchor.getTime() - i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      series.push({ date: key, count: dayTotals.get(key) ?? 0 });
    }
    const total = series.reduce((s, r) => s + r.count, 0);
    return {
      perDay: series,
      avgPerDay: windowDays > 0 ? total / windowDays : 0,
      maxPerDay: Math.max(1, ...series.map((r) => r.count)),
    };
  }, [dayTotals, data]);
  const upcomingDays = useMemo(
    () => Array.from(upcoming.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    [upcoming]
  );
  const maxUpcoming = Math.max(1, ...upcomingDays.map(([, n]) => n));

  const totalStatus = useMemo(
    () => (data?.statusCounts ?? []).reduce((s, r) => s + r.count, 0),
    [data]
  );
  const fulfillmentTotal = data?.fulfillment
    ? data.fulfillment.fulfilled + data.fulfillment.failed + data.fulfillment.open
    : 0;

  if (loading && !data) {
    return <div className="py-16 text-center text-sm text-zinc-500">Loading source analytics…</div>;
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
  if (!data) return null;

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider mr-1">Source</span>
          {data.availableSources.map((s) => (
            <Chip key={s.key} active={source === s.key} onClick={() => setSource(s.key)}>{s.label}</Chip>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider mr-1">Window</span>
          {RANGE_OPTIONS.map((d) => (
            <Chip key={d} active={days === d} onClick={() => setDays(d)}>{d}d</Chip>
          ))}
        </div>
        {types.length > 1 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider mr-1">
              {data.source.dimension?.label ?? "Type"}
            </span>
            {["all", ...types].map((t) => (
              <Chip key={t} active={typeFilter === t} onClick={() => setTypeFilter(t)}>
                {t === "all" ? "All" : t.replace(/_/g, " ")}
              </Chip>
            ))}
          </div>
        )}
      </div>

      {/* Contract warnings — visible degradation, never silent */}
      {data.warnings.length > 0 && (
        <div className="bg-amber-950/20 border border-amber-900/40 rounded-lg px-4 py-2.5 text-xs text-amber-300 space-y-0.5">
          {data.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
        </div>
      )}

      {/* T0 — heatmap */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
        <div className="font-semibold text-zinc-100">{data.source.label} heatmap</div>
        <div className="text-xs text-zinc-500 mt-0.5 mb-4">
          avg per hour (IST) by day of week, on {data.source.eventTimeLabel} — last {data.days} days
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
                        title={`${DOW_LABELS[d]} ${String(h).padStart(2, "0")}:00 — avg ${v.toFixed(1)} ${data.source.label.toLowerCase()}`}
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
          <span>high · hours are IST · staffing follows the dark bands</span>
        </div>
      </div>

      {/* T0 — volume per day: the headline capacity number + the daily
          series (zero-filled, chronological) so variance is visible, not
          just the mean. */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <div className="font-semibold text-zinc-100">Volume per day</div>
          <div className="text-sm text-zinc-300 tabular-nums">
            avg <b className="text-blue-300">{avgPerDay.toFixed(1)}</b> {data.source.label.toLowerCase()}/day
            <span className="text-zinc-500"> · last {data.days} days · by {data.source.eventTimeLabel}</span>
          </div>
        </div>
        <div className="flex items-end gap-[3px] h-24 mt-4">
          {perDay.map((r) => (
            <div
              key={r.date}
              className="flex-1 rounded-t-sm bg-blue-600/70 hover:bg-blue-500 transition-colors min-w-[4px]"
              style={{ height: `${Math.max(2, (r.count / maxPerDay) * 100)}%` }}
              title={`${fmtDay(r.date)} — ${r.count}`}
            />
          ))}
        </div>
        <div className="flex justify-between mt-1.5 text-[10px] text-zinc-600">
          <span>{perDay[0] ? fmtDay(perDay[0].date) : ""}</span>
          <span>peak {maxPerDay}</span>
          <span>{perDay[perDay.length - 1] ? fmtDay(perDay[perDay.length - 1].date) : ""}</span>
        </div>
      </div>

      {/* T2 — fulfillment tiles */}
      {data.fulfillment && fulfillmentTotal > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="text-2xl font-bold text-zinc-100 tabular-nums">{fulfillmentTotal}</div>
            <div className="text-xs text-zinc-500 mt-1">created in {data.days}d</div>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 border-l-4 border-l-green-700 rounded-lg p-4">
            <div className="text-2xl font-bold text-green-300 tabular-nums">
              {Math.round((data.fulfillment.fulfilled / fulfillmentTotal) * 100)}%
            </div>
            <div className="text-xs text-zinc-500 mt-1">fulfilled ({data.fulfillment.fulfilled})</div>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 border-l-4 border-l-red-800 rounded-lg p-4">
            <div className="text-2xl font-bold text-red-300 tabular-nums">
              {Math.round((data.fulfillment.failed / fulfillmentTotal) * 100)}%
            </div>
            <div className="text-xs text-zinc-500 mt-1">failed / cancelled ({data.fulfillment.failed})</div>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 border-l-4 border-l-amber-700 rounded-lg p-4">
            <div className="text-2xl font-bold text-amber-300 tabular-nums">{data.fulfillment.open}</div>
            <div className="text-xs text-zinc-500 mt-1">still open</div>
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        {/* Busiest days */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <div className="font-semibold text-zinc-100 mb-3">Busiest days (last {data.days}d)</div>
          {busiestDays.length === 0 ? (
            <div className="text-sm text-zinc-500">Nothing in window.</div>
          ) : (
            <div className="space-y-2">
              {busiestDays.map(([date, n]) => (
                <div key={date} className="flex items-center gap-3">
                  <span className="text-xs text-zinc-400 w-24 shrink-0">{fmtDay(date)}</span>
                  <div className="flex-1 h-4 bg-zinc-800 rounded overflow-hidden">
                    <div className="h-full bg-blue-600/70" style={{ width: `${(n / busiestDays[0][1]) * 100}%` }} />
                  </div>
                  <span className="text-xs text-zinc-300 w-10 text-right tabular-nums">{n}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Upcoming (lookahead sources) OR status mix in its place */}
        {data.source.lookaheadDays > 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
            <div className="font-semibold text-zinc-100 mb-3">Upcoming load (today + next {data.source.lookaheadDays}d)</div>
            {upcomingDays.length === 0 ? (
              <div className="text-sm text-zinc-500">Nothing booked ahead yet.</div>
            ) : (
              <div className="space-y-2">
                {upcomingDays.map(([date, n]) => (
                  <div key={date} className="flex items-center gap-3">
                    <span className={`text-xs w-24 shrink-0 ${date === data.todayIST ? "text-blue-300 font-medium" : "text-zinc-400"}`}>
                      {date === data.todayIST ? "Today" : fmtDay(date)}
                    </span>
                    <div className="flex-1 h-4 bg-zinc-800 rounded overflow-hidden">
                      <div className="h-full bg-emerald-600/70" style={{ width: `${(n / maxUpcoming) * 100}%` }} />
                    </div>
                    <span className="text-xs text-zinc-300 w-10 text-right tabular-nums">{n}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          data.aging && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
              <AgingCard aging={data.aging} label={data.source.label} />
            </div>
          )
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* T1 — raw status distribution (ground truth for the vocabulary) */}
        {data.statusCounts && data.statusCounts.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
            <div className="font-semibold text-zinc-100 mb-1">Status mix (created in {data.days}d)</div>
            <div className="text-xs text-zinc-500 mb-3">raw statuses — the source&apos;s own vocabulary</div>
            <div className="space-y-2">
              {data.statusCounts.slice(0, 10).map((r) => (
                <div key={r.status} className="flex items-center gap-3">
                  <span className="text-xs text-zinc-400 w-40 shrink-0 truncate" title={r.status}>{r.status}</span>
                  <div className="flex-1 h-4 bg-zinc-800 rounded overflow-hidden">
                    <div className="h-full bg-zinc-500/60" style={{ width: `${(r.count / Math.max(1, totalStatus)) * 100}%` }} />
                  </div>
                  <span className="text-xs text-zinc-300 w-12 text-right tabular-nums">{r.count}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* T2 — aging (shown here for lookahead sources whose right slot is Upcoming) */}
        {data.source.lookaheadDays > 0 && data.aging && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
            <AgingCard aging={data.aging} label={data.source.label} />
          </div>
        )}
      </div>
    </div>
  );
}

function AgingCard({ aging, label }: { aging: Record<string, number>; label: string }) {
  const total = aging.d1 + aging.d3 + aging.d7 + aging.older;
  const rows: Array<[string, number, string]> = [
    ["< 1 day", aging.d1, "bg-zinc-500/70"],
    ["1–3 days", aging.d3, "bg-amber-600/70"],
    ["3–7 days", aging.d7, "bg-red-600/70"],
    ["older", aging.older, "bg-red-900/80"],
  ];
  return (
    <>
      <div className="font-semibold text-zinc-100 mb-1">Open backlog by age</div>
      <div className="text-xs text-zinc-500 mb-3">
        {total} open {label.toLowerCase()} · a growing dark tail means the backlog is rotting
      </div>
      <div className="space-y-2">
        {rows.map(([l, n, cls]) => (
          <div key={l} className="flex items-center gap-3">
            <span className="text-xs text-zinc-400 w-24 shrink-0">{l}</span>
            <div className="flex-1 h-4 bg-zinc-800 rounded overflow-hidden">
              <div className={`h-full ${cls}`} style={{ width: `${(n / Math.max(1, total)) * 100}%` }} />
            </div>
            <span className="text-xs text-zinc-300 w-10 text-right tabular-nums">{n}</span>
          </div>
        ))}
      </div>
    </>
  );
}
