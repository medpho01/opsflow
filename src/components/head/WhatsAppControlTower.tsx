"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Conversation = {
  groupId: string; subject: string; role: string; ticketId: string | null;
  lastText: string; lastSender: string; lastTs: string; lastFromMe: boolean; lastDir: string;
  unread: number; openTickets: number; breakdown: Record<string, number>;
  topIntent: string | null; topOrderId: number | null; answerReady: boolean; escalating: boolean;
};
type Case = {
  ticketId: string; status: string; intent: string | null;
  orderId: number | null; requestId: number | null; patient: string | null;
  lastActivityAt: string; snippet: string | null;
};
type Detail = {
  ticket: { id: string; status: string; intent: string | null; orderId: number | null; requestId: number | null; patient: string | null; liveContext: Record<string, unknown> | null; contextSnapshot: Record<string, unknown> | null };
  group: { id: string; jid: string; subject: string; labId: number | null; sendEnabled: boolean } | null;
  labGroup: { subject: string } | null;
  messages: { id: string; direction: string; fromMe: boolean; sender: string; text: string; ts: string; intent: string | null; ticketId: string | null }[];
};

const STATUS_PHRASE: Record<string, string> = {
  CREATED: "order created, being scheduled", PENDING: "pending scheduling",
  ORDER_SCHEDULED: "scheduled, awaiting phlebo", PHLEBO_ASSIGNED: "phlebo assigned, out for collection",
  SAMPLE_COLLECTED: "sample collected, processing at lab", SAMPLE_PROCESSED: "sample processed, report being generated",
  SAMPLE_DELIVERED: "sample delivered to lab", KIT_DISPATCHED: "kit dispatched",
  REPORT_DELIVERED: "report delivered ✅", RESCHEDULED: "rescheduled",
  PATIENT_MISSED: "patient missed / not available", CANCELED: "cancelled", CANCELLED: "cancelled",
};
const SHORT_INTENT: Record<string, string> = {
  STATUS_CHECK: "status", REPORT_REQUEST: "report", RESCHEDULE: "reschedule", CANCEL_REQUEST: "cancel",
  CANCEL_REASON: "cancel-why", NEW_BOOKING: "booking", CREATE_ACTION: "create", PATIENT_DATA: "patient-data",
  SERVICEABILITY: "serviceability", SLOT_CHECK: "slot", FEASIBILITY_QUOTE: "quote", ESCALATION: "escalation",
  TECH_ISSUE: "tech", OUTBOUND_UPDATE: "update", ID_ONLY: "id", OTHER: "other",
};
const fmtTime = (s: string) => new Date(s).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const clock = (s: string) => new Date(s).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
const ago = (s: string) => { const m = Math.floor((Date.now() - new Date(s).getTime()) / 60000); return m < 1 ? "now" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`; };
const short = (s: string) => s.replace(/labstack/ig, "LS");

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
function statusChip(s: string) {
  const map: Record<string, string> = {
    NEW: "bg-blue-500/15 text-blue-300", OPEN: "bg-blue-500/15 text-blue-300",
    WAITING_LAB: "bg-amber-500/15 text-amber-300", WAITING_INFO: "bg-violet-500/15 text-violet-300",
    ANSWERED: "bg-emerald-500/15 text-emerald-300", RESOLVED: "bg-zinc-600/30 text-zinc-400",
  };
  return map[s] || "bg-zinc-700/40 text-zinc-400";
}
function avatarColor(s: string) {
  const colors = ["bg-emerald-600", "bg-blue-600", "bg-violet-600", "bg-amber-600", "bg-rose-600", "bg-teal-600", "bg-indigo-600"];
  let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % colors.length;
  return colors[h];
}
function draftFor(d: Detail | null): string {
  if (!d) return "";
  const ctx = (d.ticket.liveContext || d.ticket.contextSnapshot || {}) as Record<string, unknown>;
  const st = String((ctx.orderStatus || ctx.status) || "").toUpperCase();
  if (!st || !d.ticket.orderId) return "";
  const appt = ctx.appointmentTime ? ` · appt ${fmtTime(String(ctx.appointmentTime))}` : "";
  const who = d.ticket.patient ? ` (${d.ticket.patient})` : "";
  return `#${d.ticket.orderId}${who} — ${STATUS_PHRASE[st] || st}${appt}`;
}
const isAnswerable = (intent: string | null, orderId: number | null, requestId: number | null) =>
  !!(orderId || requestId) && ["STATUS_CHECK", "REPORT_REQUEST", "CANCEL_REASON"].includes(intent || "");

