"use client";

/** Agents › SOP library: each desk's SOP as a document, versions with diffs, proposals with replay, approve / reject / roll back (FR-13.3, FR-5.3). */
import { useCallback, useEffect, useState } from "react";

type Version = { id: string; version: number; status: string; author: string; summary: string | null; approvedBy?: number | null; approvedAt: string | null; createdAt: string; body?: unknown; changedFromPrevious?: string[] };
type Proposal = { id: string; rationale: string; inBounds: boolean; decision: string | null; replay: Record<string, unknown> | null; evidence: Record<string, unknown>; diff: { paths?: string[]; summary?: string }; createdAt: string };
type Detail = { desk: string; live: Version | null; versions: Version[]; proposals: Proposal[] };

export function AgentSopLibrary() {
  const [desks, setDesks] = useState<Array<{ desk: string; live: Version | null; pending: Array<{ id: string }> }>>([]);
  const [desk, setDesk] = useState("LAB");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);

  const load = useCallback(async () => {
    const [l, d] = await Promise.all([fetch("/api/agents/sops"), fetch(`/api/agents/sops/${desk}`)]);
    const [lb, db] = await Promise.all([l.json(), d.json()]);
    if (l.ok) setDesks(lb.sops); if (d.ok) setDetail(db);
  }, [desk]);
  useEffect(() => { void load(); }, [load]);

  const act = async (body: Record<string, unknown>) => {
    const r = await fetch(`/api/agents/sops/${desk}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const b = await r.json().catch(() => ({}));
    setNote(r.ok ? `Done${b.version ? `: now v${b.version}` : ""}` : b.error ?? "Failed");
    await load();
  };
  const params = (detail?.live?.body as { params?: Record<string, unknown>; title?: string; description?: string; overrides?: unknown[]; bounds?: Record<string, { min: number; max: number }>; provenance?: Record<string, string> } | undefined);

  return (
    <div>
      <div className="mb-4 mt-2 flex flex-wrap items-end justify-between gap-3">
        <div><div className="text-xs text-zinc-500">OpsFlow Agents · SOP owners</div><h1 className="text-2xl font-semibold tracking-tight text-zinc-100">SOP library</h1></div>
        <div className="flex gap-1 text-xs">{desks.map((d) => <button key={d.desk} onClick={() => setDesk(d.desk)} className={`rounded-full border px-3 py-1.5 ${desk === d.desk ? "border-zinc-200 bg-zinc-200 text-zinc-900" : "border-zinc-700 text-zinc-300"}`}>{d.desk} desk{d.live ? ` · v${d.live.version}` : ""}{d.pending.length ? ` · ${d.pending.length} proposal${d.pending.length === 1 ? "" : "s"}` : ""}</button>)}</div>
      </div>
      {note && <div className="mb-3 rounded-md border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-200">{note}</div>}
      {detail && (
        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <section className="rounded-lg border border-zinc-800 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-lg font-semibold text-zinc-100">{params?.title ?? `${detail.desk} desk`}</h2><span className="text-xs text-zinc-500">live v{detail.live?.version} · {detail.live?.author.toLowerCase()} · {detail.live?.approvedAt ? new Date(detail.live.approvedAt).toLocaleDateString("en-IN") : ""}</span></div>
            <p className="mt-1 text-sm text-zinc-400">{params?.description}</p>
            {detail.live && detail.live.approvedBy == null && (
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-200">
                <span>Baseline, not yet reviewed. Read it below; approving makes it the SOP the agent follows for this desk.</span>
                <button onClick={() => act({ action: "approve_live" })} className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900">Approve this SOP</button>
              </div>
            )}
            {params?.params && (
              <div className="mt-4 space-y-3 text-sm">
                <Block title="Ladder" text={((params.params.ladder as string[]) ?? []).map((r) => r.replace("_", " ")).join(" → ")} why={params.provenance?.ladder} />
                <Block title="Timings" text={`rung gap ${String(params.params.rungGapMin)} min · hold after an answer ${String(params.params.answerHoldMin)} min · default promise ${String(params.params.defaultPromiseMin)} min · promise grace ${String(params.params.promiseGraceMin)} min · ${String(params.params.brokenPromisesSkip)} broken promises skip a rung`} />
                <Block title="Working hours" text={`${(params.params.workingHours as { start: string; end: string })?.start}–${(params.params.workingHours as { start: string; end: string })?.end}; night floor ${(params.params.nightFloor as { start: string; end: string })?.start}–${(params.params.nightFloor as { start: string; end: string })?.end} (urgent asks exempt). Slot-tied asks follow the order's checkpoint.`} />
                {!!params.params.asks && Object.keys(params.params.asks as object).length > 0 && <Block title="Asks" text={Object.entries(params.params.asks as Record<string, { intent: string; graceMin: number; urgentWithinMin: number; nightBefore: boolean }>).map(([k, v]) => `${k.replace("_", " ")}: ${v.intent.toLowerCase()} ask, up to ${Math.round(v.graceMin / 60)} h after due${v.urgentWithinMin ? `, urgent within ${v.urgentWithinMin} min` : ""}${v.nightBefore ? ", night before when at risk" : ""}`).join("\n")} why={params.provenance?.["asks.confirmed"]} />}
                {!!params.params.evidenceBar && Object.keys(params.params.evidenceBar as object).length > 0 && <Block title="Evidence bar" text={Object.entries(params.params.evidenceBar as Record<string, { sources: string[]; minConfidence: number; needsOrderNamed: boolean; alwaysSuggest?: boolean }>).map(([k, v]) => `${k.replace("_", " ").toLowerCase()}: ${v.sources.join(", ")} at ≥ ${v.minConfidence}${v.needsOrderNamed ? ", order named" : ""}${v.alwaysSuggest ? " · always suggest" : ""}`).join("\n")} why={params.provenance?.evidenceBar} />}
                {!!params.params.handoffs && (params.params.handoffs as unknown[]).length > 0 && <Block title="Hand-offs" text={(params.params.handoffs as Array<{ onFact: string; do: string; template?: string; taskType?: string; transition?: string }>).map((h) => `${h.onFact.replace("_", " ")} → ${h.do.replace("_", " ")}${h.template ? ` (${h.template})` : h.taskType ? ` (${h.taskType})` : h.transition ? ` (${h.transition})` : ""}`).join("\n")} why={params.provenance?.handoffs} />}
                {!!params.params.intents && Object.keys(params.params.intents as object).length > 0 && <Block title="Store intents" text={Object.entries(params.params.intents as Record<string, { do: string; taskType?: string }>).map(([k, v]) => `${k.replace("_", " ")}: ${v.do.replace("_", " ")}${v.taskType ? ` (${v.taskType})` : ""}`).join("\n")} why={params.provenance?.intents} />}
                <Block title="Allowed actions (menu)" text={((params.params.menu as string[]) ?? []).map((m) => m.replace("_", " ")).join(", ")} />
                {!!params.overrides && (params.overrides as unknown[]).length > 0 && <Block title="Overrides" text={(params.overrides as Array<{ when: Record<string, unknown>; set: Record<string, unknown> }>).map((o) => `${Object.entries(o.when).map(([k, v]) => `${k} ${v}`).join(", ")}: ${JSON.stringify(o.set).slice(0, 160)}`).join("\n")} />}
                {!!params.bounds && <Block title="What the Brain may change on its own" text={Object.entries(params.bounds).map(([k, v]) => `${k.replace("params.", "")}: ${v.min}–${v.max}`).join(" · ")} />}
              </div>
            )}
            <button onClick={() => setShowJson(!showJson)} className="mt-4 text-xs text-zinc-500 underline">{showJson ? "Hide" : "Show"} the SOP as JSON</button>
            {showJson && <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-zinc-950 p-3 text-[11px] text-zinc-300">{JSON.stringify(detail.live?.body, null, 2)}</pre>}
          </section>
          <aside className="space-y-4">
            <section className="rounded-lg border border-zinc-800 p-3">
              <div className="mb-2 text-[11px] uppercase tracking-wide text-zinc-500">Proposals</div>
              {detail.proposals.filter((p) => !p.decision).length === 0 && <div className="text-sm text-zinc-500">None waiting.</div>}
              {detail.proposals.filter((p) => !p.decision).map((p) => (
                <div key={p.id} className="mb-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-3 text-sm">
                  <div className="text-zinc-100">{p.rationale}</div>
                  <div className="mt-1 text-xs text-zinc-500">{p.diff?.paths?.join(", ")} · {p.inBounds ? "inside bounds" : "needs approval"}</div>
                  {p.replay && !("error" in p.replay) && <div className="mt-1 text-xs text-zinc-400">Replay {String(p.replay.journeys)} orders: {String(p.replay.changed)} change · asks move {String(p.replay.asksEarlierMin)} min earlier · +{String(p.replay.asksAdded)} asks · +{String(p.replay.tasksAdded)} tasks · labs: {((p.replay.labsAffected as string[]) ?? []).join(", ") || "none"}</div>}
                  <div className="mt-2 flex gap-2"><button onClick={() => act({ action: "approve", proposalId: p.id })} className="rounded-md bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-900">Approve</button><button onClick={() => act({ action: "reject", proposalId: p.id })} className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200">Reject</button></div>
                </div>
              ))}
            </section>
            <section className="rounded-lg border border-zinc-800 p-3">
              <div className="mb-2 text-[11px] uppercase tracking-wide text-zinc-500">Versions</div>
              <ul className="space-y-2 text-sm">
                {detail.versions.map((v) => (
                  <li key={v.id} className="flex items-start justify-between gap-2">
                    <div><span className={v.status === "LIVE" ? "font-semibold text-zinc-100" : "text-zinc-400"}>v{v.version}</span> <span className="text-xs text-zinc-500">{v.author.toLowerCase()} · {new Date(v.createdAt).toLocaleDateString("en-IN")}</span><div className="text-xs text-zinc-500">{v.summary}{v.changedFromPrevious?.length ? ` · changed: ${v.changedFromPrevious.slice(0, 3).join(", ")}` : ""}</div></div>
                    {v.status !== "LIVE" && <button onClick={() => act({ action: "rollback", versionId: v.id })} className="shrink-0 rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300">Roll back</button>}
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}

function Block({ title, text, why }: { title: string; text: string; why?: string }) {
  return <div><div className="text-[11px] uppercase tracking-wide text-zinc-500">{title}</div><div className="mt-0.5 whitespace-pre-line text-zinc-200">{text}</div>{why && <div className="mt-0.5 text-xs text-zinc-500">From: {why}</div>}</div>;
}
