"use client";

/** Agents › Brief and tracking: the Brain's brief, the success metrics against their targets, the 14-day gate, scorecards (DESIGN.md §7.5). */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Metrics = { day: string; orders: number; autonomyRate: number | null; onTimeCollection: number | null; onTimeApi: number | null; onTimeManual: number | null; onTimeReports: number | null; teamMessagesPerOrder: number | null; storeReplyP90Min: number | null; statusLagP90Min: number | null; overrideRate: number | null; repeatAsks: number; advanceWarning: number | null; misses: unknown[]; causes: Array<{ cause: string; count: number }>; tomorrow: { orders: number; atRisk: number; high: number } };
type Brief = { brief: string | null; metrics: Metrics | null; briefAt: string | null; findings: Array<{ kind: string; severity: string; scope: string; text: string }>; findingsAt: string | null; waiting: { proposals: Array<{ id: string; rationale: string; inBounds: boolean; sop: { desk: string } }>; promotions: Array<{ action: string; desk: string; scopeKind: string; scopeKey: string; agreementRate: number | null; sampleSize: number }>; review: number } };
type WeeklyCard = { labId: number; labName: string; desk: string; outcome: string; text: string; numbers: { orders: number; asks: number; answered: number; answeredWithin30: number | null; medianReplyMin: number | null; missedVisits: number; lateCollections: number; reportsDelivered: number; reportTatMedianH: number | null; reportOver24: number | null; reportOver24Count: number; earlyNoPhlebo: number } };
type Weekly = { week: { start: string; end: string; label: string }; ranAt: string | null; cards: WeeklyCard[] };
type Scores = { days: number; labs: Array<{ labId: number; labName: string; tier: string; orders: number; onTimeCollection: number | null; onTimeReports: number | null; promisesKept: number | null; overrideRate: number | null; repeatAsks: number; costPaisePerOrder: number | null }>; stores: Array<{ storeId: number; storeName: string; orders: number; onTimeCollection: number | null; overrideRate: number | null }>; desks: Array<{ desk: string; executed: number; recorded: number; review: number; blocked: number }>; weekly: Weekly | null };

const OUTCOME_LABEL: Record<string, string> = { QUEUED: "sent", ALREADY: "sent", SHADOW: "shadow", SKIPPED_OFF: "desk off", SKIPPED_NOT_CONNECTED: "no group", SKIPPED_EMPTY: "nothing to say", PREVIEW: "not yet sent" };

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

