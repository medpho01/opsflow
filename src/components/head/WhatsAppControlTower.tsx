"use client";

import { useCallback, useEffect, useState } from "react";

type LastMsg = { text: string; sender: string; ts: string; direction: string };
type Ticket = {
  id: string; status: string; intent: string | null;
  orderId: number | null; requestId: number | null;
  group: string | null; groupRole: string | null;
  lastActivityAt: string; slaDueAt: string | null; lastMessage: LastMsg | null;
};
type Detail = {
  ticket: { id: string; status: string; intent: string | null; orderId: number | null; requestId: number | null; liveContext: Record<string, unknown> | null; contextSnapshot: Record<string, unknown> | null };
  group: { id: string; jid: string; subject: string; labId: number | null; sendEnabled: boolean } | null;
  labGroup: { subject: string } | null;
  messages: { id: string; direction: string; fromMe: boolean; sender: string; text: string; ts: string; intent: string | null }[];
};

const BUCKETS = [
  { key: "needs_response", label: "Needs response", dot: "bg-rose-500" },
  { key: "waiting_lab", label: "Waiting on lab", dot: "bg-amber-500" },
  { key: "waiting_info", label: "Waiting on info", dot: "bg-blue-500" },
  { key: "resolved", label: "Resolved", dot: "bg-emerald-500" },
];

