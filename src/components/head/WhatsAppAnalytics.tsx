"use client";

import { useEffect, useState } from "react";

type Bar = { label: string; n: number };
type Data = {
  totals: { open: number; resolvedToday: number; listening: number; unread: number };
  byStatus: Bar[]; byIntent: Bar[]; byStore: Bar[]; byLab: Bar[]; ageBuckets: Bar[];
  volume: { d1: number; d7: number }; briefs: { total: number; resolved: number };
  response?: { open: number; responded: number; respondedRate: number; native: number; console: number; avgFirstMin: number; stale24h: number; resolved24h: number };
};
const short = (s: string) => (s || "").replace(/labstack/gi, "LS");

export default function WhatsAppAnalytics({ onPickGroup }: { onPickGroup?: () => void }) {
  const [d, setD] = useState<Data | null>(null);
  useEffect(() => {
    const load = () => fetch("/api/whatsapp/analytics").then((r) => r.json()).then(setD).catch(() => {});
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  if (!d) return <div className="flex-1 grid place-items-center text-sm text-zinc-500">Loading analytics…</div>;

  return (
    <div className="overflow-y-auto p-6 flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-zinc-100">Overview</h2>
        <p className="text-sm text-zinc-500">Live across every group you&apos;re listening to. Open a chat on the left to work cases.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Open cases" value={d.totals.open} tint="text-blue-300" />
        <Stat label="Resolved · 24h" value={d.totals.resolvedToday} tint="text-emerald-300" />
        <Stat label="Unread chats" value={d.totals.unread} tint="text-amber-300" />
        <Stat label="Listening" value={d.totals.listening} tint="text-zinc-300" />
      </div>

      {d.response && (
        <Panel title="Response & resolution health">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Mini label="Responded" value={`${d.response.respondedRate}%`} sub={`${d.response.responded}/${d.response.open} open`} tint="text-emerald-300" />
            <Mini label="Avg 1st response" value={d.response.avgFirstMin ? `${d.response.avgFirstMin}m` : "—"} sub="last 7d" tint="text-blue-300" />
            <Mini label="Stale >24h" value={String(d.response.stale24h)} sub="untouched open" tint={d.response.stale24h > 0 ? "text-rose-300" : "text-zinc-300"} />
            <Mini label="Resolved · 24h" value={String(d.response.resolved24h)} sub="organic" tint="text-emerald-300" />
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-zinc-500">
            <span>Replies via:</span>
            <span className="text-zinc-300">📱 native {d.response.native}</span>
            <span className="text-zinc-300">🖥️ console {d.response.console}</span>
            <span className="ml-auto">both channels counted as responses</span>
          </div>
        </Panel>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Open by status"><Bars rows={d.byStatus} color="bg-blue-500/60" /></Panel>
        <Panel title="Open by intent"><Bars rows={d.byIntent} color="bg-violet-500/60" /></Panel>
        <Panel title="Age of open cases">
          <div className="grid grid-cols-4 gap-2">
            {d.ageBuckets.map((b) => (
              <div key={b.label} className={`rounded-lg border p-2 text-center ${b.label === "24h+" && b.n > 0 ? "border-rose-500/40 bg-rose-500/10" : "border-zinc-700/60 bg-zinc-900/40"}`}>
                <div className={`text-lg font-semibold ${b.label === "24h+" && b.n > 0 ? "text-rose-300" : "text-zinc-200"}`}>{b.n}</div>
                <div className="text-[10px] text-zinc-500">{b.label}</div>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Message volume">
          <div className="flex gap-6">
            <div><div className="text-2xl font-semibold text-zinc-100">{d.volume.d1}</div><div className="text-[11px] text-zinc-500">last 24h</div></div>
            <div><div className="text-2xl font-semibold text-zinc-100">{d.volume.d7}</div><div className="text-[11px] text-zinc-500">last 7d</div></div>
            <div className="ml-auto text-right"><div className="text-2xl font-semibold text-violet-300">{d.briefs.total}</div><div className="text-[11px] text-zinc-500">AI briefs · {d.briefs.resolved} resolved</div></div>
          </div>
        </Panel>
        <Panel title="Top customers by open cases"><Bars rows={d.byStore.map((b) => ({ ...b, label: short(b.label) }))} color="bg-emerald-500/60" /></Panel>
        <Panel title="Top labs by open cases"><Bars rows={d.byLab.map((b) => ({ ...b, label: short(b.label) }))} color="bg-amber-500/60" /></Panel>
      </div>
    </div>
  );
}

function Stat({ label, value, tint }: { label: string; value: number; tint: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className={`text-3xl font-semibold ${tint}`}>{value}</div>
      <div className="text-xs text-zinc-500 mt-1">{label}</div>
    </div>
  );
}
function Mini({ label, value, sub, tint }: { label: string; value: string; sub?: string; tint: string }) {
  return (
    <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/40 p-3">
      <div className={`text-2xl font-semibold ${tint}`}>{value}</div>
      <div className="text-[11px] text-zinc-400">{label}</div>
      {sub && <div className="text-[10px] text-zinc-600">{sub}</div>}
    </div>
  );
}
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 flex flex-col gap-3">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">{title}</div>
      {children}
    </div>
  );
}
function Bars({ rows, color }: { rows: Bar[]; color: string }) {
  if (!rows.length) return <div className="text-sm text-zinc-600">None</div>;
  const max = Math.max(...rows.map((r) => r.n), 1);
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-xs">
          <span className="w-32 shrink-0 truncate text-zinc-400">{(r.label || "—").replace(/_/g, " ").toLowerCase()}</span>
          <div className="flex-1 h-3 rounded bg-zinc-800/60 overflow-hidden"><div className={`h-full ${color}`} style={{ width: `${(r.n / max) * 100}%` }} /></div>
          <span className="w-8 text-right tabular-nums text-zinc-300">{r.n}</span>
        </div>
      ))}
    </div>
  );
}
