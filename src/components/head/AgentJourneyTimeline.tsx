"use client";

/**
 * Agents › Order: one order's whole story (FR-14.2) — the plan, the
 * checkpoints, every event and every action the guard saw, with the reason.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Checkpoint = { name: string; dueAt: string; dueSource: string; metAt: string | null; status: string };
type Event = { id: string; at: string; kind: string; actor: string; payload: Record<string, unknown> };
type Action = { id: string; createdAt: string; desk: string; action: string; params: Record<string, unknown>; reason: string; level: string; outcome: string; blockedBy: string | null };
type Journey = {
  id: string; orderId: number; orderType: string; stage: string; subStates: string[]; waitingFor: { what: string; from: string } | null;
  dueAt: string | null; dueSource: string | null; nextCheckAt: string | null; health: string; riskLevel: string; riskReasons: string[];
  ownerUserId: number | null; pausedUntil: string | null; attempts: Record<string, number>; brokenPromises: number;
  consoleSnapshot: Record<string, unknown> | null; plan: Array<{ id: string; label: string; state: string; at: string | null }>;
  openedAt: string; closedAt: string | null; closeReason: string | null; checkpoints: Checkpoint[]; events: Event[]; actions: Action[];
};

const LABEL: Record<string, string> = {
  confirmed: "Confirmed", phlebo_assigned: "Phlebo assigned", phlebo_reached: "Phlebo reached", sample_collected: "Collected",
  sample_at_lab: "At lab", report_delivered: "Report", visit_confirmed: "Visit confirmed", patient_visited: "Visited",
  kit_dispatched: "Kit dispatched", kit_delivered: "Kit delivered", kit_picked_up: "Kit picked up", samples_received: "Samples received",
};
const CP_CLS: Record<string, string> = {
  MET: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200", BREACHED: "border-red-500/40 bg-red-500/10 text-red-200",
  PENDING: "border-zinc-700 bg-zinc-900/40 text-zinc-300", WAIVED: "border-zinc-800 bg-zinc-900/20 text-zinc-500",
};
const ACTOR_CLS: Record<string, string> = { CONSOLE: "bg-blue-500/15 text-blue-200", SYSTEM: "bg-zinc-700/40 text-zinc-300", AGENT: "bg-zinc-700/40 text-zinc-200", LAB: "bg-emerald-500/15 text-emerald-200", STORE: "bg-amber-500/15 text-amber-200" };

export function AgentJourneyTimeline({ orderId }: { orderId: number }) {
  const [j, setJ] = useState<Journey | null>(null);
  const [tz, setTz] = useState("Asia/Kolkata");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/agents/journeys/${orderId}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setError(body.error ?? "Could not load this order"); return; }
      setJ(body.journey); if (body.timeZone) setTz(body.timeZone); setError(null);
    } catch { setError("Could not load this order"); }
  }, [orderId]);
  useEffect(() => { void load(); const t = window.setInterval(load, 30_000); return () => window.clearInterval(t); }, [load]);

  const act = async (action: "takeover" | "handback") => {
    setBusy(true);
    try { await fetch(`/api/agents/journeys/${orderId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }); await load(); }
    finally { setBusy(false); }
  };

  const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: tz, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—");
  const time = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" });

  if (error) return <div className="rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm text-red-300">{error} <Link href="/head/agents" className="underline">Back to journeys</Link></div>;
  if (!j) return <div className="p-10 text-center text-sm text-zinc-500">Loading…</div>;
  const snap = j.consoleSnapshot ?? {};
  const taken = j.ownerUserId != null && j.pausedUntil && Date.parse(j.pausedUntil) > Date.now();

  return (
    <div>
      <Link href="/head/agents" className="text-xs text-zinc-500 hover:text-zinc-300">← Journeys</Link>
      <div className="mb-5 mt-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100"><span className="font-mono">#{j.orderId}</span> · {String(snap.patientName ?? "—")}</h1>
          <div className="mt-1 text-sm text-zinc-400">{j.orderType.replace("_", " ").toLowerCase()} · {String(snap.storeName ?? "—")} · {String(snap.labName ?? "no lab")} · slot {when(snap.appointmentTime as string | null)}</div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <Pill cls={j.health === "BREACHED" ? "bg-red-500/15 text-red-300" : j.health === "AT_RISK" ? "bg-amber-500/15 text-amber-300" : "bg-emerald-500/15 text-emerald-300"}>{j.health.replace("_", " ").toLowerCase()}</Pill>
            <Pill cls="bg-zinc-700/40 text-zinc-300">console: {j.stage}</Pill>
            {j.waitingFor && <Pill cls="bg-zinc-700/40 text-zinc-300">waiting for {LABEL[j.waitingFor.what]?.toLowerCase() ?? j.waitingFor.what} · {j.waitingFor.from.toLowerCase()} · due {when(j.dueAt)}</Pill>}
            {j.subStates.map((s) => <Pill key={s} cls="bg-amber-500/15 text-amber-300">{s.replace("_", " ")}</Pill>)}
            {j.closedAt && <Pill cls="bg-zinc-700/40 text-zinc-400">closed · {j.closeReason?.toLowerCase().replace("_", " ")}</Pill>}
          </div>
        </div>
        <div className="flex gap-2">
          <Pill cls="bg-blue-500/15 text-blue-200">owner: {taken ? `person #${j.ownerUserId} until ${when(j.pausedUntil)}` : "agent"}</Pill>
          {!j.closedAt && (taken
            ? <button disabled={busy} onClick={() => act("handback")} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-500">Hand back to the agent</button>
            : <button disabled={busy} onClick={() => act("takeover")} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-500">Take over</button>)}
        </div>
      </div>

      <section className="mb-4 rounded-lg border border-zinc-800 p-4">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-zinc-500">Checkpoints</div>
        <div className="flex flex-wrap gap-2">
          {j.checkpoints.map((c) => (
            <div key={c.name} className={`min-w-[150px] rounded-md border px-3 py-2 text-xs ${CP_CLS[c.status] ?? CP_CLS.PENDING}`}>
              <div className="font-medium">{LABEL[c.name] ?? c.name}</div>
              <div className="opacity-80">{c.status === "MET" ? `met ${when(c.metAt)}` : c.status === "WAIVED" ? "implied" : `due ${when(c.dueAt)}`}{c.dueSource === "RESET" ? " · reset" : ""}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <section className="rounded-lg border border-zinc-800">
          <div className="border-b border-zinc-800 px-4 py-2 text-[11px] uppercase tracking-wide text-zinc-500">Timeline</div>
          <ul className="divide-y divide-zinc-800/80">
            {merge(j).map((row) => (
              <li key={row.key} className="flex gap-3 px-4 py-3 text-sm">
                <span className="w-24 shrink-0 font-mono text-xs text-zinc-500">{time(row.at)}</span>
                <span className={`h-fit shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${ACTOR_CLS[row.actor.split(":")[0]] ?? ACTOR_CLS.AGENT}`}>{row.actor.toLowerCase()}</span>
                <div className="min-w-0 flex-1 text-zinc-200">
                  <div>{row.title}</div>
                  {row.detail && <div className="mt-0.5 text-xs text-zinc-500">{row.detail}</div>}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <aside className="space-y-4">
          <section className="rounded-lg border border-zinc-800 p-4 text-sm">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-zinc-500">Plan</div>
            <ol className="space-y-1.5">
              {j.plan.map((p) => (
                <li key={p.id} className={`flex gap-2 ${p.state === "DONE" ? "text-zinc-500 line-through" : p.state === "NOW" ? "text-zinc-100" : "text-zinc-400"}`}>
                  <span className="w-4 shrink-0">{p.state === "DONE" ? "✓" : p.state === "NOW" ? "▶" : "·"}</span>
                  <span>{p.label}<span className="ml-1 text-xs text-zinc-500">{when(p.at)}</span></span>
                </li>
              ))}
            </ol>
          </section>
          <section className="rounded-lg border border-zinc-800 p-4 text-sm">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-zinc-500">Journey</div>
            <Row k="Next check" v={when(j.nextCheckAt)} />
            <Row k="Asks" v={Object.entries(j.attempts).map(([k, v]) => `${LABEL[k] ?? k} ${v}`).join(", ") || "none"} />
            <Row k="Broken promises" v={String(j.brokenPromises)} />
            <Row k="Opened" v={when(j.openedAt)} />
          </section>
        </aside>
      </div>
    </div>
  );
}

function Pill({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}
function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-3 py-0.5"><span className="text-zinc-500">{k}</span><span className="text-right text-zinc-200">{v}</span></div>;
}

type Line = { key: string; at: string; actor: string; title: string; detail?: string };

/** Events and guarded actions in one list, oldest first. */
function merge(j: Journey): Line[] {
  const lines: Line[] = j.events.map((e) => ({ key: `e${e.id}`, at: e.at, actor: e.actor, ...describeEvent(e) }));
  for (const a of j.actions) {
    const verdict = a.outcome === "RECORDED" ? `would ${a.action} (shadow)` : a.outcome === "REVIEW" ? `${a.action} — waiting for a person` : a.outcome === "EXECUTED" ? a.action : `${a.action} — ${a.outcome.toLowerCase()}${a.blockedBy ? `: ${a.blockedBy}` : ""}`;
    lines.push({ key: `a${a.id}`, at: a.createdAt, actor: "AGENT", title: `${a.desk.toLowerCase()} desk: ${verdict}`, detail: a.reason });
  }
  return lines.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
}

function describeEvent(e: Event): { title: string; detail?: string } {
  const p = e.payload;
  switch (e.kind) {
    case "opened": return { title: "Journey opened", detail: `console ${String(p.orderStatus)}` };
    case "console_change": {
      const changes = (p.changes as string[]) ?? [];
      const to = p.to as { status?: string } | undefined;
      const detail = p.dueAfter ? "checkpoints recomputed from the new slot" : undefined;
      return { title: `Console: ${changes.map((c) => c.toLowerCase().replace("_", " ")).join(", ")}${to?.status ? ` → ${to.status}` : ""}`, detail };
    }
    case "closed": return { title: `Journey closed: ${String(p.reason).toLowerCase().replace("_", " ")}` };
    case "takeover": return { title: `Taken over by ${String(p.name ?? `person #${p.userId}`)}`, detail: "the agent pauses for 2 h after the person's last action" };
    case "handback": return { title: `Handed back to the agent by ${String(p.name ?? `person #${p.userId}`)}` };
    default: return { title: e.kind.replace("_", " "), detail: JSON.stringify(p).slice(0, 200) };
  }
}
