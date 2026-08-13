"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type LastMsg = { text: string; sender: string; ts: string; direction: string };
type Ticket = {
  id: string; status: string; intent: string | null;
  orderId: number | null; requestId: number | null;
  group: string | null; groupRole: string | null;
  lastActivityAt: string; lastMessage: LastMsg | null;
  zone: string; priority: number; escalating: boolean; waiting: boolean;
};
type Detail = {
  ticket: { id: string; status: string; intent: string | null; orderId: number | null; requestId: number | null; liveContext: Record<string, unknown> | null; contextSnapshot: Record<string, unknown> | null };
  group: { id: string; jid: string; subject: string; labId: number | null; sendEnabled: boolean } | null;
  labGroup: { subject: string } | null;
  messages: { id: string; direction: string; fromMe: boolean; sender: string; text: string; ts: string; intent: string | null }[];
};

const ZONES = [
  { key: "ACT_NOW", label: "Act now", dot: "bg-rose-500", hint: "escalations & outages" },
  { key: "QUICK_ANSWER", label: "Quick answers", dot: "bg-emerald-500", hint: "status ready to send" },
  { key: "NEEDS_CALL", label: "Needs your call", dot: "bg-blue-500", hint: "reschedule · cancel · booking" },
  { key: "ASK_LAB", label: "Ask the lab", dot: "bg-amber-500", hint: "serviceability · slot · price" },
  { key: "MUTED", label: "Review · low signal", dot: "bg-zinc-500", hint: "" },
];

// Order status → the phrasing the bot drafts (mirrors the gateway playbook).
const STATUS_PHRASE: Record<string, string> = {
  CREATED: "order created, being scheduled", PENDING: "pending scheduling",
  ORDER_SCHEDULED: "scheduled, awaiting phlebo", PHLEBO_ASSIGNED: "phlebo assigned, out for collection",
  SAMPLE_COLLECTED: "sample collected, processing at lab", SAMPLE_PROCESSED: "sample processed, report being generated",
  SAMPLE_DELIVERED: "sample delivered to lab", KIT_DISPATCHED: "kit dispatched",
  REPORT_DELIVERED: "report delivered ✅", RESCHEDULED: "rescheduled",
  PATIENT_MISSED: "patient missed / not available", CANCELED: "cancelled", CANCELLED: "cancelled",
};

const fmtTime = (s: string) => new Date(s).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const ago = (s: string | null) => { if (!s) return ""; const m = Math.floor((Date.now() - new Date(s).getTime()) / 60000); return m < 1 ? "now" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`; };

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

function draftFor(d: Detail | null): string {
  if (!d) return "";
  const ctx = (d.ticket.liveContext || d.ticket.contextSnapshot || {}) as Record<string, unknown>;
  const st = String((ctx.orderStatus || ctx.status) || "").toUpperCase();
  if (!st || !d.ticket.orderId) return "";
  const appt = ctx.appointmentTime ? ` · appt ${fmtTime(String(ctx.appointmentTime))}` : "";
  return `#${d.ticket.orderId} — ${STATUS_PHRASE[st] || st}${appt}`;
}
const isAnswerable = (intent: string | null, orderId: number | null, requestId: number | null) =>
  !!(orderId || requestId) && ["STATUS_CHECK", "REPORT_REQUEST", "CANCEL_REASON"].includes(intent || "");

