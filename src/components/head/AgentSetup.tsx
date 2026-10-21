"use client";

/** Agents › Setup: the eight steps from zero to the first live desk (DESIGN.md §3). */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Step = { n: number; key: string; name: string; status: string; detail: Record<string, unknown> };
type Suite = { suite: string; gate: number; cases: number; last: { score: number; passedGate: boolean; ranAt: string; cases: number } | null };

const STATUS: Record<string, { text: string; cls: string }> = {
  done: { text: "Done", cls: "bg-emerald-500/15 text-emerald-300" }, in_progress: { text: "In progress", cls: "bg-amber-500/15 text-amber-300" }, needs_approval: { text: "Needs your approval", cls: "bg-blue-500/15 text-blue-200" },
  not_started: { text: "Not started", cls: "bg-zinc-800 text-zinc-400" }, failing: { text: "Failing", cls: "bg-red-500/15 text-red-300" }, defaults: { text: "Defaults", cls: "bg-zinc-800 text-zinc-300" }, locked: { text: "Locked", cls: "bg-zinc-800 text-zinc-500" },
};

export function AgentSetup() {
  const [steps, setSteps] = useState<Step[]>([]);
  const [pilot, setPilot] = useState<{ labs: string[]; stores: string[] }>({ labs: [], stores: [] });
  const [suites, setSuites] = useState<Suite[]>([]);
  const [sel, setSel] = useState(1);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [s, e] = await Promise.all([fetch("/api/agents/setup"), fetch("/api/agents/evals")]);
    const [sb, eb] = await Promise.all([s.json(), e.json()]);
    if (s.ok) { setSteps(sb.steps); setPilot(sb.pilot); }
    if (e.ok) setSuites(eb.suites);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const post = async (url: string, body: unknown, ok: string) => {
    setBusy(true); setNote(null);
    try { const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const b = await r.json().catch(() => ({})); setNote(r.ok ? ok : b.error ?? "Failed"); await load(); }
    finally { setBusy(false); }
  };
  const step = steps.find((s) => s.n === sel);
  const done = steps.filter((s) => s.status === "done").length;
  const d = (step?.detail ?? {}) as Record<string, unknown>;

  return (
    <div>
      <div className="mb-4 mt-2 flex flex-wrap items-end justify-between gap-3">
        <div><div className="text-xs text-zinc-500">OpsFlow Agents · SOP owners</div><h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Set up OpsFlow Agents</h1><div className="mt-1 text-sm text-zinc-400">Eight steps. Nothing is sent to a lab or store until step 8. Pilot: {pilot.labs.join(", ") || "—"} · {pilot.stores.join(", ") || "—"}.</div></div>
        <div className="min-w-[200px]"><div className="text-xs font-semibold text-zinc-300">{done} of 8 done</div><div className="mt-1 h-2 rounded-full bg-zinc-800"><div className="h-2 rounded-full bg-blue-500" style={{ width: `${(done / 8) * 100}%` }} /></div></div>
      </div>
      {note && <div className="mb-3 rounded-md border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-200">{note}</div>}
      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <ol className="space-y-1 rounded-lg border border-zinc-800 p-2">
          {steps.map((s) => { const st = STATUS[s.status] ?? STATUS.not_started; return (
            <li key={s.n}><button onClick={() => setSel(s.n)} className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left ${sel === s.n ? "bg-zinc-800" : "hover:bg-zinc-900"}`}><span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${s.status === "done" ? "bg-emerald-600 text-white" : "bg-zinc-700 text-zinc-200"}`}>{s.status === "done" ? "✓" : s.n}</span><span className="flex-1"><span className="block text-sm font-medium text-zinc-100">{s.name}</span><span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[11px] ${st.cls}`}>{st.text}</span></span></button></li>
          ); })}
        </ol>
        {step && (
          <section className="rounded-lg border border-zinc-800 p-4 text-sm">
            <h2 className="text-lg font-semibold text-zinc-100">Step {step.n} · {step.name}</h2>
            {step.key === "connections" && <div className="mt-3 space-y-1 text-zinc-300">
              <Row k="LabStack replica" v={String(d.replica)} />
              <Row k="WhatsApp gateway" v={`${String(d.gateway)}${d.gatewayNumber ? ` · ${String(d.gatewayNumber)}` : ""}`} />
              <Row k="Console write API" v={String(d.consoleApi)} />
              <Row k="Lab portals" v={((d.portals as Array<{ labId: number; status: string }>) ?? []).map((p) => `${p.labId}: ${p.status.toLowerCase()}`).join(", ") || "none set"} />
              <Row k="Model key" v={d.modelKey ? "set" : "not set — readers use patterns, the case worker and the Brain's prose are off"} />
              <Row k="Exotel" v={d.exotel ? "configured" : "not configured — the call rung becomes a task"} />
            </div>}
            {step.key === "directory" && <div className="mt-3 space-y-3">
              <table className="w-full text-xs"><thead className="text-left text-zinc-500"><tr><th>Lab</th><th>Tier</th><th>Group</th><th>Manager</th></tr></thead><tbody>{((d.labs as Array<{ labName: string; tier: string; group: boolean; manager: boolean }>) ?? []).map((l) => <tr key={l.labName} className="text-zinc-300"><td className="py-1">{l.labName}</td><td>{l.tier}</td><td>{l.group ? "linked" : <span className="text-amber-300">missing</span>}</td><td>{l.manager ? "on file" : <span className="text-amber-300">missing</span>}</td></tr>)}</tbody></table>
              <table className="w-full text-xs"><thead className="text-left text-zinc-500"><tr><th>Store</th><th>Group</th><th>Weight</th></tr></thead><tbody>{((d.stores as Array<{ storeName: string; group: boolean; weight: number }>) ?? []).map((s) => <tr key={s.storeName} className="text-zinc-300"><td className="py-1">{s.storeName}</td><td>{s.group ? "linked" : "missing"}</td><td>{s.weight}</td></tr>)}</tbody></table>
              <div className="text-xs text-zinc-500">Labs, groups and coordinators come from Connections; managers from Lab Config.</div>
            </div>}
            {step.key === "sla" && <div className="mt-3 space-y-1 text-zinc-300">{((d.offsets as Array<{ labName: string; phleboBeforeSlotMin?: number }>) ?? []).map((o) => <Row key={o.labName} k={String(o.labName)} v={`phlebo at slot − ${o.phleboBeforeSlotMin} min`} />)}<div className="text-xs text-zinc-500">{String(d.note)}</div></div>}
            {step.key === "sops" && <div className="mt-3 space-y-2">{((d.sops as Array<{ desk: string; version: number | null; author: string | null; approvedBy: number | null }>) ?? []).map((s) => <Row key={s.desk} k={`${s.desk} desk`} v={s.version ? `v${s.version} · ${s.author?.toLowerCase()} · ${s.approvedBy ? "approved" : "baseline, not yet reviewed"}` : "missing"} />)}<Link href="/head/agents/sops" className="inline-block rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900">Open the SOP library</Link></div>}
            {step.key === "evals" && <div className="mt-3 space-y-2">
              <table className="w-full text-xs"><thead className="text-left text-zinc-500"><tr><th>Suite</th><th>Cases</th><th>Gate</th><th>Last score</th></tr></thead><tbody>{suites.map((s) => <tr key={s.suite} className="text-zinc-300"><td className="py-1">{s.suite.replace(/_/g, " ")}</td><td>{s.cases}</td><td>{Math.round(s.gate * 100)}%</td><td>{s.last ? <span className={s.last.passedGate ? "text-emerald-300" : "text-red-300"}>{Math.round(s.last.score * 100)}% · {s.last.passedGate ? "pass" : "fail"}</span> : "not run"}</td></tr>)}</tbody></table>
              <div className="flex gap-2"><button disabled={busy} onClick={() => post("/api/agents/evals", { action: "seed" }, "Seeded cases from history")} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200">Seed from history</button><button disabled={busy} onClick={() => post("/api/agents/evals", { action: "run" }, "All suites ran")} className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900">Run all suites</button></div>
              <div className="text-xs text-zinc-500">Every inbox correction and every audit disagreement adds a case.</div>
            </div>}
            {step.key === "shadow" && <div className="mt-3 space-y-2 text-zinc-300"><div>{String(d.cells)} of {String(d.needed)} pilot desk cells in shadow or live.</div><button disabled={busy} onClick={() => post("/api/agents/setup", { action: "pilot_shadow" }, "The pilot's desks are in shadow")} className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900">Put the pilot in shadow</button> <Link href="/head/agents/desks" className="ml-2 text-xs text-zinc-400 underline">Desks and autonomy</Link></div>}
            {step.key === "autonomy" && <div className="mt-3 text-zinc-300">{String(d.note)} <Link href="/head/agents/desks" className="text-xs text-zinc-400 underline">Change it</Link></div>}
            {step.key === "live" && <div className="mt-3 space-y-2 text-zinc-300">
              <ul className="space-y-1 text-sm"><li>☐ Shadow has run at least 7 days for the lab or store</li><li>☐ Every action set to act is at its agreement gate</li><li>☐ The team knows which asks the agent now owns in that group</li><li>☐ Kill-switch drill done: pause, confirm nothing sends, resume</li><li>☑ Rollback armed: back to shadow if team messages per order have not fallen in 14 days</li></ul>
              <div className="text-xs text-zinc-500">Live now: {((d.live as Array<{ desk: string; scopeKind: string; scopeId: number }>) ?? []).map((l) => `${l.desk} ${l.scopeKind.toLowerCase()} ${l.scopeId}`).join(", ") || "none"}. Switch a cell to live on <Link href="/head/agents/desks" className="underline">Desks and autonomy</Link>.</div>
            </div>}
          </section>
        )}
      </div>
    </div>
  );
}
function Row({ k, v }: { k: string; v: string }) { return <div className="flex justify-between gap-4 border-b border-zinc-800/60 py-1"><span className="text-zinc-500">{k}</span><span className="text-right text-zinc-200">{v}</span></div>; }
