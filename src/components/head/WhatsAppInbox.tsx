"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Convo = { groupId: string; subject: string; role: string; lastText: string; lastTs: string; unread: number };
type Msg = {
  id: string; waMsgId: string; fromMe: boolean; sender: string; text: string; ts: string;
  intent: string | null; orderId: number | null; requestId: number | null; ticketId: string | null;
  mediaType: string | null; isTeam: boolean; teamName: string | null; role: string;
};
type Group = { id: string; jid: string; subject: string; role: string; sendEnabled: boolean };

const fmtTime = (s: string) => new Date(s).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const short = (s: string) => (s || "").replace(/labstack/gi, "LS");
const roleTint = (r: string) => r === "Ops" ? "text-blue-300" : r === "Lab" ? "text-amber-300" : r === "Customer" ? "text-emerald-300" : "text-zinc-400";

export default function WhatsAppInbox({ gwDryRun, onOpenCase }: { gwDryRun: boolean; onOpenCase: (groupId: string, ticketId: string) => void }) {
  const [convos, setConvos] = useState<Convo[]>([]);
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [group, setGroup] = useState<Group | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [selected, setSelected] = useState<Msg | null>(null);
  const [reply, setReply] = useState("");
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [attachment, setAttachment] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const openRef = useRef<string | null>(null); openRef.current = openId;
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2200); };

  const loadConvos = useCallback(async () => {
    const r = await fetch("/api/whatsapp/conversations");
    if (r.ok) setConvos((await r.json()).conversations);
  }, []);
  const loadMsgs = useCallback(async (id: string) => {
    const r = await fetch(`/api/whatsapp/groups/${id}/messages?limit=250`);
    if (r.ok) { const d = await r.json(); setGroup(d.group); setMsgs(d.messages); }
  }, []);

  useEffect(() => { loadConvos(); }, [loadConvos]);
  useEffect(() => { if (openId) loadMsgs(openId); }, [openId, loadMsgs]);
  useEffect(() => {
    const t = setInterval(() => { loadConvos(); if (openRef.current) loadMsgs(openRef.current); }, 6000);
    return () => clearInterval(t);
  }, [loadConvos, loadMsgs]);
  useEffect(() => { const t = setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), 80); return () => clearTimeout(t); }, [msgs.length]);
  useEffect(() => { setSelected(null); setReplyTo(null); setReply(""); setAttachment(null); }, [openId]);

  const filtered = convos.filter((c) => !q || c.subject.toLowerCase().includes(q.toLowerCase()));

  async function send() {
    if (!openId || (!reply.trim() && !attachment)) return flash("Write a message or attach a file");
    setBusy(true);
    let res: Response;
    if (attachment) {
      const fd = new FormData();
      fd.append("text", reply); fd.append("groupId", openId);
      if (replyTo) fd.append("quotedWaMsgId", replyTo.waMsgId);
      fd.append("file", attachment);
      res = await fetch("/api/whatsapp/send", { method: "POST", body: fd });
    } else {
      res = await fetch("/api/whatsapp/send", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId: openId, text: reply, quotedWaMsgId: replyTo?.waMsgId }),
      });
    }
    setBusy(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return flash(data.error || "Send failed");
    flash("Queued"); setReply(""); setReplyTo(null); setAttachment(null);
    if (fileInput.current) fileInput.current.value = "";
    loadMsgs(openId);
  }

  return (
    <div className="grid grid-cols-[340px_1fr_320px] flex-1 min-h-0">
      {/* LEFT: chats */}
      <div className="border-r border-zinc-800 flex flex-col min-h-0">
        <div className="p-2 border-b border-zinc-800">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats…"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 outline-none" />
        </div>
        <div className="overflow-y-auto flex-1">
          {filtered.map((c) => (
            <button key={c.groupId} onClick={() => setOpenId(c.groupId)}
              className={`w-full text-left px-3 py-2.5 border-b border-zinc-800/60 ${openId === c.groupId ? "bg-zinc-800/60" : "hover:bg-zinc-900"}`}>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm text-zinc-100 truncate flex-1">{short(c.subject)}</span>
                {c.unread > 0 && <span className="text-[10px] font-bold bg-emerald-600 text-white rounded-full px-1.5 min-w-5 text-center">{c.unread}</span>}
              </div>
              <div className="text-xs text-zinc-500 truncate">{c.lastText}</div>
            </button>
          ))}
        </div>
      </div>

      {/* MIDDLE: message stream + composer */}
      <div className="flex flex-col min-h-0 border-r border-zinc-800">
        {!group ? (
          <div className="flex-1 grid place-items-center text-sm text-zinc-500">Select a chat</div>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
              <span className="font-semibold text-zinc-100 truncate">{short(group.subject)}</span>
              <span className={`text-[10px] uppercase font-semibold px-1.5 rounded ${group.role === "PROVIDER" ? "bg-amber-500/15 text-amber-400" : group.role === "SUPPORT" ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-700/40 text-zinc-400"}`}>{group.role === "PROVIDER" ? "Lab" : group.role === "SUPPORT" ? "Customer" : "—"}</span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-1.5">
              {msgs.map((m) => (
                <div key={m.id} onClick={() => setSelected(m)}
                  className={`max-w-[75%] px-3 py-2 rounded-xl text-sm cursor-pointer ${m.isTeam ? "self-end bg-blue-500/15 border border-blue-500/25" : "self-start bg-zinc-800/70 border border-zinc-700/50"} ${selected?.id === m.id ? "ring-2 ring-blue-500/60" : ""}`}>
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={`text-[11px] font-semibold ${m.isTeam ? "text-blue-300" : roleTint(m.role)}`}>{m.isTeam ? `${m.teamName || "You"} · Ops` : `${m.sender} · ${m.role}`}</span>
                    <button onClick={(e) => { e.stopPropagation(); setReplyTo(m); }} className="ml-auto text-[10px] text-zinc-500 hover:text-blue-300">↩</button>
                  </div>
                  {m.mediaType === "image" && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/whatsapp/media/${m.waMsgId}`} alt="" className="max-h-52 rounded-lg border border-zinc-700/50 object-contain mb-1" />
                  )}
                  {m.mediaType === "document" && <a href={`/api/whatsapp/media/${m.waMsgId}`} target="_blank" rel="noreferrer" className="text-xs text-blue-300 underline">📄 document</a>}
                  <div className="text-zinc-100 whitespace-pre-wrap">{m.text}</div>
                  <div className="text-[10px] text-zinc-500 mt-1 text-right">{fmtTime(m.ts)}</div>
                </div>
              ))}
              <div ref={bottom} />
            </div>
            <div className="border-t border-zinc-800 p-3 flex flex-col gap-2 bg-zinc-900/40">
              {replyTo && (
                <div className="flex items-start gap-2 rounded-lg border-l-2 border-blue-500 bg-zinc-900/60 px-2.5 py-1.5">
                  <div className="flex-1 min-w-0"><div className="text-[10px] font-semibold text-blue-300">↩ Replying to {replyTo.sender}</div><div className="text-[11px] text-zinc-400 truncate">{replyTo.text}</div></div>
                  <button onClick={() => setReplyTo(null)} className="text-zinc-500 hover:text-zinc-300">✕</button>
                </div>
              )}
              {attachment && (
                <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900/60 px-2.5 py-1.5 text-xs">
                  <span>{attachment.type.startsWith("image/") ? "🖼️" : "📄"}</span>
                  <span className="text-zinc-200 truncate flex-1">{attachment.name}</span>
                  <button onClick={() => { setAttachment(null); if (fileInput.current) fileInput.current.value = ""; }} className="text-zinc-500 hover:text-zinc-300">✕</button>
                </div>
              )}
              <div className="flex gap-2 items-end">
                <input ref={fileInput} type="file" className="hidden" accept="image/*,application/pdf" onChange={(e) => setAttachment(e.target.files?.[0] || null)} />
                <button onClick={() => fileInput.current?.click()} className="shrink-0 h-[42px] w-10 flex items-center justify-center border border-zinc-700 hover:border-blue-500 rounded-lg text-zinc-400">📎</button>
                <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2} placeholder="Message… (replies to the whole group)"
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
                  className="flex-1 resize-none bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 outline-none" />
                <button onClick={send} disabled={busy} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-sm px-4 py-2.5 rounded-lg">Send ▸</button>
              </div>
              {group && !group.sendEnabled && <div className="text-[11px] text-amber-400">Sending is off for this group — enable it in Settings.</div>}
              {gwDryRun && <div className="text-[11px] text-amber-400">Gateway is in dry-run — messages queue but won&apos;t send.</div>}
            </div>
          </>
        )}
      </div>

      {/* RIGHT: selected message context */}
      <div className="flex flex-col min-h-0 overflow-y-auto">
        {selected ? (
          <div className="p-4 flex flex-col gap-3">
            <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">Message context</div>
            <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/40 p-3">
              <div className="text-[11px] font-semibold mb-1"><span className={roleTint(selected.role)}>{selected.isTeam ? "Ops · " + (selected.teamName || "You") : `${selected.role} · ${selected.sender}`}</span></div>
              <div className="text-sm text-zinc-200 whitespace-pre-wrap">{selected.text}</div>
              <div className="text-[10px] text-zinc-500 mt-1">{fmtTime(selected.ts)}</div>
            </div>
            <Row k="Intent" v={selected.intent || "—"} />
            <Row k="Order" v={selected.orderId ? `#${selected.orderId}` : selected.requestId ? `Req #${selected.requestId}` : "— none —"} />
            <button onClick={() => setReplyTo(selected)} className="text-left text-sm border border-zinc-700 hover:border-blue-500 rounded-lg px-3 py-2 text-zinc-200">↩ Reply to this message</button>
            {selected.ticketId && group && (
              <button onClick={() => onOpenCase(group.id, selected.ticketId!)} className="text-left text-sm border border-zinc-700 hover:border-emerald-500 rounded-lg px-3 py-2 text-zinc-200">◆ Open full case (CRM) <span className="block text-xs text-zinc-500">status, timeline, AI brief</span></button>
            )}
          </div>
        ) : (
          <div className="flex-1 grid place-items-center text-sm text-zinc-500 p-6 text-center">Tap a message to see its context</div>
        )}
      </div>

      {toast && <div className="fixed left-1/2 bottom-6 -translate-x-1/2 bg-zinc-100 text-zinc-900 px-4 py-2 rounded-lg font-medium text-sm shadow-lg z-10">{toast}</div>}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-3 text-sm"><span className="text-zinc-500">{k}</span><span className="text-zinc-200 text-right">{v}</span></div>;
}
