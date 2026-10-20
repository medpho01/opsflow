"use client";

import { useCallback, useEffect, useState } from "react";

type Gateway = { status: string; online: boolean; connectedNumber: string | null; qrDataUrl: string | null; lastSeenAt: string | null; gatewayLive?: boolean };
type Group = { id: string; jid: string; subject: string; role: string; storeId: number | null; labId: number | null; active: boolean; sendEnabled: boolean; autoAskIdOnMissing: boolean; isMember: boolean };

export function WhatsAppSettings() {
  const [gw, setGw] = useState<Gateway | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [show, setShow] = useState<"ALL" | "PROVIDER" | "SUPPORT" | "INTERNAL" | "UNCONNECTED" | "IGNORE">("ALL");
  const [connecting, setConnecting] = useState<Group | null>(null);
  // Groups the linked number has LEFT stay in the table (their history is
  // kept) but are hidden unless asked for. A previous number's groups never
  // appear here at all — they are archived when the number changes.
  const [showFormer, setShowFormer] = useState(false);
  const [contacts, setContacts] = useState<{ id: string; name: string; phone: string | null; team: string | null }[]>([]);
  const [contactText, setContactText] = useState("");
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2200); };

  const memberGroups = groups.filter((g) => g.isMember);
  const formerCount = groups.length - memberGroups.length;
  const shownGroups = groups.filter(
    (g) =>
      (showFormer || g.isMember) &&
      (show === "ALL" || (show === "UNCONNECTED" ? !isConnected(g) && g.role !== "IGNORE" : g.role === show && (show === "IGNORE" || isConnected(g)))) &&
      g.subject.toLowerCase().includes(q.toLowerCase())
  );
  const listeningCount = memberGroups.filter((g) => g.active).length;

  const loadGw = useCallback(async () => {
    const r = await fetch("/api/whatsapp/gateway"); if (r.ok) setGw(await r.json());
  }, []);
  const loadGroups = useCallback(async () => {
    const r = await fetch("/api/whatsapp/groups"); if (r.ok) setGroups((await r.json()).groups);
  }, []);
  const loadContacts = useCallback(async () => {
    const r = await fetch("/api/whatsapp/contacts"); if (r.ok) setContacts((await r.json()).contacts);
  }, []);

  async function saveContacts() {
    if (!contactText.trim()) return flash("Paste Name, Phone lines first");
    const r = await fetch("/api/whatsapp/contacts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: contactText }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return flash(d.error || "Save failed");
    flash(`Saved ${d.total} team members`); setContactText(""); loadContacts();
  }
  async function deleteContact(id: string) {
    await fetch(`/api/whatsapp/contacts/${id}`, { method: "DELETE" }); loadContacts();
  }

  useEffect(() => { loadGw(); loadGroups(); loadContacts(); }, [loadGw, loadGroups, loadContacts]);
  useEffect(() => { const t = setInterval(loadGw, 3000); return () => clearInterval(t); }, [loadGw]); // live QR/status

  async function command(command: string) {
    await fetch("/api/whatsapp/gateway", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command }) });
    flash(command === "LOGOUT" ? "Unlinking…" : command === "BACKFILL" ? "Backfilling last 3 days — re-resolving threads & pulling media…" : "Re-linking — scan the new QR");
    loadGw();
  }

  async function patchGroup(id: string, patch: Partial<Group>) {
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, ...patch } : g)));
    const r = await fetch(`/api/whatsapp/groups/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    if (!r.ok) { flash("Save failed"); loadGroups(); }
  }

  const connected = gw?.status === "CONNECTED";
  const needsScan = gw?.status === "QR" || gw?.status === "LOGGED_OUT";

  return (
    <div className="max-w-5xl">
      <div className="mb-1 text-xs text-zinc-500"><a href="/head/whatsapp" className="hover:text-zinc-300">‹ Back to inbox</a> &nbsp;·&nbsp; Settings / Integrations / <span className="text-zinc-300 font-medium">WhatsApp</span></div>
      <h1 className="text-2xl font-semibold text-zinc-100 tracking-tight">WhatsApp integration</h1>
      <p className="text-sm text-zinc-400 mt-1 mb-5">Link the ops WhatsApp account and connect each group to its lab or store — one step does everything (reading the group, and for labs the standard messages). Admins only.</p>

      {/* Connection */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 mb-6">
        <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold mb-3">WhatsApp connection</div>
        <div className="flex items-center gap-3">
          <span className={`w-2.5 h-2.5 rounded-full ${connected ? "bg-emerald-500" : needsScan ? "bg-amber-500" : "bg-zinc-500"}`} />
          <div>
            <div className="text-sm text-zinc-100">
              {connected ? <>Connected as <span className="font-mono font-semibold">+{gw?.connectedNumber}</span></> : needsScan ? "Waiting for scan" : "Connecting…"}
            </div>
            <div className="text-xs text-zinc-500">{gw?.online ? "Linked device · online" : "Gateway offline"}{gw?.lastSeenAt ? ` · last seen ${new Date(gw.lastSeenAt).toLocaleTimeString()}` : ""}</div>
          </div>
          <div className="ml-auto flex gap-2">
            <button onClick={() => command("BACKFILL")} className="text-xs font-semibold border border-zinc-700 hover:border-emerald-500 hover:text-emerald-400 rounded-lg px-3 py-2 text-zinc-300">Backfill last 3 days</button>
            <button onClick={() => command("RELINK")} className="text-xs font-semibold border border-zinc-700 hover:border-blue-500 rounded-lg px-3 py-2 text-zinc-300">Re-link (show QR)</button>
            <button onClick={() => command("LOGOUT")} className="text-xs font-semibold border border-zinc-700 hover:border-rose-500 hover:text-rose-400 rounded-lg px-3 py-2 text-zinc-300">Unlink</button>
          </div>
        </div>
        {needsScan && (
          <div className="mt-4 flex gap-5 items-center rounded-lg border border-dashed border-zinc-700 p-4 bg-zinc-900/60">
            {gw?.qrDataUrl
              ? <img src={gw.qrDataUrl} alt="WhatsApp QR" width={180} height={180} className="rounded bg-white p-2" />
              : (
                // A stale QR means the gateway stopped: the row still holds the
                // last code it pushed, but that code expired seconds later and
                // scanning it can only fail. Saying so beats "Generating QR…"
                // forever, which is what this showed while nothing was running.
                <div className="w-[180px] h-[180px] grid place-items-center rounded border border-dashed border-zinc-700 px-3 text-center text-xs text-zinc-500">
                  {gw && gw.gatewayLive === false
                    ? <span>The gateway is not running,<br />so no QR is being produced.</span>
                    : <span>Generating QR…</span>}
                </div>
              )}
            <div className="text-sm text-zinc-300">
              <div className="font-semibold text-zinc-100 mb-1">Scan to link</div>
              <p className="text-zinc-400 max-w-xs">On the ops phone: <b>WhatsApp → Settings → Linked Devices → Link a Device</b>, then scan this code.</p>
              <p className="text-xs text-zinc-500 mt-2">Refreshes automatically until the device connects.</p>
              {gw && gw.gatewayLive === false && (
                <p className="text-xs text-amber-400 mt-2">
                  The gateway isn&apos;t running. On the server, start it with <code className="font-mono">docker compose -f docker-compose.yml -f docker-compose.wa.yml up -d wa-gateway</code> (or <code className="font-mono">./run-gateway.sh start</code> if it runs outside Docker); this code then refreshes on its own.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Onboarding: the same three steps for every lab and store */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 mb-4 text-sm text-zinc-300">
        <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold mb-2">Onboard a lab or store</div>
        <ol className="list-decimal pl-5 space-y-1 text-zinc-400">
          <li>Add the ops WhatsApp number{gw?.connectedNumber ? <> (+{gw.connectedNumber})</> : null} to their WhatsApp group.</li>
          <li>Find the group below and click <b className="text-zinc-200">Connect</b>.</li>
          <li>Pick the lab or store — the closest match by name is suggested — and confirm. That&apos;s all: the console reads the group, and a lab gets the standard messages.</li>
        </ol>
      </div>
      {connecting && <ConnectDialog group={connecting} onClose={() => setConnecting(null)} onDone={(message) => { setConnecting(null); flash(message); loadGroups(); }} />}

      {/* Groups */}
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

      {/* LS team roster */}
      <div className="rounded-xl border border-zinc-800 overflow-hidden mt-6">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">LS team contacts</div>
          <span className="ml-auto text-xs text-zinc-500">{contacts.length} members</span>
        </div>
        <div className="p-4 grid grid-cols-[1fr_1fr] gap-4 max-md:grid-cols-1">
          <div>
            <p className="text-xs text-zinc-400 mb-2">Paste one per line: <span className="font-mono text-zinc-300">Name, Phone[, Team]</span>. This is how the console tells your team&apos;s replies apart from incoming customer messages.</p>
            <textarea value={contactText} onChange={(e) => setContactText(e.target.value)} rows={6}
              placeholder={"Sushma, 919876543210, Store ops\nVijay Kansal, 919812345678, Lab desk"}
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 outline-none font-mono" />
            <button onClick={saveContacts} className="mt-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-lg px-3 py-2">Save team members</button>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {contacts.length === 0 && <div className="text-sm text-zinc-500">No team members yet.</div>}
            {contacts.map((c) => (
              <div key={c.id} className="flex items-center gap-2 py-1.5 border-b border-zinc-800/60 text-sm">
                <span className="text-zinc-200 font-medium">{c.name}</span>
                {c.phone && <span className="text-xs font-mono text-zinc-500">{c.phone}</span>}
                {c.team && <span className="text-[10px] text-zinc-400 bg-zinc-800 px-1.5 rounded">{c.team}</span>}
                <button onClick={() => deleteContact(c.id)} className="ml-auto text-xs text-zinc-500 hover:text-rose-400">remove</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {toast && <div className="fixed left-1/2 bottom-6 -translate-x-1/2 bg-zinc-100 text-zinc-900 px-4 py-2 rounded-lg font-medium text-sm shadow-lg z-10">{toast}</div>}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} className={`relative w-9 h-5 rounded-full transition-colors ${on ? "bg-blue-600" : "bg-zinc-700"}`}>
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${on ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );
}

const isConnected = (g: Group) =>
  (g.role === "PROVIDER" && g.labId != null) || (g.role === "SUPPORT" && g.storeId != null) || g.role === "INTERNAL";

function ConnectionLabel({ group }: { group: Group }) {
  if (group.role === "PROVIDER" && group.labId != null) return <span className="text-xs text-emerald-300">Lab #{group.labId}</span>;
  if (group.role === "SUPPORT" && group.storeId != null) return <span className="text-xs text-sky-300">Store #{group.storeId}</span>;
  if (group.role === "INTERNAL") return <span className="text-xs text-zinc-300">Internal</span>;
  if (group.role === "IGNORE") return <span className="text-xs text-zinc-600">Ignored</span>;
  return <span className="text-xs text-amber-400">Not connected</span>;
}

type ConnectOption = { id: number; name: string; detail: string | null; score: number };
type Kind = "LAB" | "STORE" | "INTERNAL" | "NONE";

/** Connect one group to a lab, a store, internal, or ignore it — everything set in one go (lib/wa/connect.ts). */
function ConnectDialog({ group, onClose, onDone }: { group: Group; onClose: () => void; onDone: (message: string) => void }) {
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
              {kind === "LAB" ? "The console reads this group, and the lab gets the standard messages (Message Rules) — nothing else to set. Add the lab manager’s number on Lab Config if you have it."
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
