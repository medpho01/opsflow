"use client";

/** Agents › Inbox: what only a person can decide (DESIGN.md §7.1, FR-10.4). */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Item = { id: string; kind: "REVIEW" | "TASK" | "FYI"; subkind: string; orderId: number | null; title: string; what: string; action: string; evidence: Array<{ at?: string; text: string }>; dueAt: string | null; minutesToBreach: number | null; weight: number; order: { patientName: string | null; labName: string | null; storeName: string | null; appointmentTime: string | null; health: string | null }; proposal?: Record<string, unknown>; taskId?: number; assignee?: string | null; consoleUrl?: string | null };
type Data = { items: Item[]; counts: { review: number; tasks: number; fyi: number; breachSoon: number }; timeZone: string };

const KIND: Record<string, string> = { REVIEW: "bg-amber-500/15 text-amber-300", TASK: "bg-blue-500/15 text-blue-200", FYI: "bg-zinc-700/40 text-zinc-300" };

export function AgentInbox() {
  const [data, setData] = useState<Data | null>(null);
  const [filter, setFilter] = useState<"ALL" | "REVIEW" | "TASK" | "FYI">("ALL");
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/agents/inbox"); const b = await r.json().catch(() => ({}));
    if (r.ok) setData(b); else setNote(b.error ?? "Could not load the inbox");
  }, []);
  useEffect(() => { void load(); const t = window.setInterval(load, 30_000); return () => window.clearInterval(t); }, [load]);

  const items = (data?.items ?? []).filter((i) => filter === "ALL" || i.kind === filter);
  const current = items.find((i) => i.id === sel) ?? items[0] ?? null;
  const tz = data?.timeZone ?? "Asia/Kolkata";
  const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" }) : "—");

  const decide = async (item: Item, decision: "APPROVED" | "REJECTED") => {
    setBusy(true); setNote(null);
    try {
      const r = await fetch(`/api/agents/review/${item.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) });
      const b = await r.json().catch(() => ({}));
      setNote(r.ok ? `${decision === "APPROVED" ? "Approved" : "Rejected"}${b.result?.note ? `: ${b.result.note}` : ""}` : b.error ?? "Failed");
      await load();
    } finally { setBusy(false); }
  };
  const completeTask = async (item: Item) => {
    if (!item.taskId) return;
    setBusy(true); setNote(null);
    try {
      const r = await fetch(`/api/tasks/${item.taskId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "COMPLETED" }) });
      setNote(r.ok ? "Marked done. The agent will check the console shows the change." : "Could not update the task");
      await load();
    } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="mb-4 mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs text-zinc-500">OpsFlow Agents · ops executives</div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Exception inbox</h1>
          <div className="mt-1 text-sm text-zinc-400">Each card: what happened, the evidence, the one action. Sorted by time to breach × store weight.</div>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {(["ALL", "REVIEW", "TASK", "FYI"] as const).map((k) => (
            <button key={k} onClick={() => setFilter(k)} className={`rounded-full border px-3 py-1.5 ${filter === k ? "border-zinc-200 bg-zinc-200 text-zinc-900" : "border-zinc-700 text-zinc-300 hover:border-zinc-500"}`}>
              {k === "ALL" ? `All · ${data?.items.length ?? 0}` : k === "REVIEW" ? `Review · ${data?.counts.review ?? 0}` : k === "TASK" ? `Tasks · ${data?.counts.tasks ?? 0}` : `FYI · ${data?.counts.fyi ?? 0}`}
            </button>
          ))}
          {!!data?.counts.breachSoon && <span className="rounded-full bg-red-500/15 px-3 py-1.5 font-medium text-red-300">{data.counts.breachSoon} breach within 30 min</span>}
        </div>
      </div>
      {note && <div className="mb-3 rounded-md border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-200">{note}</div>}
      {data && items.length === 0 && <div className="rounded-lg border border-zinc-800 p-10 text-center text-sm text-zinc-500">Nothing needs a person right now.</div>}
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <ul className="space-y-2">
          {items.map((i) => (
            <li key={i.id}>
              <button onClick={() => setSel(i.id)} className={`w-full rounded-lg border p-3 text-left ${current?.id === i.id ? "border-zinc-300 bg-zinc-900/60" : "border-zinc-800 hover:border-zinc-600"}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2"><span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${KIND[i.kind]}`}>{i.kind === "REVIEW" ? i.subkind.replace("_", " ") : i.kind === "TASK" ? "task" : "FYI"}</span><span className="text-sm font-medium text-zinc-100">{i.title}</span></div>
                  <span className={`text-xs font-medium ${i.minutesToBreach != null && i.minutesToBreach < 30 ? "text-red-400" : "text-zinc-500"}`}>{i.minutesToBreach == null ? "" : i.minutesToBreach < 0 ? `${-i.minutesToBreach} min over` : `${i.minutesToBreach} min`}</span>
                </div>
                <div className="mt-1 text-xs text-zinc-500">{[i.order.storeName, i.order.labName].filter(Boolean).join(" · ")}{i.weight > 1 ? " · key account" : ""}</div>
                <div className="mt-1 text-sm text-zinc-300">{i.what}</div>
              </button>
            </li>
          ))}
        </ul>
        {current && (
          <section className="h-fit rounded-lg border border-zinc-800 p-4">
            <div className="flex flex-wrap items-center gap-2"><span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${KIND[current.kind]}`}>{current.kind.toLowerCase()}</span><span className="font-mono text-xs text-zinc-500">{current.order.storeName ?? "—"} · {current.order.labName ?? "—"} · slot {when(current.order.appointmentTime)}</span></div>
            <h2 className="mt-2 text-lg font-semibold text-zinc-100">{current.title}</h2>
            <div className="mt-3 text-[11px] uppercase tracking-wide text-zinc-500">What happened</div>
            <ul className="mt-1 space-y-1 text-sm text-zinc-300">
              <li>{current.what}</li>
              {current.evidence.map((e, i) => <li key={i} className="flex gap-2"><span className="w-20 shrink-0 font-mono text-xs text-zinc-500">{e.at ? when(e.at) : ""}</span><span>{e.text}</span></li>)}
            </ul>
            <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">{current.kind === "TASK" ? "Do this" : current.kind === "REVIEW" ? "Proposed" : "What the agent did"}</div>
              <div className="mt-1 whitespace-pre-line text-sm text-zinc-100">{current.action}</div>
              {current.kind === "REVIEW" && current.subkind === "store_warning" && <div className="mt-2 text-xs text-zinc-400">Reasons: {((current.proposal?.reasons as string[]) ?? []).join(", ")}</div>}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {current.kind === "REVIEW" && <>
                <button disabled={busy} onClick={() => decide(current, "APPROVED")} className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50">Approve</button>
                <button disabled={busy} onClick={() => decide(current, "REJECTED")} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 disabled:opacity-50">Reject</button>
              </>}
              {current.kind === "TASK" && <>
                {current.consoleUrl && <a href={current.consoleUrl} target="_blank" rel="noreferrer" className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white">Open in console</a>}
                <button disabled={busy} onClick={() => completeTask(current)} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 disabled:opacity-50">Done</button>
                {current.assignee && <span className="self-center text-xs text-zinc-500">assigned to {current.assignee}</span>}
              </>}
              {current.orderId != null && <Link href={`/head/agents/orders/${current.orderId}`} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500">Open timeline</Link>}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