const fmtTime = (s: string) => new Date(s).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const ago = (s: string | null) => { if (!s) return ""; const m = Math.floor((Date.now() - new Date(s).getTime()) / 60000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`; };

function intentChip(intent: string | null) {
  const map: Record<string, string> = {
    STATUS_CHECK: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    REPORT_REQUEST: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    RESCHEDULE: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    CANCEL_REQUEST: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    NEW_BOOKING: "bg-violet-500/15 text-violet-400 border-violet-500/30",
    ESCALATION: "bg-rose-500/15 text-rose-400 border-rose-500/30",
    SERVICEABILITY: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  };
  return map[intent || ""] || "bg-zinc-700/40 text-zinc-400 border-zinc-600/40";
}

export function WhatsAppControlTower() {
  const [bucket, setBucket] = useState("needs_response");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [target, setTarget] = useState<"store" | "lab" | "other">("store");
  const [reply, setReply] = useState("");
  const [toNumber, setToNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [gwOnline, setGwOnline] = useState(true);

  const loadList = useCallback(async () => {
    const res = await fetch(`/api/whatsapp/tickets?bucket=${bucket}`);
    if (!res.ok) return;
    const data = await res.json();
    setTickets(data.tickets); setCounts(data.bucketCounts);
    if (!activeId && data.tickets[0]) setActiveId(data.tickets[0].id);
  }, [bucket, activeId]);

  const loadDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/whatsapp/tickets/${id}`);
    if (res.ok) setDetail(await res.json());
  }, []);

  useEffect(() => { loadList(); }, [bucket]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeId) loadDetail(activeId); }, [activeId, loadDetail]);
  useEffect(() => {
    const t = setInterval(() => {
      loadList();
      fetch("/api/whatsapp/gateway").then((r) => r.json()).then((g) => setGwOnline(!!g.online)).catch(() => {});
    }, 10000);
    return () => clearInterval(t);
  }, [loadList]);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2200); };

  async function sendReply() {
    if (!activeId || !reply.trim()) return flash("Write a message first");
    setBusy(true);
    const res = await fetch(`/api/whatsapp/tickets/${activeId}/reply`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: reply, target, toNumber }),
    });
    setBusy(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return flash(data.error || "Send failed");
    flash(`Queued → ${target === "store" ? "store group" : target === "lab" ? "lab group" : "number"}`);
    setReply(""); loadList(); loadDetail(activeId);
  }

  async function setStatus(status: string) {
    if (!activeId) return;
    await fetch(`/api/whatsapp/tickets/${activeId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    flash(`Marked ${status.replace("_", " ").toLowerCase()}`); loadList();
    if (activeId) loadDetail(activeId);
  }

  const ctx = (detail?.ticket.liveContext || detail?.ticket.contextSnapshot || {}) as Record<string, unknown>;
  const orderStatus = (ctx.orderStatus || ctx.status) as string | undefined;

  return (
    <div className="flex flex-col h-full">
      {/* header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800">
        <h1 className="text-lg font-semibold text-zinc-100">WhatsApp Control Tower</h1>
        <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border ${gwOnline ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" : "bg-rose-500/10 text-rose-400 border-rose-500/30"}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${gwOnline ? "bg-emerald-400" : "bg-rose-400"}`} />
          {gwOnline ? "Gateway online" : "Gateway offline"}
        </span>
        <a href="/head/settings/whatsapp" className="ml-auto text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-800 rounded-lg px-3 py-1.5">⚙ Settings</a>
      </div>

      <div className="grid grid-cols-[300px_1fr_320px] flex-1 min-h-0">
        {/* QUEUE */}
        <div className="border-r border-zinc-800 flex flex-col min-h-0">
          <div className="p-2 border-b border-zinc-800 flex flex-col gap-0.5">
            {BUCKETS.map((b) => (
              <button key={b.key} onClick={() => { setBucket(b.key); setActiveId(null); }}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-left ${bucket === b.key ? "bg-blue-500/15 text-blue-300" : "text-zinc-400 hover:bg-zinc-800/50"}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${b.dot}`} />{b.label}
                <span className="ml-auto text-xs text-zinc-500 tabular-nums">{counts[b.key] ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="overflow-y-auto flex-1">
            {tickets.length === 0 && <div className="p-6 text-sm text-zinc-500 text-center">Nothing here.</div>}
            {tickets.map((t) => (
              <button key={t.id} onClick={() => setActiveId(t.id)}
                className={`w-full text-left px-3 py-3 border-b border-zinc-800/70 ${activeId === t.id ? "bg-zinc-800/60" : "hover:bg-zinc-900"}`}>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm text-zinc-100 truncate">{(t.group || "").replace("Labstack", "LS")}</span>
                  <span className="ml-auto text-xs text-zinc-500 tabular-nums">{ago(t.lastActivityAt)}</span>
                </div>
                <div className="text-xs text-zinc-400 truncate mt-0.5">{t.lastMessage?.text}</div>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${intentChip(t.intent)}`}>{(t.intent || "other").replace("_", " ")}</span>
                  {(t.orderId || t.requestId) && <span className="text-[11px] font-mono text-zinc-500">#{t.orderId || t.requestId}</span>}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* CONVERSATION */}
        <div className="flex flex-col min-h-0 border-r border-zinc-800">
          {!detail ? (
            <div className="flex-1 grid place-items-center text-zinc-600 text-sm">Select a ticket</div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
                <span className="font-semibold text-zinc-100">{detail.group?.subject}</span>
                <span className={`ml-auto text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${intentChip(detail.ticket.intent)}`}>{(detail.ticket.intent || "other").replace("_", " ")}</span>
              </div>
              <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
                {detail.messages.map((m) => (
                  <div key={m.id} className={`max-w-[80%] px-3 py-2 rounded-xl text-sm ${m.fromMe || m.direction === "OUT" ? "self-end bg-blue-500/15 border border-blue-500/25 rounded-tr-sm" : "self-start bg-zinc-800/70 border border-zinc-700/50 rounded-tl-sm"}`}>
                    <div className="text-[11px] font-semibold text-zinc-400 mb-0.5">{m.fromMe ? "Team" : m.sender}</div>
                    <div className="text-zinc-100 whitespace-pre-wrap">{m.text}</div>
                    <div className="text-[10px] text-zinc-500 mt-1 text-right tabular-nums">{fmtTime(m.ts)}</div>
                  </div>
                ))}
              </div>
              {/* composer */}
              <div className="border-t border-zinc-800 p-3 flex flex-col gap-2 bg-zinc-900/40">
                <div className="flex items-center gap-2 text-xs">
                  <span className="uppercase tracking-wide text-zinc-500 font-semibold">Send to</span>
                  {(["store", "lab", "other"] as const).map((tg) => (
                    <button key={tg} onClick={() => setTarget(tg)}
                      className={`px-2.5 py-1 rounded-full border text-xs font-medium ${target === tg ? "bg-blue-600 border-blue-600 text-white" : "border-zinc-700 text-zinc-400 hover:border-zinc-500"}`}>
                      {tg === "store" ? "Store group" : tg === "lab" ? `Lab${detail.labGroup ? " · " + detail.labGroup.subject.slice(0, 14) : ""}` : "Other number"}
                    </button>
                  ))}
                </div>
                {target === "other" && (
                  <input value={toNumber} onChange={(e) => setToNumber(e.target.value)} placeholder="Number with country code, e.g. 9198…"
                    className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 outline-none" />
                )}
                <div className="flex gap-2 items-end">
                  <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2} placeholder="Write a reply, or use a suggested action →"
                    className="flex-1 resize-none bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 outline-none" />
                  <button onClick={sendReply} disabled={busy}
                    className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-sm px-4 py-2.5 rounded-lg">Send ▸</button>
                </div>
                {detail.group && !detail.group.sendEnabled && (
                  <div className="text-[11px] text-amber-400">Sending is off for this group — enable it in Settings before replies actually send.</div>
                )}
              </div>
            </>
          )}
        </div>

        {/* CONTEXT & ACTIONS */}
        <div className="flex flex-col min-h-0 overflow-y-auto">
          {detail && (
            <>
              <div className="p-4 border-b border-zinc-800 flex flex-col gap-2">
                <Row k="Order" v={detail.ticket.orderId ? `#${detail.ticket.orderId}` : detail.ticket.requestId ? `Req #${detail.ticket.requestId}` : "— none —"} mono />
                <Row k="Store" v={detail.group?.subject?.replace("Labstack", "LS") || "—"} />
                <Row k="Intent" v={detail.ticket.intent || "—"} />
              </div>
              <div className="p-4 border-b border-zinc-800 flex flex-col gap-2">
                <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">Order context · live</div>
                {orderStatus ? (
                  <>
                    <Row k="Status" v={String(orderStatus)} />
                    {ctx.appointmentTime ? <Row k="Appt" v={fmtTime(String(ctx.appointmentTime))} /> : null}
                    {ctx.phleboName ? <Row k="Phlebo" v={`${ctx.phleboName}${ctx.phleboNumber ? " · " + ctx.phleboNumber : ""}`} /> : null}
                    {ctx.cancelReason ? <Row k="Reason" v={String(ctx.cancelReason)} /> : null}
                    {ctx.quotedPrice ? <Row k="Quote" v={`₹${ctx.quotedPrice}`} /> : null}
                  </>
                ) : <div className="text-sm text-zinc-500">No id on this message — ask the partner for the order/booking id.</div>}
              </div>
              <div className="p-4 border-b border-zinc-800 flex flex-col gap-2">
                <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">Suggested actions</div>
                {orderStatus && (
                  <button onClick={() => { setTarget("store"); setReply(`#${detail.ticket.orderId} — ${orderStatus}${ctx.appointmentTime ? " · appt " + fmtTime(String(ctx.appointmentTime)) : ""}`); }}
                    className="text-left text-sm border border-zinc-700 hover:border-blue-500 rounded-lg px-3 py-2 text-zinc-200">↩ Reply with status <span className="block text-xs text-zinc-500">to the store group</span></button>
                )}
                <button onClick={() => { setTarget("lab"); setReply(`Team, need help on #${detail.ticket.orderId || detail.ticket.requestId} — please confirm.`); }}
                  className="text-left text-sm border border-zinc-700 hover:border-blue-500 rounded-lg px-3 py-2 text-zinc-200">→ Ask the lab <span className="block text-xs text-zinc-500">{detail.labGroup ? detail.labGroup.subject : "no lab group linked"}</span></button>
              </div>
              <div className="p-4 flex gap-2">
                <button onClick={() => setStatus("RESOLVED")} className="flex-1 text-xs font-semibold border border-zinc-700 hover:border-emerald-500 hover:text-emerald-400 rounded-lg py-2 text-zinc-300">Resolve</button>
                <button onClick={() => setStatus("WAITING_LAB")} className="flex-1 text-xs font-semibold border border-zinc-700 hover:border-amber-500 hover:text-amber-400 rounded-lg py-2 text-zinc-300">Wait · lab</button>
                <button onClick={() => setStatus("WAITING_INFO")} className="flex-1 text-xs font-semibold border border-zinc-700 hover:border-blue-500 hover:text-blue-400 rounded-lg py-2 text-zinc-300">Wait · info</button>
              </div>
            </>
          )}
        </div>
      </div>

      {toast && <div className="fixed left-1/2 bottom-6 -translate-x-1/2 bg-zinc-100 text-zinc-900 px-4 py-2 rounded-lg font-medium text-sm shadow-lg z-10">{toast}</div>}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-zinc-500">{k}</span>
      <span className={`text-zinc-200 text-right ${mono ? "font-mono" : ""}`}>{v}</span>
    </div>
  );
}
