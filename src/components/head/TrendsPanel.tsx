"use client";

/**
 * TrendsPanel — three time-series charts on the analytics Trends tab.
 *
 *   - SLA % over time (line, traffic-light coloured)
 *   - Completion volume per day (bars)
 *   - Breach trend per day (line, red)
 *
 * Inline SVG, no chart library. Same approach as the Team page's
 * coverage heatmap — keeps bundle small and the visual aligned with
 * the rest of the product. Reads /api/analytics/timeseries.
 */
import { useEffect, useState } from "react";

type Range = "week" | "month";

interface Point {
  date: string;
  completed: number;
  breached: number;
  slaPercent: number;
}

interface TimeseriesResponse {
  range: Range;
  since: string;
  series: Point[];
}

function formatShortDay(iso: string): string {
  // "2026-05-10" → "May 10"
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Generic line chart. Auto-scales Y to the max value (with a 1.1x
 * headroom). X is evenly spaced across the points.
 */
function LineChart({
  series,
  yKey,
  yLabel,
  yMax,
  yFormat,
  strokeFor,
}: {
  series: Point[];
  yKey: "slaPercent" | "completed" | "breached";
  yLabel: string;
  yMax?: number;
  yFormat: (v: number) => string;
  strokeFor: (avg: number) => string;
}) {
  const W = 720;
  const H = 160;
  const padL = 36, padR = 12, padT = 14, padB = 24;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const values = series.map((p) => p[yKey]);
  const computedMax = Math.max(1, ...values);
  const max = yMax !== undefined ? yMax : Math.ceil(computedMax * 1.1);

  const x = (i: number) =>
    series.length === 1
      ? padL + innerW / 2
      : padL + (i / (series.length - 1)) * innerW;
  const y = (v: number) => padT + innerH - (v / max) * innerH;

  const avg = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const stroke = strokeFor(avg);

  const path = series.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p[yKey]).toFixed(1)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="none">
      {/* Y axis labels — 0, max/2, max */}
      {[0, max / 2, max].map((v, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="#27272a" strokeWidth={1} strokeDasharray="2 4" />
          <text x={padL - 6} y={y(v) + 3} fill="#71717a" fontSize="9" textAnchor="end">{yFormat(v)}</text>
        </g>
      ))}
      {/* Y label */}
      <text x={6} y={padT + 8} fill="#52525b" fontSize="9">{yLabel}</text>
      {/* Path */}
      <path d={path} fill="none" stroke={stroke} strokeWidth={2} />
      {/* Points */}
      {series.map((p, i) => (
        <g key={p.date}>
          <circle cx={x(i)} cy={y(p[yKey])} r={3} fill={stroke} />
          <title>{`${p.date}: ${yFormat(p[yKey])}`}</title>
        </g>
      ))}
      {/* X axis labels — every Nth point to avoid crowding */}
      {series.map((p, i) => {
        const skip = series.length > 14 ? Math.ceil(series.length / 7) : 1;
        if (i % skip !== 0 && i !== series.length - 1) return null;
        return (
          <text key={p.date} x={x(i)} y={H - 6} fill="#71717a" fontSize="9" textAnchor="middle">
            {formatShortDay(p.date)}
          </text>
        );
      })}
    </svg>
  );
}

function BarChart({ series }: { series: Point[] }) {
  const W = 720;
  const H = 160;
  const padL = 36, padR = 12, padT = 14, padB = 24;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const max = Math.max(1, ...series.map((p) => p.completed));
  const barW = innerW / Math.max(1, series.length) * 0.7;
  const barGap = innerW / Math.max(1, series.length) * 0.3;

  const x = (i: number) => padL + i * (barW + barGap) + barGap / 2;
  const y = (v: number) => padT + innerH - (v / max) * innerH;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="none">
      {[0, max / 2, max].map((v, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="#27272a" strokeWidth={1} strokeDasharray="2 4" />
          <text x={padL - 6} y={y(v) + 3} fill="#71717a" fontSize="9" textAnchor="end">{Math.round(v)}</text>
        </g>
      ))}
      <text x={6} y={padT + 8} fill="#52525b" fontSize="9">Completed</text>
      {series.map((p, i) => (
        <g key={p.date}>
          <rect
            x={x(i)} y={y(p.completed)}
            width={barW}
            height={padT + innerH - y(p.completed)}
            fill="#10b981"
            opacity={0.8}
          />
          <title>{`${p.date}: ${p.completed} completed`}</title>
        </g>
      ))}
      {series.map((p, i) => {
        const skip = series.length > 14 ? Math.ceil(series.length / 7) : 1;
        if (i % skip !== 0 && i !== series.length - 1) return null;
        return (
          <text key={p.date} x={x(i) + barW / 2} y={H - 6} fill="#71717a" fontSize="9" textAnchor="middle">
            {formatShortDay(p.date)}
          </text>
        );
      })}
    </svg>
  );
}

export default function TrendsPanel() {
  const [range, setRange] = useState<Range>("week");
  const [data, setData] = useState<TimeseriesResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    let cancelled = false;
    fetch(`/api/analytics/timeseries?range=${range}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [range]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Trends</h2>
          <p className="text-xs text-zinc-500 mt-1">Daily SLA %, completion volume, and breach trend.</p>
        </div>
        <div className="inline-flex rounded-lg bg-zinc-900 border border-zinc-800 p-0.5">
          {(["week", "month"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                range === r ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {r === "week" ? "7d" : "30d"}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-zinc-500 py-12 text-center">Loading…</div>
      ) : !data || data.series.length === 0 ? (
        <div className="text-sm text-zinc-500 py-12 text-center">No data yet for this range.</div>
      ) : (
        <div className="space-y-6">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <div className="text-xs text-zinc-400 mb-3">SLA % over time</div>
            <LineChart
              series={data.series}
              yKey="slaPercent"
              yLabel="SLA %"
              yMax={100}
              yFormat={(v) => `${Math.round(v)}%`}
              strokeFor={(avg) => avg >= 95 ? "#10b981" : avg >= 80 ? "#f59e0b" : "#ef4444"}
            />
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <div className="text-xs text-zinc-400 mb-3">Completion volume per day</div>
            <BarChart series={data.series} />
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <div className="text-xs text-zinc-400 mb-3">Breach trend</div>
            <LineChart
              series={data.series}
              yKey="breached"
              yLabel="Breached"
              yFormat={(v) => `${Math.round(v)}`}
              strokeFor={() => "#ef4444"}
            />
          </div>
        </div>
      )}
    </div>
  );
}
