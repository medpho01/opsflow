"use client";

/**
 * Every LabStack store and its WhatsApp group — busiest first (orders in the
 * last 30 days). Connect picks the group (best name match preselected); "Ask
 * ID" lets the console auto-ask the store for an order id when a message has none.
 */
import { useCallback, useEffect, useState } from "react";
import { PickGroupDialog } from "./PickGroupDialog";
import { Toggle } from "./shared";

type StoreRow = {
  id: number; name: string; city: string | null; active: boolean; orders30d: number; summaries: boolean;
  group: { id: string; subject: string; autoAskIdOnMissing: boolean } | null;
  suggested: { id: string; subject: string } | null;
};

export function StoresTab() {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"ALL" | "CONNECTED" | "NOT_CONNECTED">("ALL");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ stores: StoreRow[]; total: number; pageCount: number; connected: number } | null>(null);
  const [picking, setPicking] = useState<StoreRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2600); };

  const load = useCallback(async () => {
    const params = new URLSearchParams({ q, filter, page: String(page) });
    const r = await fetch(`/api/connections/stores?${params}`);
    if (r.ok) setData(await r.json());
  }, [q, filter, page]);
  useEffect(() => { const t = setTimeout(() => void load(), q ? 300 : 0); return () => clearTimeout(t); }, [load, q]);

  async function setSummaries(store: StoreRow, value: boolean) {
    const r = await fetch("/api/connections/stores", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storeId: store.id, summaries: value }) });
    flash(r.ok ? (value ? `${store.name}: summaries at 9:00, 12:00 and 4:00 pm` : `${store.name}: summaries off`) : "Could not save");
    void load();
  }

  async function setAskId(store: StoreRow, value: boolean) {
    if (!store.group) return;
    await fetch(`/api/whatsapp/groups/${store.group.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoAskIdOnMissing: value }) });
    void load();
  }

  return (
    <div>
      {picking && (
        <PickGroupDialog
          target={{ kind: "STORE", id: picking.id, name: picking.name }}
          suggestedId={picking.suggested?.id ?? null}
          onClose={() => setPicking(null)}
          onDone={(m) => { setPicking(null); flash(m); void load(); }}
        />
      )}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search by name, city or store ID"
          className="w-72 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500" />
        <select value={filter} onChange={(e) => { setFilter(e.target.value as typeof filter); setPage(1); }}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200">
          <option value="ALL">All stores</option>
          <option value="NOT_CONNECTED">No group yet</option>
          <option value="CONNECTED">Connected</option>
        </select>
        {data && <span className="ml-auto text-xs text-zinc-500">{data.connected} connected · {data.total} shown</span>}
      </div>
      <div className="rounded-xl border border-zinc-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-950/70"><tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500 border-b border-zinc-800">
            <th className="px-4 py-2.5">Store</th>
            <th className="px-3 py-2.5">Orders · 30d</th>
            <th className="px-3 py-2.5">WhatsApp group</th>
            <th className="px-3 py-2.5 text-center">Ask ID</th>
            <th className="px-3 py-2.5 text-center" title="Today's visits, with RNR, samples owed and visits passed first — 9:00, 12:00, 4:00 pm. Independent of the agent.">Summaries</th>
          </tr></thead>
          <tbody>
            {!data ? <tr><td colSpan={5} className="p-8 text-center text-sm text-zinc-500">Loading stores from LabStack…</td></tr>
              : data.stores.length === 0 ? <tr><td colSpan={5} className="p-8 text-center text-sm text-zinc-500">No stores match.</td></tr>
              : data.stores.map((s) => (
                <tr key={s.id} className="border-b border-zinc-800/60 hover:bg-zinc-900/40">
                  <td className="px-4 py-3">
                    <div className="font-medium text-zinc-100">{s.name}</div>
                    <div className="font-mono text-[11px] text-zinc-500">Store #{s.id}{s.city ? ` · ${s.city}` : ""}{!s.active && " · inactive"}</div>
                  </td>
                  <td className="px-3 py-3 tabular-nums text-zinc-300">{s.orders30d.toLocaleString("en-IN")}</td>
                  <td className="px-3 py-3 max-w-[22rem]">
                    <div className="flex items-center gap-2">
                      {s.group ? <span className="truncate text-xs text-sky-300">{s.group.subject}</span>
                        : s.suggested ? <span className="truncate text-[11px] text-zinc-500">Suggested: {s.suggested.subject}</span>
                        : <span className="text-xs text-zinc-600">—</span>}
                      <button onClick={() => setPicking(s)} className="ml-auto shrink-0 text-xs font-medium text-blue-400 hover:text-blue-300">{s.group ? "Change" : "Connect"}</button>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-center">{s.group ? <Toggle on={s.group.autoAskIdOnMissing} onChange={(v) => void setAskId(s, v)} /> : <span className="text-zinc-600 text-xs">—</span>}</td>
                  <td className="px-3 py-3 text-center">{s.group ? <Toggle on={s.summaries} onChange={(v) => void setSummaries(s, v)} /> : <span className="text-zinc-600 text-xs">—</span>}</td>
                </tr>
              ))}
          </tbody>
        </table>
        {data && data.pageCount > 1 && (
          <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-4 py-2 text-xs text-zinc-400">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border border-zinc-700 px-2 py-1 disabled:opacity-40">‹ Prev</button>
            <span>Page {page} of {data.pageCount}</span>
            <button disabled={page >= data.pageCount} onClick={() => setPage((p) => p + 1)} className="rounded border border-zinc-700 px-2 py-1 disabled:opacity-40">Next ›</button>
          </div>
        )}
      </div>
      {toast && <div className="fixed bottom-6 right-6 z-50 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-100 shadow-lg">{toast}</div>}
    </div>
  );
}
