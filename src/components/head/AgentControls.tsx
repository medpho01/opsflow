"use client";

/** Agents › Controls: kill switches, worker health, WhatsApp number, lab portal sessions with write-only logins, cost (DESIGN.md §7.5, FR-13.5, 13.6, FR-17). */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Settings = { settings: { pausedAll: boolean; pausedDesks: string[]; pausedLabIds: number[]; pausedStoreIds: number[] }; worker: { lastActivityAt: string | null; alive: boolean }; outbox: { queued: number; failed24h: number }; gateway: { status: string; connectedNumber: string | null; lastSeenAt: string | null; dryRun: boolean | null } | null; cost24h: { paise: number; modelCalls: number } };
type PortalLab = { labId: number; labName: string; tier: string; status: string; lastOkAt: string | null; lastError: string | null; readsToday: number; reads24h: number; loginSetAt: string | null; adapter: string | null };

export function AgentControls() {
  const [s, setS] = useState<Settings | null>(null);
  const [portals, setPortals] = useState<{ labs: PortalLab[]; presets: Array<{ key: string; name: string }>; canStore: boolean } | null>(null);
  const [form, setForm] = useState<{ labId: number; username: string; password: string; adapter: string; loginUrl: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([fetch("/api/agents/settings"), fetch("/api/agents/portals")]);
    if (a.ok) setS(await a.json()); if (b.ok) setPortals(await b.json());
  }, []);
  useEffect(() => { void load(); const t = window.setInterval(load, 30_000); return () => window.clearInterval(t); }, [load]);

  const put = async (patch: Record<string, unknown>) => { const r = await fetch("/api/agents/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }); setNote(r.ok ? "Saved" : "Failed"); await load(); };
  const post = async (body: Record<string, unknown>) => { const r = await fetch("/api/agents/portals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const b = await r.json().catch(() => ({})); setNote(r.ok ? "Saved. The portal worker will sign in." : b.error ?? "Failed"); setForm(null); await load(); };
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN") : "—");

  return (
    <div>
      <div className="mb-4 mt-2"><div className="text-xs text-zinc-500">OpsFlow Agents · SOP owners</div><h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Controls</h1></div>
      {note && <div className="mb-3 rounded-md border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-200">{note}</div>}
      {s && (
        <section className="mb-4 grid gap-3 md:grid-cols-4">
          <Card title="Kill switch" value={s.settings.pausedAll ? "PAUSED" : "running"} tone={s.settings.pausedAll ? "red" : "green"}><button onClick={() => put({ pausedAll: !s.settings.pausedAll })} className={`mt-2 rounded-md px-3 py-1.5 text-xs font-semibold ${s.settings.pausedAll ? "border border-zinc-600 text-zinc-100" : "bg-red-600 text-white"}`}>{s.settings.pausedAll ? "Resume everything" : "Pause everything"}</button><div className="mt-1 text-[11px] text-zinc-500">Paused desks: {s.settings.pausedDesks.join(", ") || "none"} · <Link href="/head/agents/desks" className="underline">per desk</Link></div></Card>
          <Card title="Worker" value={s.worker.alive ? "alive" : "not seen"} tone={s.worker.alive ? "green" : "amber"}><div className="mt-1 text-[11px] text-zinc-500">last activity {when(s.worker.lastActivityAt)} · outbox {s.outbox.queued} queued · {s.outbox.failed24h} failed 24 h</div></Card>
          <Card title="WhatsApp number" value={s.gateway?.connectedNumber ?? "—"} tone={s.gateway?.status === "CONNECTED" ? "green" : "amber"}><div className="mt-1 text-[11px] text-zinc-500">{s.gateway?.status ?? "not configured"} · seen {when(s.gateway?.lastSeenAt ?? null)}{s.gateway?.dryRun ? " · DRY RUN" : ""}</div></Card>
          <Card title="Model cost · 24 h" value={`₹${(s.cost24h.paise / 100).toFixed(0)}`} tone="zinc"><div className="mt-1 text-[11px] text-zinc-500">{s.cost24h.modelCalls} calls · tracked, not capped</div></Card>
        </section>
      )}
      <section className="rounded-lg border border-zinc-800">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2"><h2 className="text-base font-semibold text-zinc-100">Lab portals</h2><span className="text-xs text-zinc-500">{portals?.canStore ? "Logins are stored encrypted; this page never shows them back." : "Vault public key not set on this server: logins cannot be stored yet."}</span></div>
        <table className="w-full text-sm">
          <thead className="bg-zinc-900/60 text-left text-[11px] uppercase tracking-wide text-zinc-500"><tr><th className="px-3 py-2">Lab</th><th className="px-3 py-2">Session</th><th className="px-3 py-2">Reads</th><th className="px-3 py-2">Login</th><th className="px-3 py-2"></th></tr></thead>
          <tbody className="divide-y divide-zinc-800/80">
            {(portals?.labs ?? []).map((l) => (
              <tr key={l.labId}>
                <td className="px-3 py-2 text-zinc-100">{l.labName} <span className="text-xs text-zinc-500">{l.tier}{l.adapter ? ` · ${l.adapter}` : ""}</span></td>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs ${l.status === "OK" ? "bg-emerald-500/15 text-emerald-300" : l.status === "NOT_SET" ? "bg-zinc-800 text-zinc-400" : "bg-amber-500/15 text-amber-300"}`}>{l.status.toLowerCase().replace("_", " ")}</span>{l.lastError && <div className="text-[11px] text-zinc-500">{l.lastError}</div>}<div className="text-[11px] text-zinc-500">ok {when(l.lastOkAt)}</div></td>
                <td className="px-3 py-2 text-xs text-zinc-300">{l.reads24h} · 24 h</td>
                <td className="px-3 py-2 text-xs text-zinc-400">{l.loginSetAt ? `set ${when(l.loginSetAt)}` : "not set"}</td>
                <td className="px-3 py-2"><div className="flex gap-2"><button onClick={() => setForm({ labId: l.labId, username: "", password: "", adapter: l.adapter ?? "generic", loginUrl: "" })} className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200">{l.loginSetAt ? "Replace login" : "Set login"}</button>{l.loginSetAt && <button onClick={() => post({ action: "signin", labId: l.labId })} className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200">Sign in now</button>}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
        {form && (
          <form onSubmit={(e) => { e.preventDefault(); void post({ action: "set_login", labId: form.labId, username: form.username, password: form.password, adapter: form.adapter, config: form.loginUrl ? { loginUrl: form.loginUrl } : {} }); }} className="m-3 grid gap-2 rounded-md border border-zinc-700 bg-zinc-900/60 p-3 md:grid-cols-5">
            <label className="text-xs text-zinc-400">Adapter<select value={form.adapter} onChange={(e) => setForm({ ...form, adapter: e.target.value })} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100">{(portals?.presets ?? []).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</select></label>
            <label className="text-xs text-zinc-400">Login URL<input value={form.loginUrl} onChange={(e) => setForm({ ...form, loginUrl: e.target.value })} placeholder="https://…" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100" /></label>
            <label className="text-xs text-zinc-400">Username<input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100" /></label>
            <label className="text-xs text-zinc-400">Password<input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100" /></label>
            <div className="flex items-end gap-2"><button className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900">Save</button><button type="button" onClick={() => setForm(null)} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200">Cancel</button></div>
          </form>
        )}
        <div className="px-3 py-2 text-[11px] text-zinc-500">OTP logins: the worker tries once; if it cannot reach the logged-in page, a "sign the portal back in" task appears in the inbox. Sessions usually last days.</div>
      </section>
    </div>
  );
}
function Card({ title, value, tone, children }: { title: string; value: string; tone: "red" | "green" | "amber" | "zinc"; children?: React.ReactNode }) {
  const cls = tone === "red" ? "text-red-300" : tone === "green" ? "text-emerald-300" : tone === "amber" ? "text-amber-300" : "text-zinc-100";
  return <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2"><div className="text-xs text-zinc-500">{title}</div><div className={`mt-0.5 text-lg font-semibold ${cls}`}>{value}</div>{children}</div>;
}