export function WhatsAppControlTower() {
  const [convos, setConvos] = useState<Conversation[]>([]);
  const [totalUnread, setTotalUnread] = useState(0);
  const [filter, setFilter] = useState<"ALL" | "UNREAD" | "ACTION">("ALL");
  const [q, setQ] = useState("");
  const [nav, setNav] = useState<"groups" | "cases">("groups");
  const [openGroup, setOpenGroup] = useState<{ id: string; subject: string } | null>(null);
  const [cases, setCases] = useState<Case[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [target, setTarget] = useState<"store" | "lab" | "other">("store");
  const [reply, setReply] = useState("");
  const [toNumber, setToNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [gwOnline, setGwOnline] = useState(true);
  const [livewire, setLivewire] = useState(false);
  const prefilledId = useRef<string | null>(null);
  const caseAnchor = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<string | null>(null); activeRef.current = activeId;
  const groupRef = useRef<string | null>(null); groupRef.current = openGroup?.id || null;

  const loadConvos = useCallback(async () => {
    const res = await fetch("/api/whatsapp/conversations");
    if (!res.ok) return;
    const data = await res.json();
    setConvos(data.conversations); setTotalUnread(data.totalUnread);
  }, []);
  const loadCases = useCallback(async (groupId: string) => {
    const res = await fetch(`/api/whatsapp/groups/${groupId}/cases`);
    if (res.ok) setCases((await res.json()).cases);
  }, []);
  const loadDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/whatsapp/tickets/${id}`);
    if (res.ok) setDetail(await res.json());
  }, []);

  useEffect(() => { loadConvos(); }, [loadConvos]);
  useEffect(() => { if (activeId) loadDetail(activeId); }, [activeId, loadDetail]);

  useEffect(() => {
    const es = new EventSource("/api/whatsapp/stream");
    es.onopen = () => setLivewire(true);
    es.onmessage = (e) => {
      try {
        if (JSON.parse(e.data).changed) {
          loadConvos();
          if (groupRef.current) loadCases(groupRef.current);
          if (activeRef.current) loadDetail(activeRef.current);
        }
      } catch { /* keepalive */ }
    };
    es.onerror = () => setLivewire(false);
    const poll = setInterval(() => {
      loadConvos();
      if (groupRef.current) loadCases(groupRef.current);
      if (activeRef.current) loadDetail(activeRef.current);
      fetch("/api/whatsapp/gateway").then((r) => r.json()).then((g) => setGwOnline(!!g.online)).catch(() => {});
    }, 15000);
    return () => { es.close(); clearInterval(poll); };
  }, [loadConvos, loadCases, loadDetail]);

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

  // Scroll the case's own message into view when a case opens.
  useEffect(() => {
    const t = setTimeout(() => caseAnchor.current?.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
    return () => clearTimeout(t);
  }, [detail?.ticket.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2200); };

  function openConvo(c: Conversation) {
    setOpenGroup({ id: c.groupId, subject: c.subject }); setNav("cases");
    setActiveId(null); setDetail(null);
    loadCases(c.groupId);
    setConvos((cs) => cs.map((x) => (x.groupId === c.groupId ? { ...x, unread: 0 } : x)));
  }
  function backToGroups() { setNav("groups"); setOpenGroup(null); setActiveId(null); setDetail(null); }

  async function sendReply() {
    if (!activeId || !reply.trim()) return flash("Write a message first");
    setBusy(true);
    const res = await fetch(`/api/whatsapp/tickets/${activeId}/reply`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: reply, target, toNumber }),
    });
    setBusy(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return flash(data.error || "Send failed");
    flash(`Queued → ${target === "store" ? "store group" : target === "lab" ? "lab group" : "number"}`);
    setReply(""); loadConvos(); if (openGroup) loadCases(openGroup.id); loadDetail(activeId);
  }
  async function setStatus(status: string) {
    if (!activeId) return;
    await fetch(`/api/whatsapp/tickets/${activeId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    flash(`Marked ${status.replace("_", " ").toLowerCase()}`);
    loadConvos(); if (openGroup) loadCases(openGroup.id); loadDetail(activeId);
  }

  const shown = convos.filter((c) => {
    if (q && !c.subject.toLowerCase().includes(q.toLowerCase())) return false;
    if (filter === "UNREAD") return c.unread > 0;
    if (filter === "ACTION") return c.openTickets > 0 || c.answerReady || c.escalating;
    return true;
  });
  const ctx = (detail?.ticket.liveContext || detail?.ticket.contextSnapshot || {}) as Record<string, unknown>;
  const orderStatus = (ctx.orderStatus || ctx.status) as string | undefined;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800">
        <h1 className="text-lg font-semibold text-zinc-100">WhatsApp Control Tower</h1>
        <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border ${gwOnline ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" : "bg-rose-500/10 text-rose-400 border-rose-500/30"}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${gwOnline ? "bg-emerald-400" : "bg-rose-400"}`} />{gwOnline ? "Gateway online" : "Gateway offline"}
        </span>
        {livewire && <span className="text-[11px] text-emerald-400/80">● live</span>}
        {totalUnread > 0 && <span className="text-xs text-zinc-400">{totalUnread} unread</span>}
        <a href="/head/settings/whatsapp" className="ml-auto text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-800 rounded-lg px-3 py-1.5">⚙ Settings</a>
      </div>

      <div className="grid grid-cols-[340px_1fr_320px] flex-1 min-h-0">
        {/* LEFT: groups → cases drill-down */}
        <div className="border-r border-zinc-800 flex flex-col min-h-0">
          {nav === "groups" ? (
            <>
              <div className="p-2 border-b border-zinc-800 flex flex-col gap-2">
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search groups…"
                  className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 outline-none" />
                <div className="flex gap-1.5">
                  {(["ALL", "UNREAD", "ACTION"] as const).map((f) => (
                    <button key={f} onClick={() => setFilter(f)} className={`text-xs font-medium px-2.5 py-1 rounded-full border ${filter === f ? "bg-blue-600 border-blue-600 text-white" : "border-zinc-700 text-zinc-400 hover:border-zinc-500"}`}>
                      {f === "ALL" ? "All" : f === "UNREAD" ? "Unread" : "Needs action"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="overflow-y-auto flex-1">
                {shown.length === 0 && <div className="p-6 text-sm text-zinc-500 text-center">No conversations.</div>}
                {shown.map((c) => {
                  const bd = Object.entries(c.breakdown || {}).sort((a, b) => b[1] - a[1]);
                  return (
                    <button key={c.groupId} onClick={() => openConvo(c)} className="w-full text-left px-3 py-2.5 border-b border-zinc-800/60 flex gap-3 hover:bg-zinc-900">
                      <span className={`w-9 h-9 rounded-full grid place-items-center text-xs font-bold text-white flex-none ${avatarColor(c.subject)}`}>
                        {short(c.subject).replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "LS"}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="font-semibold text-sm text-zinc-100 truncate">{short(c.subject)}</span>
                          <span className="ml-auto text-[11px] text-zinc-500 tabular-nums flex-none">{clock(c.lastTs)}</span>
                        </span>
                        <span className="flex items-center gap-2 mt-0.5">
                          <span className={`text-xs truncate ${c.unread ? "text-zinc-200" : "text-zinc-500"}`}>{c.lastFromMe ? "You: " : ""}{c.lastText}</span>
                          {c.unread > 0 && <span className="ml-auto flex-none min-w-[18px] h-[18px] px-1 rounded-full bg-emerald-500 text-[11px] font-bold text-zinc-950 grid place-items-center tabular-nums">{c.unread}</span>}
                        </span>
                        <span className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                          {c.openTickets > 0 && <span className="text-[10px] font-semibold text-zinc-300">{c.openTickets} open</span>}
                          {bd.slice(0, 3).map(([k, n]) => <span key={k} className="text-[10px] text-zinc-500">{n} {SHORT_INTENT[k] || k.toLowerCase()}</span>)}
                          {c.answerReady && <span className="text-[10px] font-semibold text-emerald-400">● answer ready</span>}
                          {c.escalating && <span className="text-[10px] font-semibold text-rose-400">▲ escalating</span>}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div className="p-2 border-b border-zinc-800 flex items-center gap-2">
                <button onClick={backToGroups} className="text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-md px-2 py-1">‹ Groups</button>
                <span className="text-sm font-semibold text-zinc-100 truncate">{short(openGroup?.subject || "")}</span>
                <span className="ml-auto text-[11px] text-zinc-500">{cases.length} cases</span>
              </div>
              <div className="overflow-y-auto flex-1">
                {cases.length === 0 && <div className="p-6 text-sm text-zinc-500 text-center">All clear — no open cases.</div>}
                {cases.map((cs) => (
                  <button key={cs.ticketId} onClick={() => setActiveId(cs.ticketId)}
                    className={`w-full text-left px-3 py-2.5 border-b border-zinc-800/60 ${activeId === cs.ticketId ? "bg-zinc-800/60" : "hover:bg-zinc-900"}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-zinc-100 truncate">{cs.patient || (cs.orderId || cs.requestId ? `#${cs.orderId || cs.requestId}` : "Needs an id")}</span>
                      <span className={`ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded ${statusChip(cs.status)}`}>{cs.status.replace("_", " ").toLowerCase()}</span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1">
                      {(cs.orderId || cs.requestId) && <span className="text-[11px] font-mono text-zinc-500">#{cs.orderId || cs.requestId}</span>}
                      <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${intentChip(cs.intent)}`}>{(cs.intent || "other").replace("_", " ")}</span>
                      <span className="ml-auto text-[11px] text-zinc-500">{ago(cs.lastActivityAt)}</span>
                    </div>
                    {cs.snippet && <div className="text-xs text-zinc-500 truncate mt-1">{cs.snippet}</div>}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* CENTER: case thread */}
        <div className="flex flex-col min-h-0 border-r border-zinc-800">
          {!detail ? (
            <div className="flex-1 grid place-items-center text-zinc-600 text-sm">{nav === "cases" ? "Select a case" : "Select a conversation"}</div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
                <span className="font-semibold text-zinc-100">{detail.ticket.patient || short(detail.group?.subject || "")}</span>
                {(detail.ticket.orderId || detail.ticket.requestId) && <span className="text-xs font-mono text-zinc-500">#{detail.ticket.orderId || detail.ticket.requestId}</span>}
                <span className={`ml-auto text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${intentChip(detail.ticket.intent)}`}>{(detail.ticket.intent || "other").replace("_", " ")}</span>
              </div>
              <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
                {(() => {
                  const caseIds = detail.messages.filter((m) => m.ticketId === detail.ticket.id).map((m) => m.id);
                  const lastCaseId = caseIds[caseIds.length - 1];
                  return detail.messages.map((m) => {
                    const isCase = m.ticketId === detail.ticket.id;
                    const mine = m.fromMe || m.direction === "OUT";
                    return (
                      <div key={m.id} ref={m.id === lastCaseId ? caseAnchor : undefined}
                        className={`max-w-[80%] px-3 py-2 rounded-xl text-sm ${mine ? "self-end bg-blue-500/15 border border-blue-500/25 rounded-tr-sm" : "self-start bg-zinc-800/70 border border-zinc-700/50 rounded-tl-sm"} ${isCase && !mine ? "ring-2 ring-amber-500/70 border-amber-500/40" : ""}`}>
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-[11px] font-semibold text-zinc-400">{m.fromMe ? "Team" : m.sender}</span>
                          {isCase && !mine && <span className="text-[9px] font-bold uppercase tracking-wide text-amber-400 bg-amber-500/15 px-1.5 rounded">◆ this case</span>}
                        </div>
                        <div className="text-zinc-100 whitespace-pre-wrap">{m.text}</div>
                        <div className="text-[10px] text-zinc-500 mt-1 text-right tabular-nums">{fmtTime(m.ts)}</div>
                      </div>
                    );
                  });
                })()}
              </div>
              <div className="border-t border-zinc-800 p-3 flex flex-col gap-2 bg-zinc-900/40">
                <div className="flex items-center gap-2 text-xs">
                  <span className="uppercase tracking-wide text-zinc-500 font-semibold">Send to</span>
                  {(["store", "lab", "other"] as const).map((tg) => (
                    <button key={tg} onClick={() => setTarget(tg)} className={`px-2.5 py-1 rounded-full border text-xs font-medium ${target === tg ? "bg-blue-600 border-blue-600 text-white" : "border-zinc-700 text-zinc-400 hover:border-zinc-500"}`}>
                      {tg === "store" ? "Store group" : tg === "lab" ? `Lab${detail.labGroup ? " · " + short(detail.labGroup.subject).slice(0, 14) : ""}` : "Other number"}
                    </button>
                  ))}
                </div>
                {target === "other" && (
                  <input value={toNumber} onChange={(e) => setToNumber(e.target.value)} placeholder="Number with country code, e.g. 9198…" className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 outline-none" />
                )}
                <div className="flex gap-2 items-end">
                  <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2} placeholder="Write a reply, or use a suggested action →" className="flex-1 resize-none bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 outline-none" />
                  <button onClick={sendReply} disabled={busy} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-sm px-4 py-2.5 rounded-lg">Send ▸</button>
                </div>
                {detail.group && !detail.group.sendEnabled && <div className="text-[11px] text-amber-400">Sending is off for this group — enable it in Settings before replies actually send.</div>}
              </div>
            </>
          )}
        </div>

        {/* RIGHT: case context + resolve */}
        <div className="flex flex-col min-h-0 overflow-y-auto">
          {detail && (
            <>
              <div className="p-4 border-b border-zinc-800 flex flex-col gap-2">
                {detail.ticket.patient && <Row k="Patient" v={detail.ticket.patient} />}
                <Row k="Order" v={detail.ticket.orderId ? `#${detail.ticket.orderId}` : detail.ticket.requestId ? `Req #${detail.ticket.requestId}` : "— none —"} mono />
                <Row k="Store" v={short(detail.group?.subject || "—")} />
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
                  <button onClick={() => { setTarget("store"); setReply(draftFor(detail)); }} className="text-left text-sm border border-zinc-700 hover:border-emerald-500 rounded-lg px-3 py-2 text-zinc-200">↩ Reply with status <span className="block text-xs text-zinc-500">to the store group</span></button>
                )}
                <button onClick={() => { setTarget("lab"); setReply(`Team, need help on #${detail.ticket.orderId || detail.ticket.requestId}${detail.ticket.patient ? " (" + detail.ticket.patient + ")" : ""} — please confirm.`); }} className="text-left text-sm border border-zinc-700 hover:border-blue-500 rounded-lg px-3 py-2 text-zinc-200">→ Ask the lab <span className="block text-xs text-zinc-500">{detail.labGroup ? short(detail.labGroup.subject) : "no lab group linked"}</span></button>
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
