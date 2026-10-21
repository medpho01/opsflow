"use client";

/** Agents › Desks and autonomy, with the kill switches (DESIGN.md §7.5, FR-13.1, 13.2, 13.5). */
import { useCallback, useEffect, useState } from "react";

type Cell = { desk: string; state: string; since: string | null; liveSince: string | null; shadowActions7d: number };
type Scope = { scopeKind: string; scopeId: number; name: string | null; tier: string | null; group: boolean; desks: Cell[] };
type Auto = { action: string; desk: string; label: string; defaultLevel: string; scopes: Array<{ scopeKind: string; scopeKey: string; level: string; agreementRate: number | null; sampleSize: number; canPromote: boolean }>; overrides: Array<{ scopeKind: string; scopeKey: string; level: string; agreementRate: number | null; sampleSize: number; canPromote: boolean }> };
type Settings = { pausedAll: boolean; pausedDesks: string[]; pausedLabIds: number[]; pausedStoreIds: number[] };

const STATE_CLS: Record<string, string> = { LIVE: "bg-blue-500 text-white border-blue-500", SHADOW: "bg-transparent text-blue-200 border-blue-400", OFF: "bg-zinc-800 text-zinc-400 border-zinc-700" };
const LEVEL_CLS: Record<string, string> = { ACT: "bg-blue-500 text-white", ACT_NOTIFY: "bg-blue-500/20 text-blue-200", SUGGEST: "bg-zinc-700 text-zinc-200", SHADOW: "bg-zinc-800 text-zinc-400" };
const NEXT: Record<string, string> = { OFF: "SHADOW", SHADOW: "LIVE", LIVE: "OFF" };

