"use client";

import { useCallback, useEffect, useState } from "react";

type Gateway = { status: string; online: boolean; connectedNumber: string | null; qrDataUrl: string | null; lastSeenAt: string | null; gatewayLive?: boolean; pairingCode?: string | null; pairingRequested?: boolean };

export function WhatsAppSettings() {
  const [gw, setGw] = useState<Gateway | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [contacts, setContacts] = useState<{ id: string; name: string; phone: string | null; team: string | null; coach?: boolean }[]>([]);
  const [contactText, setContactText] = useState("");
  const [pairPhone, setPairPhone] = useState("");
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2200); };


  const loadGw = useCallback(async () => {
    const r = await fetch("/api/whatsapp/gateway"); if (r.ok) setGw(await r.json());
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
  async function setCoach(id: string, coach: boolean) {
    await fetch(`/api/whatsapp/contacts/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ coach }) }); loadContacts();
  }

  useEffect(() => { loadGw(); loadContacts(); }, [loadGw, loadContacts]);
  useEffect(() => { const t = setInterval(loadGw, 3000); return () => clearInterval(t); }, [loadGw]); // live QR/status

  async function command(command: string) {
    await fetch("/api/whatsapp/gateway", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command }) });
    flash(command === "LOGOUT" ? "Unlinking…" : command === "BACKFILL" ? "Backfilling last 3 days — re-resolving threads & pulling media…" : "Re-linking — scan the new QR");
    loadGw();
  }

  async function requestPairingCode() {
    const r = await fetch("/api/whatsapp/gateway", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "PAIR", phone: pairPhone }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return flash(d.error || "Could not request a code");
    flash("Asking WhatsApp for a code…"); loadGw();
  }

  const connected = gw?.status === "CONNECTED";
  const needsScan = gw?.status === "QR" || gw?.status === "LOGGED_OUT";

  return (
    <div className="max-w-5xl">
      <div className="mb-1 text-xs text-zinc-500"><a href="/head/whatsapp" className="hover:text-zinc-300">‹ Back to inbox</a> &nbsp;·&nbsp; Settings / Integrations / <span className="text-zinc-300 font-medium">WhatsApp</span></div>
      <h1 className="text-2xl font-semibold text-zinc-100 tracking-tight">WhatsApp integration</h1>
      <p className="text-sm text-zinc-400 mt-1 mb-5">Link the ops WhatsApp account and keep the team roster. Labs, stores and their groups are on Connections. Admins only.</p>

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
              {/* QR not scanning, or the phone hangs on "Logging in"? Link with the number instead. */}
              <div className="mt-4 pt-3 border-t border-zinc-800">
                <div className="font-semibold text-zinc-100 mb-1 text-xs">Or link with phone number</div>
                {gw?.pairingCode ? (
                  <div>
                    <div className="font-mono text-2xl tracking-[0.3em] text-emerald-400 my-1">{gw.pairingCode.slice(0, 4)}-{gw.pairingCode.slice(4)}</div>
                    <p className="text-xs text-zinc-400 max-w-sm">On the ops phone: <b>Linked Devices → Link a Device → Link with phone number instead</b>, then enter this code. Valid for a few minutes.</p>
                  </div>
                ) : (
                  <div className="flex gap-2 items-center flex-wrap">
                    <input value={pairPhone} onChange={(e) => setPairPhone(e.target.value)} inputMode="tel" placeholder="Ops number, e.g. 9198XXXXXXXX"
                      className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-100 focus:border-blue-500 outline-none font-mono w-56" />
                    <button onClick={requestPairingCode} disabled={!pairPhone.trim() || gw?.pairingRequested}
                      className="text-xs font-semibold border border-zinc-700 hover:border-blue-500 rounded-lg px-3 py-2 text-zinc-300 disabled:opacity-50">
                      {gw?.pairingRequested ? "Waiting for the gateway…" : "Get code"}
                    </button>
                  </div>
                )}
              </div>
              {gw && gw.gatewayLive === false && (
                <p className="text-xs text-amber-400 mt-2">
                  The gateway isn&apos;t running. On the server, start it with <code className="font-mono">docker compose -f docker-compose.yml -f docker-compose.wa.yml up -d wa-gateway</code> (or <code className="font-mono">./run-gateway.sh start</code> if it runs outside Docker); this code then refreshes on its own.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Groups are connected on the Connections page now: one place for labs, stores and their groups. */}
      <a href="/head/connections?tab=groups" className="block rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 mb-6 hover:border-blue-500/60">
        <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold mb-1">Groups</div>
        <div className="text-sm text-zinc-300">Connect each WhatsApp group to its lab or store on <span className="text-blue-400 font-medium">Connections →</span></div>
      </a>

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
                <label className="ml-auto flex items-center gap-1 text-[11px] text-zinc-400 cursor-pointer" title="May coach the agent from WhatsApp: reply to one of its messages, or write 'bot: …' in the internal group, and it follows the lesson at once.">
                  <input type="checkbox" checked={!!c.coach} onChange={(e) => setCoach(c.id, e.target.checked)} className="accent-blue-500" /> coach
                </label>
                <button onClick={() => deleteContact(c.id)} className="text-xs text-zinc-500 hover:text-rose-400">remove</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {toast && <div className="fixed left-1/2 bottom-6 -translate-x-1/2 bg-zinc-100 text-zinc-900 px-4 py-2 rounded-lg font-medium text-sm shadow-lg z-10">{toast}</div>}
    </div>
  );
}
