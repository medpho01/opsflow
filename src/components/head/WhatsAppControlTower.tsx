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
  ticket: { id: string; status: string; intent: string | null; orderId: number | null; requestId: number | null; patient: string | null; lastHandledBy: { name: string; ts: string } | null; liveContext: Record<string, unknown> | null; contextSnapshot: Record<string, unknown> | null };
  group: { id: string; jid: string; subject: string; role: string; labId: number | null; sendEnabled: boolean } | null;
  labGroup: { id: string; jid: string; subject: string; labId: number | null } | null;
  lab?: { id: number; name: string | null; city: string | null } | null;
  providerGroups?: { id: string; jid: string; subject: string; labId: number | null }[];
  outbound?: { id: string; text: string; status: string; error: string | null; targetJid: string; createdAt: string; sentAt: string | null }[];
  bulkStatuses?: { orderId: number; status: string | null; appt: string | null; patient: string | null }[];
  related: { groupId: string; groupSubject: string; groupRole: string; sender: string; text: string; ts: string }[];
  messages: { id: string; direction: string; fromMe: boolean; sender: string; text: string; ts: string; intent: string | null; ticketId: string | null; isTeam: boolean; teamName: string | null; waMsgId: string; mediaType: string | null; mediaMime: string | null; ocrText: string | null; ocrJson: Record<string, unknown> | null; idType: string | null; idVia: string | null }[];
  timeline?: { id: string; groupId: string; groupSubject: string; groupRole: string; sender: string; text: string; intent: string | null; ts: string; isTeam: boolean; teamName: string | null; isCurrentGroup: boolean }[];
  mentions?: Record<string, string>;
  suggestResolve?: { reason: string } | null;
  brief?: {
    status: string | null; resolved: boolean; resolvedReason: string | null; waiting: string | null;
    timeline: { ts: string; actor: string; role: string; event: string }[] | null;
    suggestions: { store?: string; lab?: string } | null;
    analyzedAt: string; model: string | null;
  } | null;
};

