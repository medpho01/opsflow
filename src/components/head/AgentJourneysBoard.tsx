"use client";

/**
 * Agents › Journeys: every open order the agent owns, worst first. Phase 0
 * shows what the agent sees and would do (shadow); the inbox, store feed and
 * lab board come in Phase 1.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Journey = {
  id: string; orderId: number; orderType: string; labId: number | null; storeId: number | null; stage: string; subStates: string[];
  waitingFor: { what: string; from: string } | null; dueAt: string | null; nextCheckAt: string | null; health: string; riskLevel: string;
  owner: { userId: number; until: string } | null; patientName: string | null; labName: string | null; storeName: string | null;
  appointmentTime: string | null; openedAt: string; closedAt: string | null; closeReason: string | null;
};
type Data = { journeys: Journey[]; counts: Record<string, number>; actions24h: Record<string, number>; timeZone: string };

const HEALTH: Record<string, { text: string; cls: string }> = {
  BREACHED: { text: "Breached", cls: "bg-red-500/15 text-red-300" },
  AT_RISK: { text: "At risk", cls: "bg-amber-500/15 text-amber-300" },
  ON_TRACK: { text: "On track", cls: "bg-emerald-500/15 text-emerald-300" },
};
const LABEL: Record<string, string> = {
  confirmed: "lab to confirm", phlebo_assigned: "phlebo", phlebo_reached: "phlebo to reach", sample_collected: "collection",
  sample_at_lab: "sample at lab", report_delivered: "report", visit_confirmed: "visit confirmed", patient_visited: "patient visit",
  kit_dispatched: "kit dispatch", kit_delivered: "kit delivery", kit_picked_up: "kit pickup", samples_received: "samples at lab",
};

export function AgentJourneysBoard() {
  const [data, setData] = useState<Data | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/agents/journeys${filter ? `?health=${filter}` : ""}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setError(body.error ?? "Could not load journeys"); return; }
      setData(body); setError(null);
    } catch { setError("Could not load journeys"); }
  }, [filter]);

  useEffect(() => { void load(); const t = window.setInterval(load, 30_000); return () => window.clearInterval(t); }, [load]);

  const tz = data?.timeZone ?? "Asia/Kolkata";
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" }) : "—");
  const minutes = (iso: string | null) => (iso ? Math.round((Date.parse(iso) - Date.now()) / 60_000) : null);
  const total = Object.values(data?.counts ?? {}).reduce((a, b) => a + b, 0);
  const actions = data?.actions24h ?? {};

  return (
    <div>
      <div className="mb-5 mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs text-zinc-500">OpsFlow Agents · Phase 0 · shadow</div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Journeys</h1>
          <div className="mt-1 text-sm text-zinc-400">One per open order in the active window. The agent watches checkpoints and records what it would do; nothing is sent.</div>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {[["", `All · ${total}`], ["BREACHED", `Breached · ${data?.counts.BREACHED ?? 0}`], ["AT_RISK", `At risk · ${data?.counts.AT_RISK ?? 0}`], ["ON_TRACK", `On track · ${data?.counts.ON_TRACK ?? 0}`]].map(([k, label]) => (
            <button key={k} onClick={() => setFilter(k)} className={`rounded-full border px-3 py-1.5 ${filter === k ? "border-zinc-200 bg-zinc-200 text-zinc-900" : "border-zinc-700 text-zinc-300 hover:border-zinc-500"}`}>{label}</button>
          ))}
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Would have acted (24 h)" value={actions.RECORDED ?? 0} hint="recorded in shadow" />
        <Stat label="Needs a person (24 h)" value={actions.REVIEW ?? 0} hint="review items" />
        <Stat label="Blocked (24 h)" value={actions.BLOCKED ?? 0} hint="desk off, kill switch, duplicate" />
        <Stat label="Open journeys" value={total} hint="in the active window" />
      </div>

      {error && <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm text-red-300">{error} <button onClick={load} className="underline">Try again</button></div>}
      {!data && !error && <div className="p-10 text-center text-sm text-zinc-500">Loading journeys…</div>}
      {data && data.journeys.length === 0 && <div className="rounded-lg border border-zinc-800 p-10 text-center text-sm text-zinc-500">No journeys yet. Start the worker (<code>npm run worker</code>) and the first sweep opens one per open order.</div>}

      {data && data.journeys.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-left text-[11px] uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2">Order</th><th className="px-3 py-2">Store · lab</th><th className="px-3 py-2">Slot</th><th className="px-3 py-2">Console</th>
                <th className="px-3 py-2">Waiting for</th><th className="px-3 py-2">Due</th><th className="px-3 py-2">Health</th><th className="px-3 py-2">Owner</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/80">
              {data.journeys.map((j) => {
                const h = HEALTH[j.health] ?? HEALTH.ON_TRACK;
                const m = minutes(j.dueAt);
                return (
                  <tr key={j.id} className="hover:bg-zinc-900/40">
                    <td className="px-3 py-2 font-mono text-xs"><Link href={`/head/agents/orders/${j.orderId}`} className="text-zinc-100 hover:underline">#{j.orderId}</Link><div className="text-zinc-500">{j.patientName ?? "—"}</div></td>
                    <td className="px-3 py-2 text-zinc-300">{j.storeName ?? "—"}<div className="text-xs text-zinc-500">{j.labName ?? "no lab"}</div></td>
                    <td className="px-3 py-2 text-zinc-300">{when(j.appointmentTime)}</td>
                    <td className="px-3 py-2 font-mono text-xs text-zinc-400">{j.stage}{j.subStates.length ? <div className="text-amber-400">{j.subStates.join(", ")}</div> : null}</td>
                    <td className="px-3 py-2 text-zinc-300">{j.waitingFor ? <>{LABEL[j.waitingFor.what] ?? j.waitingFor.what} <span className="text-zinc-500">· {j.waitingFor.from.toLowerCase()}</span></> : "—"}</td>
                    <td className="px-3 py-2 text-zinc-300">{when(j.dueAt)}{m != null && <div className={`text-xs ${m < 0 ? "text-red-400" : "text-zinc-500"}`}>{m < 0 ? `${-m} min ago` : `in ${m} min`}</div>}</td>
                    <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${h.cls}`}>{h.text}</span></td>
                    <td className="px-3 py-2 text-xs text-zinc-400">{j.owner ? `person #${j.owner.userId}` : "agent"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-zinc-100">{value}</div>
      <div className="text-[11px] text-zinc-500">{hint}</div>
    </div>
  );
}
