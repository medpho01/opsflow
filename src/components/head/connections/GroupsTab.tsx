"use client";

/**
 * Every WhatsApp group the ops number is in, and what it is connected to — a
 * lab, a store, internal, or ignored. "Not connected yet" is the onboarding
 * inbox: each new group lands there until someone clicks Connect.
 */
import { useCallback, useEffect, useState } from "react";
import { ConnectDialog, ConnectionLabel, Toggle, isConnected, type Group } from "./shared";

export function GroupsTab({ initialShow = "ALL" }: { initialShow?: "ALL" | "UNCONNECTED" }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [q, setQ] = useState("");
  const [show, setShow] = useState<"ALL" | "PROVIDER" | "SUPPORT" | "INTERNAL" | "UNCONNECTED" | "IGNORE">(initialShow);
  const [connecting, setConnecting] = useState<Group | null>(null);
  const [showFormer, setShowFormer] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2600); };

  const load = useCallback(async () => {
    const r = await fetch("/api/whatsapp/groups"); if (r.ok) setGroups((await r.json()).groups);
  }, []);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/whatsapp/groups").then((r) => (r.ok ? r.json() : null)).then((d) => { if (!cancelled && d) setGroups(d.groups); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  async function patchGroup(id: string, patch: Partial<Group>) {
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, ...patch } : g)));
    const r = await fetch(`/api/whatsapp/groups/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    if (!r.ok) { flash("Save failed"); void load(); }
  }

  const memberGroups = groups.filter((g) => g.isMember);
  const formerCount = groups.length - memberGroups.length;
  const listeningCount = memberGroups.filter((g) => g.active).length;
  const shownGroups = groups.filter(
    (g) =>
      (showFormer || g.isMember) &&
      (show === "ALL" || (show === "UNCONNECTED" ? !isConnected(g) && g.role !== "IGNORE" : g.role === show && (show === "IGNORE" || isConnected(g)))) &&
      g.subject.toLowerCase().includes(q.toLowerCase())
  );

  return (
    <div>
      {connecting && <ConnectDialog group={connecting} onClose={() => setConnecting(null)} onDone={(message) => { setConnecting(null); flash(message); void load(); }} />}
      <div className="rounded-xl border border-zinc-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-3 flex-wrap">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">Groups</div>
          <span className="text-[11px] text-zinc-500">Listening to <b className="text-emerald-400">{listeningCount}</b> of {memberGroups.length} groups</span>
          {formerCount > 0 && (
            <label className="flex items-center gap-1.5 text-[11px] text-zinc-500 cursor-pointer select-none">
              <input id="wa-show-former" type="checkbox" checked={showFormer} onChange={(e) => setShowFormer(e.target.checked)} />
              Show {formerCount} group{formerCount === 1 ? "" : "s"} this number left
            </label>
          )}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search groups…"
            className="ml-auto w-56 bg-zinc-900 border border-zinc-700 rounded-md px-3 py-1.5 text-xs text-zinc-200 focus:border-blue-500 outline-none" />
          <select value={show} onChange={(e) => setShow(e.target.value as typeof show)}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-300 focus:border-blue-500 outline-none">
            <option value="ALL">All groups</option>
            <option value="UNCONNECTED">Not connected yet</option>
            <option value="PROVIDER">Labs</option>
            <option value="SUPPORT">Stores</option>
            <option value="INTERNAL">Internal</option>
            <option value="IGNORE">Ignored</option>
          </select>
          <span className="text-xs text-zinc-500">{shownGroups.length}/{groups.length}</span>
        </div>
        <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-zinc-950/95 backdrop-blur">
              <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500 border-b border-zinc-800">
                <th className="px-4 py-2.5 font-semibold">Group</th>
                <th className="px-3 py-2.5 font-semibold">Connected to</th>
                <th className="px-3 py-2.5 font-semibold text-center">Ask ID</th>
              </tr>
            </thead>
            <tbody>
              {shownGroups.map((g) => (
                <tr key={g.id} className="border-b border-zinc-800/60 hover:bg-zinc-900/40">
                  <td className="px-4 py-2.5 text-zinc-200 font-medium">{g.subject.replace("Labstack", "LS").replace("LABSTACK", "LS")}{!g.isMember && <span className="ml-2 text-[10px] font-normal text-amber-400">left this group</span>}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <ConnectionLabel group={g} />
                      <button onClick={() => setConnecting(g)} className="ml-auto text-xs font-medium text-blue-400 hover:text-blue-300">
                        {isConnected(g) ? "Change" : "Connect"}
                      </button>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-center"><Toggle on={g.autoAskIdOnMissing} onChange={(v) => patchGroup(g.id, { autoAskIdOnMissing: v })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {toast && <div className="fixed bottom-6 right-6 z-50 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-100 shadow-lg">{toast}</div>}
    </div>
  );
}