export function WhatsAppControlTower() {
  const [view, setView] = useState<"active" | "resolved">("active");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [zoneCounts, setZoneCounts] = useState<Record<string, number>>({});
  const [partner, setPartner] = useState<string>("ALL");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [target, setTarget] = useState<"store" | "lab" | "other">("store");
  const [reply, setReply] = useState("");
  const [toNumber, setToNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [gwOnline, setGwOnline] = useState(true);
  const prefilledId = useRef<string | null>(null);

  const loadList = useCallback(async () => {
    const res = await fetch(`/api/whatsapp/tickets?view=${view}`);
    if (!res.ok) return;
    const data = await res.json();
    setTickets(data.tickets); setZoneCounts(data.zoneCounts);
    if (!activeId && data.tickets[0]) setActiveId(data.tickets[0].id);
  }, [view, activeId]);

  const loadDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/whatsapp/tickets/${id}`);
    if (res.ok) setDetail(await res.json());
  }, []);

  useEffect(() => { loadList(); }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeId) loadDetail(activeId); }, [activeId, loadDetail]);
  useEffect(() => {
    const t = setInterval(() => {
      loadList();
      if (activeId) loadDetail(activeId);
      fetch("/api/whatsapp/gateway").then((r) => r.json()).then((g) => setGwOnline(!!g.online)).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [loadList, loadDetail, activeId]);

  // Pre-draft the status reply once per ticket open (never clobbers typing / poll refreshes).
  useEffect(() => {
    if (!detail) return;
    if (prefilledId.current === detail.ticket.id) return;
    prefilledId.current = detail.ticket.id;
    if (isAnswerable(detail.ticket.intent, detail.ticket.orderId, detail.ticket.requestId)) {
      const d = draftFor(detail);
      if (d) { setReply(d); setTarget("store"); return; }
    }
    setReply("");
  }, [detail]);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2200); };
  const shown = partner === "ALL" ? tickets : tickets.filter((t) => t.group === partner);
  const partners = Array.from(new Set(tickets.map((t) => t.group).filter(Boolean))) as string[];

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
  const answerable = detail && isAnswerable(detail.ticket.intent, detail.ticket.orderId, detail.ticket.requestId);

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

      <div className="grid grid-cols-[320px_1fr_320px] flex-1 min-h-0">
        {/* QUEUE — focus zones */}
        <div className="border-r border-zinc-800 flex flex-col min-h-0">
          <div className="p-2 border-b border-zinc-800 flex items-center gap-2">
            <select value={partner} onChange={(e) => setPartner(e.target.value)}
              className="flex-1 bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-300 focus:border-blue-500 outline-none">
              <option value="ALL">All partners</option>
              {partners.map((p) => <option key={p} value={p}>{p.replace("Labstack", "LS")}</option>)}
            </select>
            <button onClick={() => { setView(view === "active" ? "resolved" : "active"); setActiveId(null); }}
              className={`text-xs font-medium px-2.5 py-1.5 rounded-md border ${view === "resolved" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" : "border-zinc-700 text-zinc-400 hover:border-zinc-500"}`}>
              {view === "resolved" ? "Resolved" : "Active"}
            </button>
          </div>
          <div className="overflow-y-auto flex-1">
            {shown.length === 0 && <div className="p-6 text-sm text-zinc-500 text-center">Nothing here.</div>}
            {ZONES.map((z) => {
              const items = shown.filter((t) => t.zone === z.key);
              if (!items.length) return null;
              return (
                <div key={z.key}>
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900/60 border-y border-zinc-800/70 sticky top-0 z-10">
                    <span className={`w-1.5 h-1.5 rounded-full ${z.dot}`} />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-300">{z.label}</span>
                    {z.hint && <span className="text-[10px] text-zinc-600 hidden xl:inline">{z.hint}</span>}
                    <span className="ml-auto text-[11px] text-zinc-500 tabular-nums">{items.length}</span>
                  </div>
                  {items.map((t) => (
                    <button key={t.id} onClick={() => setActiveId(t.id)}
                      className={`w-full text-left px-3 py-2.5 border-b border-zinc-800/60 ${activeId === t.id ? "bg-zinc-800/60" : "hover:bg-zinc-900"}`}>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-zinc-100 truncate">{(t.group || "").replace("Labstack", "LS")}</span>
                        <span className="ml-auto text-[11px] text-zinc-500 tabular-nums">{ago(t.lastActivityAt)}</span>
                      </div>
                      <div className="text-xs text-zinc-400 truncate mt-0.5">{t.lastMessage?.text}</div>
                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${intentChip(t.intent)}`}>{(t.intent || "other").replace("_", " ")}</span>
                        {(t.orderId || t.requestId) && <span className="text-[11px] font-mono text-zinc-500">#{t.orderId || t.requestId}</span>}
                        {t.zone === "QUICK_ANSWER" && <span className="text-[10px] font-semibold text-emerald-400">● answer ready</span>}
                        {t.escalating && <span className="text-[10px] font-semibold text-rose-400">▲ escalating</span>}
                        {t.waiting && <span className="text-[10px] text-amber-400/80">waiting</span>}
                      </div>
                    </button>
                  ))}
                </div>
              );
            })}
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
                  {answerable && <span className="ml-auto text-[11px] text-emerald-400">draft ready — review &amp; send</span>}
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
                  <button onClick={() => { setTarget("store"); setReply(draftFor(detail)); }}
                    className="text-left text-sm border border-zinc-700 hover:border-emerald-500 rounded-lg px-3 py-2 text-zinc-200">↩ Reply with status <span className="block text-xs text-zinc-500">to the store group</span></button>
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
