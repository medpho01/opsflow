"use client";

/**
 * Connecting WhatsApp groups to labs and stores — shared by the Connections
 * page tabs (and anywhere else a group is connected). The work itself is one
 * call: POST /api/whatsapp/groups/:id/connect (lib/wa/connect.ts).
 */
import { useEffect, useState } from "react";

export type Group = { id: string; jid: string; subject: string; role: string; storeId: number | null; labId: number | null; active: boolean; autoAskIdOnMissing: boolean; isMember: boolean };

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} className={`relative w-9 h-5 rounded-full transition-colors ${on ? "bg-blue-600" : "bg-zinc-700"}`}>
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${on ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );
}

export const isConnected = (g: Group) =>
  (g.role === "PROVIDER" && g.labId != null) || (g.role === "SUPPORT" && g.storeId != null) || g.role === "INTERNAL";

export function ConnectionLabel({ group }: { group: Group }) {
  if (group.role === "PROVIDER" && group.labId != null) return <span className="text-xs text-emerald-300">Lab #{group.labId}</span>;
  if (group.role === "SUPPORT" && group.storeId != null) return <span className="text-xs text-sky-300">Store #{group.storeId}</span>;
  if (group.role === "INTERNAL") return <span className="text-xs text-zinc-300">Internal</span>;
  if (group.role === "IGNORE") return <span className="text-xs text-zinc-600">Ignored</span>;
  return <span className="text-xs text-amber-400">Not connected</span>;
}

export type ConnectOption = { id: number; name: string; detail: string | null; score: number };
export type Kind = "LAB" | "STORE" | "INTERNAL" | "NONE";

/** Connect one group to a lab, a store, internal, or ignore it — everything set in one go (lib/wa/connect.ts). */
export function ConnectDialog({ group, onClose, onDone }: { group: Group; onClose: () => void; onDone: (message: string) => void }) {
  // Connected: start on what it is. Not yet: on whichever (lab or store) matches its name best.
  const [kind, setKind] = useState<Kind>(
    !isConnected(group) ? (group.role === "IGNORE" ? "NONE" : "LAB")
      : group.role === "SUPPORT" ? "STORE" : group.role === "INTERNAL" ? "INTERNAL" : "LAB");
  const [kindChosen, setKindChosen] = useState(isConnected(group));
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<{ labs: ConnectOption[]; stores: ConnectOption[] } | null>(null);
  const [picked, setPicked] = useState<number | null>(group.role === "SUPPORT" ? group.storeId : group.labId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      fetch(`/api/whatsapp/groups/${group.id}/connect?q=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? r.json() : { labs: [], stores: [] }))
        .then((d) => {
          if (cancelled) return;
          setOptions({ labs: d.labs ?? [], stores: d.stores ?? [] });
          let effective = kind;
          if (!kindChosen && !q && kind !== "NONE") {
            effective = (d.stores?.[0]?.score ?? 0) > (d.labs?.[0]?.score ?? 0) ? "STORE" : "LAB";
            setKind(effective);
            setKindChosen(true);
          }
          // Nothing picked yet: preselect the best name match.
          setPicked((current) => current ?? (effective === "STORE" ? d.stores?.[0]?.id : d.labs?.[0]?.id) ?? null);
        })
        .catch(() => { if (!cancelled) setOptions({ labs: [], stores: [] }); });
    }, q ? 300 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [group.id, q, kind, kindChosen]);

  const list = kind === "LAB" ? options?.labs : kind === "STORE" ? options?.stores : [];
  async function confirm() {
    setBusy(true); setError(null);
    const body = kind === "LAB" || kind === "STORE" ? { kind, id: picked } : { kind };
    const r = await fetch(`/api/whatsapp/groups/${group.id}/connect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setError(d.error || "Could not connect");
    onDone(kind === "LAB" ? "Connected to the lab — messages and reading are on" : kind === "STORE" ? "Connected to the store — the console reads it" : kind === "INTERNAL" ? "Marked internal" : "Ignored");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-100 truncate">Connect “{group.subject}”</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">✕</button>
        </div>
        <div className="grid grid-cols-4 gap-1 rounded-lg border border-zinc-700 p-1 text-xs">
          {(["LAB", "STORE", "INTERNAL", "NONE"] as Kind[]).map((k) => (
            <button key={k} onClick={() => { setKind(k); setKindChosen(true); setPicked(null); }}
              className={`rounded-md px-2 py-1.5 font-medium ${kind === k ? "bg-blue-600 text-white" : "text-zinc-400 hover:text-zinc-200"}`}>
              {k === "LAB" ? "Lab" : k === "STORE" ? "Store" : k === "INTERNAL" ? "Internal" : "Ignore"}
            </button>
          ))}
        </div>
        {(kind === "LAB" || kind === "STORE") ? (
          <>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${kind === "LAB" ? "labs" : "stores"} by name or id`}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500" />
            <div className="max-h-60 overflow-y-auto rounded-lg border border-zinc-800 divide-y divide-zinc-800/60">
              {!options ? <div className="p-3 text-xs text-zinc-500">Looking for matches…</div>
                : list && list.length ? list.map((o, i) => (
                  <label key={o.id} className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-200 cursor-pointer hover:bg-zinc-800/60">
                    <input type="radio" name="connect-target" checked={picked === o.id} onChange={() => setPicked(o.id)} className="accent-blue-500" />
                    <span className="truncate">{o.name}</span>
                    {!q && i === 0 && <span className="text-[10px] text-emerald-400">best match</span>}
                    <span className="ml-auto text-[11px] text-zinc-500">{o.detail ? `${o.detail} · ` : ""}#{o.id}</span>
                  </label>
                )) : <div className="p-3 text-xs text-zinc-500">{q ? "Nothing matches — try the id." : "No close match by name — search above."}</div>}
            </div>
            <p className="text-[11px] text-zinc-500">
              {kind === "LAB" ? "The console reads this group, and the lab gets the standard messages (Message Rules) — nothing else to set. Add the lab manager’s number under Connections → Labs if you have it."
                : "The console reads this group and links its questions to the store."}
            </p>
          </>
        ) : (
          <p className="text-[11px] text-zinc-500">{kind === "INTERNAL" ? "LabStack's own team group: the console reads it." : "Not read, not messaged."}</p>
        )}
        {error && <div className="rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200">Cancel</button>
          <button onClick={() => void confirm()} disabled={busy || ((kind === "LAB" || kind === "STORE") && !picked)}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50">{busy ? "Connecting…" : "Connect"}</button>
        </div>
      </div>
    </div>
  );
}