// Replace "@919811111111" mentions with "@Name" using the resolved map.
function withMentions(text: string, mentions?: Record<string, string>): string {
  if (!text || !mentions) return text;
  return text.replace(/@(\d{5,})/g, (m, id: string) => {
    const name = mentions[id] || mentions[id.slice(-10)];
    return name ? `@${name}` : m;
  });
}

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
// Build a multi-line status reply covering every order named in the message.
function bulkDraft(d: Detail | null): string {
  if (!d?.bulkStatuses?.length) return "";
  return d.bulkStatuses
    .map((b) => {
      const st = String(b.status || "").toUpperCase();
      const who = b.patient ? ` (${b.patient})` : "";
      const appt = b.appt ? ` · appt ${fmtTime(b.appt)}` : "";
      return `#${b.orderId}${who} — ${st ? (STATUS_PHRASE[st] || st) : "no status found"}${appt}`;
    })
    .join("\n");
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
  const [labGroupId, setLabGroupId] = useState<string>("");
  const [replyTo, setReplyTo] = useState<{ waMsgId: string; sender: string; text: string } | null>(null);
  const [attachment, setAttachment] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [gwOnline, setGwOnline] = useState(true);
  const [gwDryRun, setGwDryRun] = useState(false);
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

  const loadGw = useCallback(() => {
    fetch("/api/whatsapp/gateway").then((r) => r.json()).then((g) => { setGwOnline(!!g.online); setGwDryRun(g.dryRun === true); }).catch(() => {});
  }, []);
  useEffect(() => { loadConvos(); loadGw(); }, [loadConvos, loadGw]);
  useEffect(() => { if (activeId) loadDetail(activeId); }, [activeId, loadDetail]);

  // Auto-interpret images that haven't been read yet (cloud vision). Runs once
  // per image on case open; on success we reload so the interpretation shows.
  const interpreting = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!detail) return;
    const pending = detail.messages.filter((m) => m.mediaType === "image" && !m.ocrText && !interpreting.current.has(m.waMsgId));
    if (pending.length === 0) return;
    let cancelled = false;
    (async () => {
      let any = false;
      for (const m of pending) {
        interpreting.current.add(m.waMsgId);
        try {
          const r = await fetch(`/api/whatsapp/media/${m.waMsgId}/interpret`, { method: "POST" });
          if (r.ok) any = true;
        } catch { /* ignore */ }
      }
      if (any && !cancelled && activeRef.current) loadDetail(activeRef.current);
    })();
    return () => { cancelled = true; };
  }, [detail, loadDetail]);

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
      loadGw();
    }, 15000);
    return () => { es.close(); clearInterval(poll); };
  }, [loadConvos, loadCases, loadDetail, loadGw]);

  useEffect(() => {
    if (!detail) return;
    if (prefilledId.current === detail.ticket.id) return;
    prefilledId.current = detail.ticket.id;
    setLabGroupId(detail.labGroup?.id || "");
    setAttachment(null);
    // Thread replies by default: quote the customer's latest message.
    const lastCustomer = [...detail.messages].reverse().find((m) => !m.isTeam && m.waMsgId);
    setReplyTo(lastCustomer ? { waMsgId: lastCustomer.waMsgId, sender: lastCustomer.sender, text: lastCustomer.text } : null);
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
    if (!activeId || (!reply.trim() && !attachment)) return flash("Write a message or attach a file");
    setBusy(true);
    const quotedWaMsgId = target === "store" && replyTo ? replyTo.waMsgId : undefined;
    let res: Response;
    if (attachment) {
      const fd = new FormData();
      fd.append("text", reply); fd.append("target", target);
      if (toNumber) fd.append("toNumber", toNumber);
      if (labGroupId) fd.append("labGroupId", labGroupId);
      if (quotedWaMsgId) fd.append("quotedWaMsgId", quotedWaMsgId);
      fd.append("file", attachment);
      res = await fetch(`/api/whatsapp/tickets/${activeId}/reply`, { method: "POST", body: fd });
    } else {
      res = await fetch(`/api/whatsapp/tickets/${activeId}/reply`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: reply, target, toNumber, labGroupId: labGroupId || undefined, quotedWaMsgId }),
      });
    }
    setBusy(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return flash(data.error || "Send failed");
    flash(`Queued → ${target === "store" ? "store group" : target === "lab" ? "lab group" : "number"}`);
    setReply(""); setReplyTo(null); setAttachment(null); loadConvos(); if (openGroup) loadCases(openGroup.id); loadDetail(activeId);
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
  async function relayToStore(groupId: string) {
    if (!reply.trim()) return flash("Write the status to send");
    const res = await fetch("/api/whatsapp/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupId, text: reply }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return flash(data.error || "Send failed");
    flash("Sent to the store group"); setReply(""); loadConvos();
  }

  const ctx = (detail?.ticket.liveContext || detail?.ticket.contextSnapshot || {}) as Record<string, unknown>;
  const orderStatus = (ctx.orderStatus || ctx.status) as string | undefined;
  const isProviderCase = detail?.group?.role === "PROVIDER";
  const providerUpdates = (detail?.related || []).filter((r) => r.groupRole === "PROVIDER");
  const storeQuery = (detail?.related || []).filter((r) => r.groupRole === "SUPPORT");

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800">
        <h1 className="text-lg font-semibold text-zinc-100">WhatsApp Control Tower</h1>
        <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border ${gwOnline ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" : "bg-rose-500/10 text-rose-400 border-rose-500/30"}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${gwOnline ? "bg-emerald-400" : "bg-rose-400"}`} />{gwOnline ? "Gateway online" : "Gateway offline"}
        </span>
        {livewire && <span className="text-[11px] text-emerald-400/80">● live</span>}
        {gwDryRun && (
          <span title="Gateway DRY_RUN is on — set WA_DRY_RUN=false and redeploy the gateway to actually send" className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border bg-amber-500/10 text-amber-400 border-amber-500/40 font-semibold">
            ⚠ Dry-run — sends disabled
          </span>
        )}
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
                    // Team replies (our roster / linked number) align right & blue;
                    // customer/partner messages align left & grey.
                    const team = m.isTeam;
                    return (
                      <div key={m.id} ref={m.id === lastCaseId ? caseAnchor : undefined}
                        className={`max-w-[80%] px-3 py-2 rounded-xl text-sm ${team ? "self-end bg-blue-500/15 border border-blue-500/25 rounded-tr-sm" : "self-start bg-zinc-800/70 border border-zinc-700/50 rounded-tl-sm"} ${isCase && !team ? "ring-2 ring-amber-500/70 border-amber-500/40" : ""}`}>
                        <div className="flex items-center gap-2 mb-0.5">
                          {team
                            ? <span className="text-[11px] font-semibold text-blue-300">{m.teamName || "Team"} <span className="text-zinc-500 font-normal">· LS team</span></span>
                            : <span className="text-[11px] font-semibold text-zinc-400">{m.sender}</span>}
                          {isCase && !team && <span className="text-[9px] font-bold uppercase tracking-wide text-amber-400 bg-amber-500/15 px-1.5 rounded">◆ this case</span>}
                          {!team && m.waMsgId && (
                            <button
                              onClick={() => { setReplyTo({ waMsgId: m.waMsgId, sender: m.sender, text: m.text }); setTarget("store"); }}
                              title="Reply to this message in the group"
                              className="ml-auto text-[10px] text-zinc-500 hover:text-blue-300"
                            >↩ Reply</button>
                          )}
                        </div>
                        {m.mediaType === "image" && (
                          <a href={`/api/whatsapp/media/${m.waMsgId}`} target="_blank" rel="noreferrer" className="block mb-1">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={`/api/whatsapp/media/${m.waMsgId}`} alt="attachment" className="max-h-64 rounded-lg border border-zinc-700/50 object-contain" />
                          </a>
                        )}
                        {m.mediaType === "document" && (
                          <a href={`/api/whatsapp/media/${m.waMsgId}`} target="_blank" rel="noreferrer" className="mb-1 flex items-center gap-2 rounded-lg border border-zinc-700/50 bg-zinc-900/50 px-3 py-2 text-xs text-blue-300 hover:border-blue-500/50">
                            📄 <span className="underline">Open document</span>
                          </a>
                        )}
                        <div className="text-zinc-100 whitespace-pre-wrap">{withMentions(m.text, detail.mentions)}</div>
                        {m.ocrText && (
                          <div className="mt-1.5 rounded-md border border-zinc-700/50 bg-zinc-900/40 p-2">
                            <div className="text-[9px] uppercase tracking-wide text-zinc-500 font-semibold mb-0.5">Interpreted from image</div>
                            <div className="text-[11px] text-zinc-300 whitespace-pre-wrap line-clamp-6">{m.ocrText}</div>
                          </div>
                        )}
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
                {target === "lab" && (
                  <select value={labGroupId} onChange={(e) => setLabGroupId(e.target.value)} className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 outline-none">
                    <option value="">{detail.labGroup ? `${short(detail.labGroup.subject)} (order's lab)` : "— pick a lab group —"}</option>
                    {(detail.providerGroups || []).filter((g) => g.id !== detail.labGroup?.id).map((g) => (
                      <option key={g.id} value={g.id}>{short(g.subject)}</option>
                    ))}
                  </select>
                )}
                {target === "store" && replyTo && (
                  <div className="flex items-start gap-2 rounded-lg border-l-2 border-blue-500 bg-zinc-900/60 px-2.5 py-1.5">
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] font-semibold text-blue-300">↩ Replying to {replyTo.sender}</div>
                      <div className="text-[11px] text-zinc-400 truncate">{replyTo.text}</div>
                    </div>
                    <button onClick={() => setReplyTo(null)} className="text-zinc-500 hover:text-zinc-300 text-sm leading-none">✕</button>
                  </div>
                )}
                {attachment && (
                  <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900/60 px-2.5 py-1.5 text-xs">
                    <span className="text-zinc-300">{attachment.type.startsWith("image/") ? "🖼️" : "📄"}</span>
                    <span className="text-zinc-200 truncate flex-1">{attachment.name}</span>
                    <span className="text-zinc-500">{Math.ceil(attachment.size / 1024)} KB</span>
                    <button onClick={() => { setAttachment(null); if (fileInput.current) fileInput.current.value = ""; }} className="text-zinc-500 hover:text-zinc-300">✕</button>
                  </div>
                )}
                <div className="flex gap-2 items-end">
                  <input ref={fileInput} type="file" className="hidden" accept="image/*,application/pdf,.pdf,.jpg,.jpeg,.png,.webp" onChange={(e) => setAttachment(e.target.files?.[0] || null)} />
                  <button onClick={() => fileInput.current?.click()} title="Attach a file or image" className="shrink-0 h-[42px] w-10 flex items-center justify-center border border-zinc-700 hover:border-blue-500 rounded-lg text-zinc-400 hover:text-zinc-200">📎</button>
                  <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2} placeholder="Write a reply, or use a suggested action →" className="flex-1 resize-none bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 outline-none" />
                  <button onClick={sendReply} disabled={busy} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-sm px-4 py-2.5 rounded-lg">Send ▸</button>
                </div>
                {detail.group && !detail.group.sendEnabled && <div className="text-[11px] text-amber-400">Sending is off for this group — enable it in Settings before replies actually send.</div>}
                {detail.outbound && detail.outbound.length > 0 && (
                  <div className="flex flex-col gap-1 pt-1">
                    {detail.outbound.slice(0, 4).map((o) => (
                      <div key={o.id} className="flex items-center gap-2 text-[11px]">
                        <span className={`px-1.5 rounded font-semibold ${
                          o.status === "SENT" ? "bg-emerald-500/15 text-emerald-300"
                          : o.status === "FAILED" ? "bg-rose-500/15 text-rose-300"
                          : o.status === "SENDING" ? "bg-blue-500/15 text-blue-300"
                          : "bg-amber-500/15 text-amber-300"}`}>
                          {o.status === "QUEUED" ? "QUEUED" : o.status === "SENT" ? "SENT" : o.status === "FAILED" ? "FAILED" : o.status}
                        </span>
                        <span className="text-zinc-500 truncate flex-1">{o.error ? o.error : o.text}</span>
                        <span className="text-zinc-600 tabular-nums shrink-0">{clock(o.sentAt || o.createdAt)}</span>
                      </div>
                    ))}
                    {detail.outbound.some((o) => o.status === "QUEUED") && gwDryRun && (
                      <div className="text-[10px] text-amber-400">Queued messages won&apos;t send while the gateway is in dry-run.</div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* RIGHT: case context + resolve */}
        <div className="flex flex-col min-h-0 overflow-y-auto">
          {detail && (
            <>
              {detail.brief && (
                <div className="p-4 border-b border-zinc-800 flex flex-col gap-2 bg-violet-500/5">
                  <div className="text-[11px] uppercase tracking-wide text-violet-300 font-semibold flex items-center gap-2">
                    ✦ AI brief
                    {detail.brief.resolved && <span className="text-[9px] font-bold uppercase text-emerald-400 bg-emerald-500/15 px-1.5 rounded">resolved</span>}
                  </div>
                  {detail.brief.status && <div className="text-sm text-zinc-100">{detail.brief.status}</div>}
                  {detail.brief.waiting && <div className="text-xs text-amber-300">⏳ {detail.brief.waiting}</div>}
                  {detail.brief.resolved && detail.brief.resolvedReason && (
                    <div className="mt-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2">
                      <div className="text-[11px] text-emerald-200">{detail.brief.resolvedReason}</div>
                      {detail.ticket.status !== "RESOLVED" && (
                        <button onClick={() => setStatus("RESOLVED")} className="mt-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-md px-3 py-1">Mark resolved</button>
                      )}
                    </div>
                  )}
                  {(detail.brief.suggestions?.store || detail.brief.suggestions?.lab) && (
                    <div className="flex flex-col gap-1.5 mt-1">
                      {detail.brief.suggestions?.store && (
                        <button onClick={() => { setTarget("store"); setReply(detail.brief!.suggestions!.store!); }} className="text-left text-xs border border-zinc-700 hover:border-emerald-500 rounded-lg px-2.5 py-1.5 text-zinc-200">↩ To customer <span className="block text-[11px] text-zinc-500 line-clamp-2">{detail.brief.suggestions.store}</span></button>
                      )}
                      {detail.brief.suggestions?.lab && (
                        <button onClick={() => { setTarget("lab"); setReply(detail.brief!.suggestions!.lab!); }} className="text-left text-xs border border-zinc-700 hover:border-blue-500 rounded-lg px-2.5 py-1.5 text-zinc-200">→ To lab <span className="block text-[11px] text-zinc-500 line-clamp-2">{detail.brief.suggestions.lab}</span></button>
                      )}
                    </div>
                  )}
                  <div className="text-[10px] text-zinc-600">analyzed {fmtTime(detail.brief.analyzedAt)}{detail.brief.model ? ` · ${detail.brief.model}` : ""}</div>
                </div>
              )}
              <div className="p-4 border-b border-zinc-800 flex flex-col gap-2">
                {detail.ticket.patient && <Row k="Patient" v={detail.ticket.patient} />}
                <Row k="Order" v={detail.ticket.orderId ? `#${detail.ticket.orderId}` : detail.ticket.requestId ? `Req #${detail.ticket.requestId}` : "— none —"} mono />
                <Row k="Store" v={short(detail.group?.subject || "—")} />
                {(detail.lab || detail.labGroup) && (
                  <Row
                    k="Lab"
                    v={detail.lab?.name
                      ? `${detail.lab.name}${detail.lab.city ? " · " + detail.lab.city : ""}`
                      : short(detail.labGroup?.subject || "—")}
                  />
                )}
                <Row k="Intent" v={detail.ticket.intent || "—"} />
                {detail.ticket.lastHandledBy && <Row k="Last handled" v={`${detail.ticket.lastHandledBy.name} · ${clock(detail.ticket.lastHandledBy.ts)}`} />}
              </div>
              <div className="p-4 border-b border-zinc-800 flex flex-col gap-2">
                <div className="flex items-baseline gap-2">
                  <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">Order context · live</div>
                  {ctx.statusUpdatedAt ? <span className="text-[10px] text-zinc-500">source updated {fmtTime(String(ctx.statusUpdatedAt))}</span> : null}
                </div>
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
              {detail.bulkStatuses && detail.bulkStatuses.length > 1 && (
                <div className="p-4 border-b border-zinc-800 flex flex-col gap-2">
                  <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold flex items-center gap-2">
                    All orders in this message
                    <span className="normal-case font-normal text-zinc-600">{detail.bulkStatuses.length}</span>
                  </div>
                  <div className="flex flex-col gap-1 max-h-52 overflow-y-auto pr-1">
                    {detail.bulkStatuses.map((b) => (
                      <div key={b.orderId} className="flex items-center gap-2 text-xs">
                        <span className="font-mono text-zinc-500 w-14 shrink-0">#{b.orderId}</span>
                        <span className="text-zinc-300 truncate flex-1">{b.patient || "—"}</span>
                        <span className={`px-1.5 rounded text-[10px] font-semibold ${b.status ? "bg-blue-500/15 text-blue-300" : "bg-zinc-700/40 text-zinc-500"}`}>{b.status ? (STATUS_PHRASE[b.status.toUpperCase()] || b.status) : "no status"}</span>
                      </div>
                    ))}
                  </div>
                  <button onClick={() => { setTarget("store"); setReply(bulkDraft(detail)); }} className="mt-1 text-left text-sm border border-zinc-700 hover:border-emerald-500 rounded-lg px-3 py-2 text-zinc-200">↩ Reply with all {detail.bulkStatuses.length} statuses <span className="block text-xs text-zinc-500">one line per order, to the store group</span></button>
                </div>
              )}
              {detail.timeline && detail.timeline.length > 1 && (() => {
                const tl = detail.timeline;
                const groupCount = new Set(tl.map((t) => t.groupId)).size;
                return (
                  <div className="p-4 border-b border-zinc-800 flex flex-col gap-2">
                    <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold flex items-center gap-2">
                      Order journey
                      <span className="normal-case font-normal text-zinc-600">{tl.length} messages · {groupCount} group{groupCount > 1 ? "s" : ""}</span>
                    </div>
                    <div className="relative pl-4 flex flex-col gap-3 max-h-[340px] overflow-y-auto pr-1">
                      <div className="absolute left-[3px] top-1.5 bottom-1.5 w-px bg-zinc-700/60" />
                      {tl.map((t) => (
                        <div key={t.id} className="relative">
                          <span className={`absolute -left-[13px] top-1.5 w-2 h-2 rounded-full ring-2 ring-zinc-900 ${t.isTeam ? "bg-blue-400" : t.groupRole === "PROVIDER" ? "bg-amber-400" : "bg-zinc-400"}`} />
                          <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
                            <span className={`px-1 rounded font-semibold ${t.groupRole === "PROVIDER" ? "bg-amber-500/15 text-amber-400" : "bg-blue-500/15 text-blue-300"}`}>{t.groupRole === "PROVIDER" ? "LAB" : "STORE"}</span>
                            <span className={`font-medium ${t.isCurrentGroup ? "text-zinc-200" : "text-zinc-500"}`}>{short(t.groupSubject)}</span>
                            {t.isTeam
                              ? <span className="text-blue-300">· {t.teamName || "LS team"}</span>
                              : <span className="text-zinc-500">· {t.sender}</span>}
                            <span className="text-zinc-600 ml-auto tabular-nums">{fmtTime(t.ts)}</span>
                          </div>
                          <div className="text-xs text-zinc-300 mt-0.5 whitespace-pre-wrap line-clamp-3">{withMentions(t.text, detail.mentions)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
              {(providerUpdates.length > 0 || storeQuery.length > 0) && (
                <div className="p-4 border-b border-zinc-800 flex flex-col gap-2">
                  <div className="text-[11px] uppercase tracking-wide font-semibold flex items-center gap-2">
                    <span className={isProviderCase ? "text-blue-400" : "text-amber-400"}>{isProviderCase ? "Customer query · store side" : "Provider status · lab side"}</span>
                    <span className="text-zinc-600">for #{detail.ticket.orderId || detail.ticket.requestId}</span>
                  </div>
                  {(isProviderCase ? storeQuery : providerUpdates).slice(0, 4).map((r, i) => (
                    <div key={i} className="rounded-lg border border-zinc-700/60 bg-zinc-900/40 p-2">
                      <div className="text-[10px] font-semibold text-zinc-400 flex items-center gap-1.5">
                        <span className={`px-1 rounded ${r.groupRole === "PROVIDER" ? "bg-amber-500/15 text-amber-400" : "bg-blue-500/15 text-blue-400"}`}>{r.groupRole === "PROVIDER" ? "LAB" : "STORE"}</span>
                        {short(r.groupSubject)} · {clock(r.ts)}
                      </div>
                      <div className="text-xs text-zinc-200 mt-1 whitespace-pre-wrap line-clamp-4">{withMentions(r.text, detail.mentions)}</div>
                      {!isProviderCase && <button onClick={() => { setTarget("store"); setReply(r.text); }} className="mt-1.5 text-[11px] text-emerald-400 hover:text-emerald-300 font-medium">↩ Use this to answer the store</button>}
                    </div>
                  ))}
                  {isProviderCase && storeQuery[0] && (
                    <button onClick={() => relayToStore(storeQuery[0].groupId)} className="text-left text-sm border border-zinc-700 hover:border-emerald-500 rounded-lg px-3 py-2 text-zinc-200">→ Send reply to the store <span className="block text-xs text-zinc-500">relays your message to {short(storeQuery[0].groupSubject)}</span></button>
                  )}
                </div>
              )}
              <div className="p-4 border-b border-zinc-800 flex flex-col gap-2">
                <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">Suggested actions</div>
                {orderStatus && (
                  <button onClick={() => { setTarget("store"); setReply(draftFor(detail)); }} className="text-left text-sm border border-zinc-700 hover:border-emerald-500 rounded-lg px-3 py-2 text-zinc-200">↩ Reply with status <span className="block text-xs text-zinc-500">to the store group</span></button>
                )}
                <button onClick={() => { setTarget("lab"); setReply(`Team, need help on #${detail.ticket.orderId || detail.ticket.requestId}${detail.ticket.patient ? " (" + detail.ticket.patient + ")" : ""} — please confirm.`); }} className="text-left text-sm border border-zinc-700 hover:border-blue-500 rounded-lg px-3 py-2 text-zinc-200">→ Ask the lab <span className="block text-xs text-zinc-500">{detail.labGroup ? short(detail.labGroup.subject) : "no lab group linked"}</span></button>
              </div>
              {detail.suggestResolve && (
                <div className="mx-4 mt-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 flex items-start gap-2">
                  <span className="text-emerald-400 text-sm">✓</span>
                  <div className="flex-1">
                    <div className="text-xs text-emerald-200">{detail.suggestResolve.reason}</div>
                    <button onClick={() => setStatus("RESOLVED")} className="mt-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-md px-3 py-1.5">Mark resolved</button>
                  </div>
                </div>
              )}
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
