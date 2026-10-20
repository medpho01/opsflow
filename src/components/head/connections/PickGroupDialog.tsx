"use client";

/**
 * Connect a lab or store to its WhatsApp group, from the lab's or store's side.
 * Same single step as Connect on a group (POST /api/whatsapp/groups/:id/connect).
 */
import { useEffect, useMemo, useState } from "react";
import { isConnected, type Group } from "./shared";

export function PickGroupDialog({ target, suggestedJid: suggestedJidProp, suggestedId, onClose, onDone }: {
  target: { kind: "LAB" | "STORE"; id: number; name: string };
  suggestedJid?: string | null;
  suggestedId?: string | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestedJid = suggestedJidProp ?? groups?.find((g) => g.id === suggestedId)?.jid ?? null;

  useEffect(() => {
    fetch("/api/whatsapp/groups").then((r) => (r.ok ? r.json() : { groups: [] })).then((d) => {
      const list: Group[] = (d.groups ?? []).filter((g: Group) => g.isMember);
      setGroups(list);
      setPicked(list.find((g) => g.jid === suggestedJidProp || g.id === suggestedId)?.id ?? null);
    }).catch(() => setGroups([]));
  }, [suggestedJidProp, suggestedId]);

  // Suggested first, then groups not connected yet, then the rest.
  const shown = useMemo(() => (groups ?? [])
    .filter((g) => g.subject.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(b.jid === suggestedJid) - Number(a.jid === suggestedJid) || Number(isConnected(a)) - Number(isConnected(b)) || a.subject.localeCompare(b.subject))
    .slice(0, 50), [groups, q, suggestedJid]);

  async function confirm() {
    if (!picked) return;
    setBusy(true); setError(null);
    const r = await fetch(`/api/whatsapp/groups/${picked}/connect`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: target.kind, id: target.id }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setError(d.error || "Could not connect");
    onDone(target.kind === "LAB" ? `${target.name}: group connected — messages and reading are on` : `${target.name}: group connected`);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-100 truncate">WhatsApp group for {target.name}</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">✕</button>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search groups"
          className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500" />
        <div className="max-h-64 overflow-y-auto rounded-lg border border-zinc-800 divide-y divide-zinc-800/60">
          {!groups ? <div className="p-3 text-xs text-zinc-500">Loading groups…</div>
            : shown.length === 0 ? <div className="p-3 text-xs text-zinc-500">No group matches. Is the ops number in their group yet?</div>
            : shown.map((g) => (
              <label key={g.id} className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-200 cursor-pointer hover:bg-zinc-800/60">
                <input type="radio" name="pick-group" checked={picked === g.id} onChange={() => setPicked(g.id)} className="accent-blue-500" />
                <span className="truncate">{g.subject}</span>
                {g.jid === suggestedJid && <span className="text-[10px] text-emerald-400">best match</span>}
                {isConnected(g) && <span className="ml-auto text-[10px] text-amber-400">{g.role === "PROVIDER" ? `lab #${g.labId}` : g.role === "SUPPORT" ? `store #${g.storeId}` : "internal"} — will move</span>}
              </label>
            ))}
        </div>
        <p className="text-[11px] text-zinc-500">One step: the console reads the group{target.kind === "LAB" ? ", and the lab gets the standard messages" : ""}.</p>
        {error && <div className="rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200">Cancel</button>
          <button onClick={() => void confirm()} disabled={busy || !picked} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50">{busy ? "Connecting…" : "Connect"}</button>
        </div>
      </div>
    </div>
  );
}