export function AgentBrief() {
  const [b, setB] = useState<Brief | null>(null);
  const [s, setS] = useState<Scores | null>(null);
  const load = useCallback(async () => {
    const [r1, r2] = await Promise.all([fetch("/api/agents/brief?live=1"), fetch("/api/agents/scorecards?days=7")]);
    if (r1.ok) setB(await r1.json()); if (r2.ok) setS(await r2.json());
  }, []);
  useEffect(() => { void load(); }, [load]);
  const m = b?.metrics;

  return (
    <div>
      <div className="mb-4 mt-2"><div className="text-xs text-zinc-500">OpsFlow Agents · SOP owners</div><h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Brief and tracking</h1></div>
      <section className="mb-4 rounded-lg border border-zinc-800 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-base font-semibold text-zinc-100">Brain brief</h2><span className="text-xs text-zinc-500">{b?.briefAt ? `nightly run ${new Date(b.briefAt).toLocaleString("en-IN")}` : "computed now"}</span></div>
        <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-zinc-200">{b?.brief ?? "No data yet. The brief appears once journeys have run for a day."}</pre>
        {b && b.findings.length > 0 && <ul className="mt-3 space-y-1 text-sm">{b.findings.map((f, i) => <li key={i} className={f.severity === "ALERT" ? "text-red-300" : "text-amber-300"}>⚠ {f.text}</li>)}</ul>}
      </section>
      {m && (
        <section className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Autonomy rate" value={pct(m.autonomyRate)} hint="target 95%" />
          <Stat label="Team messages per order" value={m.teamMessagesPerOrder == null ? "—" : m.teamMessagesPerOrder.toFixed(1)} hint="must fall weekly" />
          <Stat label="On-time collection" value={pct(m.onTimeCollection)} hint={`API ${pct(m.onTimeApi)} · manual ${pct(m.onTimeManual)} · targets 90 / 80`} />
          <Stat label="On-time reports" value={pct(m.onTimeReports)} hint="target 90%" />
          <Stat label="Store reply p90" value={m.storeReplyP90Min == null ? "—" : `${Math.round(m.storeReplyP90Min)} min`} hint="target under 5" />
          <Stat label="Status lag p90" value={m.statusLagP90Min == null ? "—" : `${Math.round(m.statusLagP90Min)} min`} hint="target under 10" />
          <Stat label="Override rate" value={pct(m.overrideRate)} hint="target under 2%" />
          <Stat label="Repeat asks" value={String(m.repeatAsks)} hint="target 0" />
          <Stat label="Advance warning" value={pct(m.advanceWarning)} hint="target 80%" />
          <Stat label="Misses" value={String(m.misses.length)} hint={m.causes[0] ? `top: ${m.causes[0].cause}` : ""} />
        </section>
      )}
      {b && (b.waiting.proposals.length > 0 || b.waiting.promotions.length > 0 || b.waiting.review > 0) && (
        <section className="mb-4 rounded-lg border border-zinc-800 p-4">
          <h2 className="text-base font-semibold text-zinc-100">Waiting for you</h2>
          <ul className="mt-2 space-y-1 text-sm text-zinc-300">
            {b.waiting.proposals.map((p) => <li key={p.id}>SOP proposal ({p.sop.desk}): {p.rationale} <Link href="/head/agents/sops" className="text-xs underline">review</Link></li>)}
            {b.waiting.promotions.map((p) => <li key={`${p.action}-${p.scopeKey}`}>Autonomy promotion: {p.action.replace("_", " ")} at {p.scopeKind.toLowerCase()} {p.scopeKey}, {pct(p.agreementRate)} over {p.sampleSize} <Link href="/head/agents/desks" className="text-xs underline">promote</Link></li>)}
            {b.waiting.review > 0 && <li>{b.waiting.review} review items in the <Link href="/head/agents/inbox" className="text-xs underline">inbox</Link></li>}
          </ul>
        </section>
      )}
      {s && (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <section className="overflow-x-auto rounded-lg border border-zinc-800">
            <div className="px-3 py-2 text-base font-semibold text-zinc-100">Scorecards by lab · {s.days} days</div>
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-left text-[11px] uppercase tracking-wide text-zinc-500"><tr><th className="px-3 py-2">Lab</th><th className="px-3 py-2">Orders</th><th className="px-3 py-2">On-time collect</th><th className="px-3 py-2">On-time report</th><th className="px-3 py-2">Promises kept</th><th className="px-3 py-2">Overrides</th><th className="px-3 py-2">Repeat asks</th></tr></thead>
              <tbody className="divide-y divide-zinc-800/80">{s.labs.map((l) => <tr key={l.labId}><td className="px-3 py-2 text-zinc-100">{l.labName} <span className="text-xs text-zinc-500">{l.tier}</span></td><td className="px-3 py-2 text-zinc-300">{l.orders}</td><td className="px-3 py-2 text-zinc-300">{pct(l.onTimeCollection)}</td><td className="px-3 py-2 text-zinc-300">{pct(l.onTimeReports)}</td><td className="px-3 py-2 text-zinc-300">{pct(l.promisesKept)}</td><td className="px-3 py-2 text-zinc-300">{pct(l.overrideRate)}</td><td className="px-3 py-2 text-zinc-300">{l.repeatAsks}</td></tr>)}</tbody>
            </table>
            <table className="w-full border-t border-zinc-800 text-sm">
              <thead className="bg-zinc-900/60 text-left text-[11px] uppercase tracking-wide text-zinc-500"><tr><th className="px-3 py-2">Store</th><th className="px-3 py-2">Orders</th><th className="px-3 py-2">On-time collect</th><th className="px-3 py-2">Overrides</th></tr></thead>
              <tbody className="divide-y divide-zinc-800/80">{s.stores.map((x) => <tr key={x.storeId}><td className="px-3 py-2 text-zinc-100">{x.storeName}</td><td className="px-3 py-2 text-zinc-300">{x.orders}</td><td className="px-3 py-2 text-zinc-300">{pct(x.onTimeCollection)}</td><td className="px-3 py-2 text-zinc-300">{pct(x.overrideRate)}</td></tr>)}</tbody>
            </table>
          </section>
          <section className="rounded-lg border border-zinc-800 p-3 text-sm">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-zinc-500">Desks · {s.days} days</div>
            {s.desks.map((d) => <div key={d.desk} className="flex justify-between border-b border-zinc-800/60 py-1 text-zinc-300"><span>{d.desk.toLowerCase()}</span><span className="text-xs">{d.executed} done · {d.review} review · {d.recorded} shadow · {d.blocked} blocked</span></div>)}
          </section>
        </div>
      )}
      {s?.weekly && (
        <section className="mt-4 overflow-x-auto rounded-lg border border-zinc-800">
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
            <div className="text-base font-semibold text-zinc-100">What the labs saw · week of {s.weekly.week.label}</div>
            <span className="text-xs text-zinc-500">{s.weekly.ranAt ? `sent Monday ${new Date(s.weekly.ranAt).toLocaleString("en-IN")}` : "computed now · goes out Monday 10:30"}</span>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-left text-[11px] uppercase tracking-wide text-zinc-500"><tr><th className="px-3 py-2">Lab</th><th className="px-3 py-2">Orders</th><th className="px-3 py-2">Asks ≤ 30 min</th><th className="px-3 py-2">Median reply</th><th className="px-3 py-2">Visits missed</th><th className="px-3 py-2">Collected 2 h late</th><th className="px-3 py-2">Report TAT</th><th className="px-3 py-2">Over 24 h</th><th className="px-3 py-2">Message</th></tr></thead>
            <tbody className="divide-y divide-zinc-800/80">
              {s.weekly.cards.map((c) => (
                <tr key={c.labId}>
                  <td className="px-3 py-2 text-zinc-100">{c.labName} <span className="text-xs text-zinc-500">{OUTCOME_LABEL[c.outcome] ?? c.outcome.toLowerCase()}</span></td>
                  <td className="px-3 py-2 text-zinc-300">{c.numbers.orders}</td>
                  <td className="px-3 py-2 text-zinc-300">{c.numbers.asks ? `${pct(c.numbers.answeredWithin30)} of ${c.numbers.asks}` : "—"}</td>
                  <td className="px-3 py-2 text-zinc-300">{c.numbers.medianReplyMin == null ? "—" : `${Math.round(c.numbers.medianReplyMin)} min`}</td>
                  <td className="px-3 py-2 text-zinc-300">{c.numbers.missedVisits}</td>
                  <td className="px-3 py-2 text-zinc-300">{c.numbers.lateCollections}</td>
                  <td className="px-3 py-2 text-zinc-300">{c.numbers.reportTatMedianH == null ? "—" : `${c.numbers.reportTatMedianH < 10 ? c.numbers.reportTatMedianH.toFixed(1) : Math.round(c.numbers.reportTatMedianH)} h`}</td>
                  <td className="px-3 py-2 text-zinc-300">{c.numbers.reportOver24 == null ? "—" : `${pct(c.numbers.reportOver24)} (${c.numbers.reportOver24Count})`}</td>
                  <td className="px-3 py-2"><details><summary className="cursor-pointer text-xs text-zinc-400">show</summary><pre className="mt-1 whitespace-pre-wrap font-sans text-xs text-zinc-300">{c.text.replace("{{coordinator}}", "@coordinator")}</pre></details></td>
                </tr>
              ))}
              {s.weekly.cards.length === 0 && <tr><td className="px-3 py-3 text-zinc-500" colSpan={9}>No labs in the directory yet.</td></tr>}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
function Stat({ label, value, hint }: { label: string; value: string; hint: string }) { return <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2"><div className="text-xs text-zinc-500">{label}</div><div className="mt-0.5 text-xl font-semibold text-zinc-100">{value}</div><div className="text-[11px] text-zinc-500">{hint}</div></div>; }