export function AgentDesksPanel() {
  const [labs, setLabs] = useState<Scope[]>([]);
  const [stores, setStores] = useState<Scope[]>([]);
  const [auto, setAuto] = useState<Auto[]>([]);
  const [gate, setGate] = useState({ rate: 0.98, cases: 200 });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [d, a, s] = await Promise.all([fetch("/api/agents/desks"), fetch("/api/agents/autonomy"), fetch("/api/agents/settings")]);
    const [db, ab, sb] = await Promise.all([d.json(), a.json(), s.json()]);
    if (d.ok) { setLabs(db.labs); setStores(db.stores); }
    if (a.ok) { setAuto(ab.matrix); setGate(ab.gate); }
    if (s.ok) setSettings(sb.settings);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const setDesk = async (scope: Scope, cell: Cell, force = false) => {
    const state = NEXT[cell.state];
    const r = await fetch("/api/agents/desks", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ desk: cell.desk, scopeKind: scope.scopeKind, scopeId: scope.scopeId, state, force }) });
    const b = await r.json().catch(() => ({}));
    if (r.status === 409 && !force && window.confirm(`${b.error}\n\nGo live anyway?`)) return setDesk(scope, cell, true);
    setNote(r.ok ? `${scope.name}: ${cell.desk} desk → ${state}` : b.error ?? "Failed");
    await load();
  };
  const change = async (a: Auto, scopeKind: string, scopeKey: string, direction: "promote" | "demote", force = false) => {
    const r = await fetch("/api/agents/autonomy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: a.action, desk: a.desk, scopeKind, scopeKey, direction, force }) });
    const b = await r.json().catch(() => ({}));
    if (r.status === 409 && !force && window.confirm(`${b.error}\n\nPromote anyway?`)) return change(a, scopeKind, scopeKey, direction, true);
    setNote(r.ok ? `${a.label}: ${direction}d for ${scopeKind} ${scopeKey}` : b.error ?? "Failed");
    await load();
  };
  const kill = async (patch: Partial<Settings>) => {
    const r = await fetch("/api/agents/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    setNote(r.ok ? "Saved" : "Failed");
    await load();
  };

  const Row = ({ s }: { s: Scope }) => (
    <tr className="hover:bg-zinc-900/40">
      <td className="px-3 py-2"><span className="font-medium text-zinc-100">{s.name}</span> <span className="text-xs text-zinc-500">{s.tier ? `· tier ${s.tier}` : ""}{!s.group ? " · no group" : ""}</span></td>
      {s.desks.map((c) => (
        <td key={c.desk} className="px-3 py-2">
          <button onClick={() => setDesk(s, c)} className={`rounded-full border px-3 py-1 text-xs font-semibold ${STATE_CLS[c.state]}`}>{c.state}</button>
          <div className="mt-0.5 text-[11px] text-zinc-500">{c.state === "SHADOW" ? `${c.shadowActions7d} would-do actions · 7 d` : c.state === "LIVE" && c.liveSince ? `live since ${new Date(c.liveSince).toLocaleDateString("en-IN")}` : ""}</div>
        </td>
      ))}
    </tr>
  );

  return (
    <div>
      <div className="mb-4 mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs text-zinc-500">OpsFlow Agents · SOP owners</div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Desks and autonomy</h1>
          <div className="mt-1 text-sm text-zinc-400">Off, Shadow (records what it would do, sends nothing) or Live, per lab or store. Click a cell to change it.</div>
        </div>
        {settings && (
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => kill({ pausedAll: !settings.pausedAll })} className={`rounded-md px-3 py-1.5 text-sm font-semibold ${settings.pausedAll ? "border border-zinc-600 text-zinc-100" : "bg-red-600 text-white hover:bg-red-500"}`}>{settings.pausedAll ? "Resume everything" : "Pause everything"}</button>
            {["LAB", "STORE", "INTAKE"].map((d) => <button key={d} onClick={() => kill({ pausedDesks: settings.pausedDesks.includes(d) ? settings.pausedDesks.filter((x) => x !== d) : [...settings.pausedDesks, d] })} className={`rounded-md border px-2.5 py-1.5 text-xs ${settings.pausedDesks.includes(d) ? "border-red-500 text-red-300" : "border-zinc-700 text-zinc-300"}`}>{settings.pausedDesks.includes(d) ? `Resume ${d}` : `Pause ${d}`}</button>)}
          </div>
        )}
      </div>
      {settings?.pausedAll && <div role="status" className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-200">Everything is paused. No messages, status writes, calls or tasks go out. Journeys keep tracking.</div>}
      {note && <div className="mb-3 rounded-md border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-200">{note}</div>}

      <section className="mb-5 overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900/60 text-left text-[11px] uppercase tracking-wide text-zinc-500"><tr><th className="px-3 py-2">Lab</th><th className="px-3 py-2">Lab desk</th><th className="px-3 py-2">Intake desk</th></tr></thead>
          <tbody className="divide-y divide-zinc-800/80">{labs.map((s) => <Row key={`${s.scopeKind}-${s.scopeId}`} s={s} />)}</tbody>
        </table>
        <table className="w-full border-t border-zinc-800 text-sm">
          <thead className="bg-zinc-900/60 text-left text-[11px] uppercase tracking-wide text-zinc-500"><tr><th className="px-3 py-2">Store</th><th className="px-3 py-2">Store desk</th></tr></thead>
          <tbody className="divide-y divide-zinc-800/80">{stores.map((s) => <Row key={`${s.scopeKind}-${s.scopeId}`} s={s} />)}</tbody>
        </table>
        <div className="px-3 py-2 text-xs text-zinc-500">Going live needs 7 days in shadow. Live arms the 14-day rollback gate. A lab with a live Lab desk leaves the old message rules in the same pass.</div>
      </section>

      <section className="overflow-x-auto rounded-lg border border-zinc-800">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2"><h2 className="text-base font-semibold text-zinc-100">Autonomy by action and lab tier</h2><span className="text-xs text-zinc-500">Promote at {Math.round(gate.rate * 100)}% agreement over {gate.cases} cases · a lab or store may be demoted on its own</span></div>
        <table className="w-full text-sm">
          <thead className="bg-zinc-900/60 text-left text-[11px] uppercase tracking-wide text-zinc-500"><tr><th className="px-3 py-2">Action</th><th className="px-3 py-2">Tier A (API)</th><th className="px-3 py-2">Tier B (portal)</th><th className="px-3 py-2">Tier C (manual)</th><th className="px-3 py-2">Overrides</th></tr></thead>
          <tbody className="divide-y divide-zinc-800/80">
            {auto.map((a) => (
              <tr key={`${a.desk}-${a.action}`}>
                <td className="px-3 py-2 text-zinc-200">{a.label}<div className="text-[11px] text-zinc-500">{a.desk.toLowerCase()} desk · default {a.defaultLevel.replace("_", " ").toLowerCase()}</div></td>
                {a.scopes.map((s) => (
                  <td key={s.scopeKey} className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${LEVEL_CLS[s.level]}`}>{s.level.replace("_", " ")}</span>
                    <div className="mt-0.5 text-[11px] text-zinc-500">{s.sampleSize ? `${Math.round((s.agreementRate ?? 0) * 100)}% · ${s.sampleSize}` : "no cases"}</div>
                    <div className="mt-1 flex gap-1">
                      <button onClick={() => change(a, "TIER", s.scopeKey, "promote")} className={`rounded px-1.5 py-0.5 text-[11px] ${s.canPromote ? "bg-blue-500 text-white" : "border border-zinc-700 text-zinc-500"}`}>↑</button>
                      <button onClick={() => change(a, "TIER", s.scopeKey, "demote")} className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300">↓</button>
                    </div>
                  </td>
                ))}
                <td className="px-3 py-2 text-xs text-zinc-400">{a.overrides.length ? a.overrides.map((o) => `${o.scopeKind.toLowerCase()} ${o.scopeKey}: ${o.level.replace("_", " ").toLowerCase()}`).join(", ") : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
