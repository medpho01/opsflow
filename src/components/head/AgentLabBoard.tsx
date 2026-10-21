"use client";

/** Agents › Lab board: today's orders per lab by checkpoint, open asks, promises, silence, portal, and the at-risk list (DESIGN.md §7.4, FR-16.5). */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Cell = { met: number; atRisk: number; breached: number; pending: number };
type Lab = { labId: number; labName: string; tier: string; today: number; columns: Record<string, Cell>; openAsks: number; promisesDue: number; silentHours: number | null; portal: string | null; atRisk: number };
type Risk = { orderId: number; patientName: string | null; storeName: string | null; labName: string | null; slot: string; riskLevel: string; reasons: string[]; health: string; did: string[] };

const COL_LABEL: Record<string, string> = { confirmed: "Confirmed", phlebo_assigned: "Phlebo", sample_collected: "Collected", sample_at_lab: "At lab", report_delivered: "Report" };

export function AgentLabBoard() {
  const [labs, setLabs] = useState<Lab[]>([]);
  const [cols, setCols] = useState<string[]>([]);
  const [risk, setRisk] = useState<{ items: Risk[]; counts: { high: number; medium: number }; day: string } | null>(null);
  const [day, setDay] = useState<"today" | "tomorrow">("today");
  const [tz, setTz] = useState("Asia/Kolkata");

  const load = useCallback(async () => {
    const [b, r] = await Promise.all([fetch("/api/agents/lab-board"), fetch(`/api/agents/risk?day=${day}`)]);
    const [bb, rb] = await Promise.all([b.json(), r.json()]);
    if (b.ok) { setLabs(bb.labs); setCols(bb.columns); setTz(bb.timeZone); }
    if (r.ok) setRisk(rb);
  }, [day]);
  useEffect(() => { void load(); const t = window.setInterval(load, 60_000); return () => window.clearInterval(t); }, [load]);
  const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz }).format(new Date()));
  const blocks = [["06:00–11:00", "Status updates", hour >= 6 && hour < 11], ["11:00–14:00", "Clean-up", hour >= 11 && hour < 14], ["14:00–18:00", "Reports", hour >= 14 && hour < 18], ["18:00–20:00", "Tomorrow", hour >= 18 && hour < 20], ["After 20:00", "Brain review", hour >= 20 || hour < 6]] as const;

  return (
    <div>
      <div className="mb-4 mt-2">
        <div className="text-xs text-zinc-500">OpsFlow Agents · ops executives</div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Lab board</h1>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">{blocks.map(([t, l, on]) => <div key={t} className={`rounded-md px-3 py-2 text-xs ${on ? "bg-blue-500 text-white" : "border border-zinc-800 text-zinc-400"}`}><b>{t}</b> · {l}</div>)}</div>
      <section className="mb-5 overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900/60 text-left text-[11px] uppercase tracking-wide text-zinc-500"><tr><th className="px-3 py-2">Lab</th><th className="px-3 py-2">Today</th>{cols.map((c) => <th key={c} className="px-3 py-2">{COL_LABEL[c] ?? c}</th>)}<th className="px-3 py-2">Open asks</th><th className="px-3 py-2">Promises due</th><th className="px-3 py-2">Coordinator</th><th className="px-3 py-2">Portal</th></tr></thead>
          <tbody className="divide-y divide-zinc-800/80">
            {labs.map((l) => (
              <tr key={l.labId} className="hover:bg-zinc-900/40">
                <td className="px-3 py-2"><Link href={`/head/agents?labId=${l.labId}`} className="font-medium text-zinc-100 hover:underline">{l.labName}</Link> <span className="text-xs text-zinc-500">{l.tier}</span></td>
                <td className="px-3 py-2 text-zinc-200">{l.today}{l.atRisk ? <span className="ml-1 text-xs text-amber-400">· {l.atRisk} at risk</span> : null}</td>
                {cols.map((c) => { const v = l.columns[c]; return <td key={c} className="px-3 py-2 text-xs"><span className="text-emerald-300">{v.met}</span>{v.atRisk ? <span className="text-amber-300"> · {v.atRisk}</span> : null}{v.breached ? <span className="font-semibold text-red-300"> · {v.breached}</span> : null}{v.pending ? <span className="text-zinc-500"> · {v.pending}</span> : null}</td>; })}
                <td className="px-3 py-2 text-zinc-300">{l.openAsks}</td>
                <td className="px-3 py-2 text-zinc-300">{l.promisesDue}</td>
                <td className="px-3 py-2 text-xs text-zinc-400">{l.silentHours == null ? "—" : l.silentHours < 1 ? "active" : `silent ${Math.round(l.silentHours)} h`}</td>
                <td className="px-3 py-2 text-xs">{l.portal == null ? <span className="text-zinc-500">no portal</span> : <span className={l.portal === "OK" ? "text-emerald-300" : "text-amber-300"}>{l.portal.toLowerCase().replace("_", " ")}</span>}</td>
              </tr>
            ))}
            {labs.length === 0 && <tr><td colSpan={9} className="px-3 py-8 text-center text-sm text-zinc-500">No orders with a slot today in the active window.</td></tr>}
          </tbody>
        </table>
        <div className="px-3 py-2 text-[11px] text-zinc-500">Cells: <span className="text-emerald-300">met</span> · <span className="text-amber-300">at risk</span> · <span className="text-red-300">breached</span> · <span>pending</span></div>
      </section>
      <section className="rounded-lg border border-zinc-800">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
          <h2 className="text-base font-semibold text-zinc-100">At risk · {risk?.items.length ?? 0}{risk ? <span className="ml-2 text-xs font-normal text-zinc-500">{risk.counts.high} high · {risk.counts.medium} medium</span> : null}</h2>
          <div className="flex gap-1 text-xs">{(["today", "tomorrow"] as const).map((d) => <button key={d} onClick={() => setDay(d)} className={`rounded-full border px-3 py-1 ${day === d ? "border-zinc-200 bg-zinc-200 text-zinc-900" : "border-zinc-700 text-zinc-300"}`}>{d}</button>)}</div>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-zinc-900/60 text-left text-[11px] uppercase tracking-wide text-zinc-500"><tr><th className="px-3 py-2">Order</th><th className="px-3 py-2">Store · lab</th><th className="px-3 py-2">Slot</th><th className="px-3 py-2">Risk</th><th className="px-3 py-2">Why</th><th className="px-3 py-2">What the agent did</th></tr></thead>
          <tbody className="divide-y divide-zinc-800/80">
            {(risk?.items ?? []).map((r) => (
              <tr key={r.orderId}>
                <td className="px-3 py-2 font-mono text-xs"><Link href={`/head/agents/orders/${r.orderId}`} className="text-zinc-100 hover:underline">#{r.orderId}</Link></td>
                <td className="px-3 py-2 text-zinc-300">{r.storeName ?? "—"} · {r.labName ?? "no lab"}</td>
                <td className="px-3 py-2 text-zinc-300">{when(r.slot)}</td>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.riskLevel === "HIGH" ? "bg-red-500/15 text-red-300" : "bg-amber-500/15 text-amber-300"}`}>{r.riskLevel.toLowerCase()}</span></td>
                <td className="px-3 py-2 text-xs text-zinc-400">{r.reasons.join(", ")}</td>
                <td className="px-3 py-2 text-xs text-zinc-400">{r.did.join(" · ") || "—"}</td>
              </tr>
            ))}
            {risk && risk.items.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-sm text-zinc-500">Nothing at risk {day}.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
