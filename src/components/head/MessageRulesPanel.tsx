"use client";

/**
 * Message rules — every message a lab gets, and when.
 *
 * Two kinds: per-order rules (a message about one order when its condition
 * is met: the new-order message, reminders, phlebo checks, the status check,
 * report chasing…) and daily summaries (one message per lab at a time of day
 * listing the orders that match). Every rule is checked each minute against
 * every open order's current state, so an edit applies to all open orders
 * straight away — limited by its catch-up window. See lib/provider-rules.
 */

import { FormEvent, useCallback, useEffect, useState } from "react";

type Condition = {
  statusIn: string[];
  statusNotIn?: string[];
  minutesSinceCreated?: number;
  minutesSinceStatusUpdated?: number;
  minutesBeforeAppointment?: number;
  minutesAfterAppointment?: number;
  metadataConditions?: unknown[];
};
type FactCondition = { kind: string; present: boolean };

type Rule = {
  id: string;
  builtInKey: string | null;
  name: string;
  description: string | null;
  isActive: boolean;
  kind: "ORDER" | "SUMMARY";
  allowedLabIds: number[];
  excludedLabIds: number[];
  allowedOrderTypes: string[];
  integrationTypes: string[];
  triggerCondition: Condition;
  conversationStatusIn: string[];
  factConditions: FactCondition[];
  introduces: boolean;
  onlyIfIntroduced: boolean;
  onlyNewSinceLabConfigured: boolean;
  notAfterAppointment: boolean;
  stopOnAnswer: boolean;
  action: "SEND" | "ESCALATE";
  recipient: "LAB" | "MANAGER";
  templateKey: string;
  pollKey: string | null;
  priority: number;
  repeatEveryMinutes: number | null;
  maxSends: number;
  catchUpMinutes: number;
  sendWindowStartHour: number | null;
  sendWindowEndHour: number | null;
  milestoneLabel: string | null;
  summaryHour: number | null;
  summaryMinute: number | null;
  summaryScope: "APPOINTMENT_TOMORROW" | "APPOINTMENT_TODAY" | "OPEN" | null;
  skipWhenEmpty: boolean;
  stats?: Record<string, number>;
};

type Option = { key: string; name: string; isActive?: boolean };
type Lab = { labId: number; labName: string };
type Preview = { checked: number; sendNow: number; tooLate: number; later: number; done: number; summaryLabs: number; summaryOrders: number };

const ORDER_STATUSES = [
  "PENDING", "CREATED", "ORDER_SCHEDULED", "RESCHEDULED", "PHLEBO_ASSIGNED", "KIT_DISPATCHED",
  "PATIENT_VISITED", "SAMPLE_COLLECTED", "SAMPLE_DELIVERED", "SAMPLE_PROCESSED",
];
const ORDER_TYPES = ["HOME_SAMPLE", "CENTER_VISIT", "CAMP", "KIT_BASED"];
const FACTS: Array<{ kind: string; label: string }> = [
  { kind: "eta", label: "an ETA" },
  { kind: "phlebo_name", label: "the phlebo's name" },
  { kind: "phlebo_phone", label: "the phlebo's number" },
  { kind: "sample_collected", label: "sample collected" },
  { kind: "report_shared", label: "report shared" },
  { kind: "patient_unavailable", label: "patient not available" },
  { kind: "new_appointment_time", label: "a new time" },
  { kind: "cannot_fulfil", label: "can't do it" },
  { kind: "delay_reason", label: "a delay" },
];
const SCOPES: Record<string, string> = {
  APPOINTMENT_TOMORROW: "orders with an appointment tomorrow",
  APPOINTMENT_TODAY: "orders with an appointment today",
  OPEN: "open orders",
};

type Timing = "created" | "beforeAppointment" | "afterAppointment" | "statusChanged";
const TIMING_FIELD: Record<Timing, keyof Condition> = {
  created: "minutesSinceCreated",
  beforeAppointment: "minutesBeforeAppointment",
  afterAppointment: "minutesAfterAppointment",
  statusChanged: "minutesSinceStatusUpdated",
};
const TIMING_LABEL: Record<Timing, string> = {
  created: "after the order is placed",
  beforeAppointment: "before the appointment",
  afterAppointment: "after the appointment",
  statusChanged: "after the status last changed",
};

const pretty = (status: string) => status.replaceAll("_", " ").toLowerCase();

function timingOf(cond: Condition): { timing: Timing; minutes: number } | null {
  for (const timing of Object.keys(TIMING_FIELD) as Timing[]) {
    const value = cond[TIMING_FIELD[timing]];
    if (typeof value === "number") return { timing, minutes: value };
  }
  return null;
}

function duration(minutes: number): string {
  if (minutes === 0) return "right away";
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

function statusText(cond: Condition): string {
  const parts: string[] = [];
  if (cond.statusIn?.length) parts.push(`is ${cond.statusIn.map(pretty).join(" / ")}`);
  if (cond.statusNotIn?.length) parts.push(`is not ${cond.statusNotIn.map(pretty).join(" / ")}`);
  return parts.length ? ` while the order ${parts.join(" and ")}` : "";
}

function describe(rule: Rule, labs: Lab[], templates: Option[]): string {
  const template = templates.find((t) => t.key === rule.templateKey)?.name ?? rule.templateKey;
  const to = rule.recipient === "MANAGER" ? "the lab manager" : "the lab";
  const scope = rule.allowedLabIds.length > 0
    ? ` · only ${rule.allowedLabIds.map((id) => labs.find((l) => l.labId === id)?.labName ?? `lab ${id}`).join(", ")}` : "";
  if (rule.kind === "SUMMARY") {
    const at = `${String(rule.summaryHour ?? 0).padStart(2, "0")}:${String(rule.summaryMinute ?? 0).padStart(2, "0")}`;
    return `Every day at ${at}: “${template}” listing ${SCOPES[rule.summaryScope ?? "OPEN"]}${statusText(rule.triggerCondition)}${scope}`;
  }
  const timing = timingOf(rule.triggerCondition);
  const when = timing ? `${duration(timing.minutes)} ${timing.minutes === 0 && timing.timing === "created" ? "when the order is placed" : TIMING_LABEL[timing.timing]}` : "When the status changes";
  const repeat = rule.repeatEveryMinutes ? `, then every ${duration(rule.repeatEveryMinutes)} up to ${rule.maxSends} times` : "";
  const stops = rule.factConditions.filter((f) => !f.present).map((f) => FACTS.find((x) => x.kind === f.kind)?.label ?? f.kind);
  return `${when.charAt(0).toUpperCase()}${when.slice(1)}${statusText(rule.triggerCondition)}: “${template}” to ${to}${repeat}${stops.length ? ` · stops once the lab reports ${stops.join(" or ")}` : ""}${scope}`;
}

const EMPTY_RULE: Rule = {
  id: "", builtInKey: null, name: "", description: null, isActive: false, kind: "ORDER",
  allowedLabIds: [], excludedLabIds: [], allowedOrderTypes: [], integrationTypes: ["NON_API"],
  triggerCondition: { statusIn: ["PENDING", "CREATED"], minutesSinceCreated: 60 },
  conversationStatusIn: [], factConditions: [], introduces: false, onlyIfIntroduced: true, onlyNewSinceLabConfigured: false,
  notAfterAppointment: false, stopOnAnswer: true, action: "SEND", recipient: "LAB", templateKey: "NON_API_REMINDER", pollKey: null,
  priority: 4, repeatEveryMinutes: null, maxSends: 1, catchUpMinutes: 30, sendWindowStartHour: null, sendWindowEndHour: null,
  milestoneLabel: null, summaryHour: null, summaryMinute: null, summaryScope: null, skipWhenEmpty: true,
};
const EMPTY_SUMMARY: Rule = {
  ...EMPTY_RULE, kind: "SUMMARY", onlyIfIntroduced: false, integrationTypes: [], catchUpMinutes: 180,
  triggerCondition: { statusIn: [] }, templateKey: "PROVIDER_DAILY_DIGEST", summaryHour: 19, summaryMinute: 0, summaryScope: "APPOINTMENT_TOMORROW",
};

/** The editable fields, as the API takes them. */
function payload(rule: Rule) {
  const { id: _id, builtInKey: _b, stats: _s, ...rest } = rule;
  void _id; void _b; void _s;
  return rest;
}

export function MessageRulesPanel() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [templates, setTemplates] = useState<Option[]>([]);
  const [polls, setPolls] = useState<Option[]>([]);
  const [labs, setLabs] = useState<Lab[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Rule | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const flash = (text: string) => { setToast(text); window.setTimeout(() => setToast(null), 3000); };

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/message-rules");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load message rules");
      setRules(data.rules); setTemplates(data.templates); setPolls(data.polls); setLabs(data.labs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load message rules");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggle(rule: Rule) {
    const response = await fetch(`/api/message-rules/${rule.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: !rule.isActive }),
    });
    if (!response.ok) return flash("Could not update the rule");
    flash(rule.isActive ? `${rule.name} paused` : `${rule.name} is on — applies from the next minute`);
    void load();
  }

  async function remove(rule: Rule) {
    if (!window.confirm(`Delete “${rule.name}”? Messages it already sent stay in each order's history.`)) return;
    const response = await fetch(`/api/message-rules/${rule.id}`, { method: "DELETE" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return flash(data.error ?? "Could not delete the rule");
    void load();
  }

  async function runPreview(rule: Rule) {
    setPreview(null); setFormError(null);
    const response = await fetch("/api/message-rules/preview", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload(rule), id: rule.id || undefined }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return setFormError(data.details ? Object.values(data.details).join(" · ") : data.error ?? "Could not preview");
    setPreview(data.preview);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setSaving(true); setFormError(null);
    const response = await fetch(draft.id ? `/api/message-rules/${draft.id}` : "/api/message-rules", {
      method: draft.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload(draft)),
    });
    const data = await response.json().catch(() => ({}));
    setSaving(false);
    if (!response.ok) return setFormError(data.details ? Object.values(data.details).join(" · ") : data.error ?? "Could not save");
    setDraft(null); setPreview(null);
    flash(draft.id ? "Saved — applies to open orders from the next minute" : "Rule created (paused — preview it, then switch it on)");
    void load();
  }

  const open = (rule: Rule) => { setDraft(rule); setPreview(null); setFormError(null); };
  const orderRules = rules.filter((rule) => rule.kind === "ORDER");
  const summaryRules = rules.filter((rule) => rule.kind === "SUMMARY");

  return (
    <div>
      <div className="mb-5">
        <div className="text-xs text-zinc-500 mb-1">Provider communication</div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Message rules</h1>
        <p className="text-sm text-zinc-400 mt-1 max-w-3xl">
          Every message a lab gets, and when. Each rule is checked every minute against every open order&apos;s current
          status in LabStack and what the lab has replied, so a change here applies to all open orders straight away.
          Messages always go to the lab on the order.
        </p>
      </div>

      {loading ? <div className="p-10 text-center text-sm text-zinc-500">Loading rules…</div>
        : error ? <div className="p-10 text-center text-sm text-rose-300">{error} <button onClick={() => void load()} className="underline">Try again</button></div>
        : (
          <>
            <SectionHeader title="About each order" hint="Sent when an order meets the condition." onNew={() => open({ ...EMPTY_RULE })} />
            <RuleList rules={orderRules} labs={labs} templates={templates} onEdit={open} onToggle={toggle} onDelete={remove} />
            <SectionHeader title="Daily summaries" hint="One message per lab at a time of day." onNew={() => open({ ...EMPTY_SUMMARY })} />
            <RuleList rules={summaryRules} labs={labs} templates={templates} onEdit={open} onToggle={toggle} onDelete={remove} />
          </>
        )}

      {draft && (
        <RuleEditor
          draft={draft} setDraft={setDraft} templates={templates} polls={polls} labs={labs}
          saving={saving} error={formError} preview={preview}
          onPreview={() => void runPreview(draft)} onSave={save} onClose={() => { setDraft(null); setPreview(null); }}
        />
      )}
      {toast && <div className="fixed z-[60] left-1/2 bottom-6 -translate-x-1/2 rounded-lg bg-zinc-100 text-zinc-950 px-4 py-2 text-sm font-medium shadow-lg">{toast}</div>}
    </div>
  );
}

function SectionHeader({ title, hint, onNew }: { title: string; hint: string; onNew: () => void }) {
  return (
    <div className="mb-2 mt-6 flex items-center justify-between first:mt-0">
      <div><span className="text-xs font-medium text-zinc-300">{title}</span><span className="ml-2 text-[11px] text-zinc-500">{hint}</span></div>
      <button onClick={onNew} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500">+ New</button>
    </div>
  );
}

function RuleList({ rules, labs, templates, onEdit, onToggle, onDelete }: {
  rules: Rule[]; labs: Lab[]; templates: Option[];
  onEdit: (rule: Rule) => void; onToggle: (rule: Rule) => void; onDelete: (rule: Rule) => void;
}) {
  if (rules.length === 0) return <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">No rules here yet.</p>;
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800">
      {rules.map((rule) => {
        const s = rule.stats ?? {};
        const sent = (s.sent ?? 0) + (s.imported ?? 0);
        return (
          <div key={rule.id} className={`flex items-start gap-3 border-b border-zinc-800/60 px-4 py-3 last:border-b-0 ${rule.isActive ? "" : "opacity-55"}`}>
            <button
              type="button" role="switch" aria-checked={rule.isActive} aria-label={`${rule.isActive ? "Pause" : "Resume"} ${rule.name}`}
              onClick={() => onToggle(rule)}
              className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full ${rule.isActive ? "bg-emerald-500" : "bg-zinc-700"}`}
            >
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition ${rule.isActive ? "translate-x-[1.15rem]" : "translate-x-1"}`} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-zinc-100">{rule.name}</span>
                {rule.builtInKey && <span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">built-in</span>}
                {rule.pollKey && <span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">with poll</span>}
                {rule.action === "ESCALATE" && <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">escalation</span>}
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-400">{describe(rule, labs, templates)}</div>
              <div className="mt-1 text-[11px] text-zinc-500">
                Sent {sent}
                {(s.answered ?? 0) > 0 && <> · {s.answered} answered</>}
                {(s.missed ?? 0) > 0 && <> · {s.missed} too late to send</>}
                {(s.skipped ?? 0) > 0 && <> · {s.skipped} skipped</>}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <button onClick={() => onEdit(rule)} className="text-xs font-medium text-blue-400 hover:text-blue-300">Edit</button>
              {!rule.builtInKey && <button onClick={() => onDelete(rule)} className="text-xs text-zinc-500 hover:text-rose-400">Delete</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RuleEditor({ draft, setDraft, templates, polls, labs, saving, error, preview, onPreview, onSave, onClose }: {
  draft: Rule; setDraft: (rule: Rule) => void; templates: Option[]; polls: Option[]; labs: Lab[];
  saving: boolean; error: string | null; preview: Preview | null;
  onPreview: () => void; onSave: (event: FormEvent) => void; onClose: () => void;
}) {
  const update = <K extends keyof Rule>(key: K, value: Rule[K]) => setDraft({ ...draft, [key]: value });
  const cond = draft.triggerCondition;
  const setCond = (next: Condition) => update("triggerCondition", next);
  const timing = timingOf(cond);
  const isSummary = draft.kind === "SUMMARY";
  const [summaryLab, setSummaryLab] = useState<number | null>(labs[0]?.labId ?? null);
  const [summaryText, setSummaryText] = useState<string | null>(null);

  function setTiming(nextTiming: Timing | "none", nextMinutes: number) {
    const next: Condition = { ...cond };
    for (const field of Object.values(TIMING_FIELD)) delete next[field];
    if (nextTiming !== "none") (next as Record<string, unknown>)[TIMING_FIELD[nextTiming]] = Math.max(0, Math.round(nextMinutes));
    setCond(next);
  }
  function toggleIn<T>(list: T[], value: T): T[] {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }
  /** A status chip cycles: any → is → is not → any. */
  function cycleStatus(status: string) {
    const isIn = cond.statusIn.includes(status);
    const isNot = cond.statusNotIn?.includes(status) ?? false;
    const statusIn = cond.statusIn.filter((s) => s !== status);
    const statusNotIn = (cond.statusNotIn ?? []).filter((s) => s !== status);
    if (!isIn && !isNot) statusIn.push(status);
    else if (isIn) statusNotIn.push(status);
    setCond({ ...cond, statusIn, statusNotIn });
  }
  function toggleStopFact(kind: string) {
    const has = draft.factConditions.some((f) => f.kind === kind && !f.present);
    update("factConditions", has
      ? draft.factConditions.filter((f) => !(f.kind === kind && !f.present))
      : [...draft.factConditions, { kind, present: false }]);
  }
  async function showSummary() {
    if (!draft.id || !summaryLab) return;
    const response = await fetch(`/api/message-rules/${draft.id}/summary`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ labId: summaryLab }),
    });
    const data = await response.json().catch(() => ({}));
    setSummaryText(response.ok ? (data.text ?? "Nothing to list right now.") : (data.error ?? "Could not build it"));
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/65 p-4">
      <form onSubmit={onSave} className="mx-auto my-8 max-w-2xl rounded-xl border border-zinc-700 bg-zinc-950 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
          <div>
            <h2 className="font-semibold text-zinc-100">{draft.id ? "Edit rule" : isSummary ? "New daily summary" : "New rule"}</h2>
            <p className="mt-0.5 text-xs text-zinc-500">Saved changes apply to every open order from the next minute.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-zinc-500 hover:text-zinc-200">✕</button>
        </div>
        <div className="space-y-4 p-5">
          <Field label="Name"><input required value={draft.name} onChange={(e) => update("name", e.target.value)} className={inputClass} /></Field>

          {isSummary ? (
            <Section title="When and which orders">
              <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-300">
                <span>Every day at</span>
                <input type="time" value={`${String(draft.summaryHour ?? 19).padStart(2, "0")}:${String(draft.summaryMinute ?? 0).padStart(2, "0")}`}
                  onChange={(e) => { const [h, m] = e.target.value.split(":").map(Number); setDraft({ ...draft, summaryHour: h, summaryMinute: m }); }}
                  className={`${inputClass} w-32`} aria-label="Time of day" />
                <span>listing</span>
                <select value={draft.summaryScope ?? "APPOINTMENT_TOMORROW"} onChange={(e) => update("summaryScope", e.target.value as Rule["summaryScope"])} className={`${inputClass} w-auto`}>
                  {Object.entries(SCOPES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </select>
              </div>
              <TimingRow timing={timing} setTiming={setTiming} optional />
              <StatusChips cond={cond} onCycle={cycleStatus} />
              <label className="mt-3 flex items-center gap-2 text-xs text-zinc-300">
                <input type="checkbox" checked={draft.skipWhenEmpty} onChange={(e) => update("skipWhenEmpty", e.target.checked)} className="accent-blue-500" />
                Say nothing on days with no orders to list
              </label>
            </Section>
          ) : (
            <Section title="When">
              {draft.introduces
                ? <p className="text-xs text-zinc-300">As soon as a new order is placed — this message introduces the order to the lab.</p>
                : <TimingRow timing={timing} setTiming={setTiming} />}
              <StatusChips cond={cond} onCycle={cycleStatus} />
              <label className="mt-3 flex items-center gap-2 text-xs text-zinc-300">
                <input type="checkbox" checked={draft.notAfterAppointment} onChange={(e) => update("notAfterAppointment", e.target.checked)} className="accent-blue-500" />
                Never once the appointment has passed
              </label>
              {!draft.introduces && (
                <label className="mt-1.5 flex items-center gap-2 text-xs text-zinc-300">
                  <input type="checkbox" checked={draft.onlyIfIntroduced} onChange={(e) => update("onlyIfIntroduced", e.target.checked)} className="accent-blue-500" />
                  Only orders the lab was sent the new-order message for
                </label>
              )}
            </Section>
          )}

          <Section title="Stop once the lab reports">
            <div className="flex flex-wrap gap-1.5">
              {FACTS.map((fact) => (
                <Chip key={fact.kind} on={draft.factConditions.some((f) => f.kind === fact.kind && !f.present)} onClick={() => toggleStopFact(fact.kind)}>{fact.label}</Chip>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-zinc-500">Read from the lab&apos;s replies in the group. LabStack&apos;s status is checked as well.</p>
            {!isSummary && (
              <label className="mt-3 flex items-center gap-2 text-xs text-zinc-300">
                <input type="checkbox" checked={draft.stopOnAnswer} onChange={(e) => update("stopOnAnswer", e.target.checked)} className="accent-blue-500" />
                Stop repeating as soon as the lab answers it (a poll tap or a reply)
              </label>
            )}
          </Section>

          <Section title="Who gets it">
            <p className="text-xs text-zinc-300">The lab on the order — its WhatsApp group, or its manager.</p>
            <details className="mt-3" open={draft.allowedLabIds.length > 0 || draft.allowedOrderTypes.length > 0}>
              <summary className="cursor-pointer text-[11px] text-zinc-400 hover:text-zinc-200">
                {draft.allowedLabIds.length > 0 || draft.allowedOrderTypes.length > 0 ? "Limited to some orders" : "Every order of every configured lab — limit it"}
              </summary>
              <div className="mt-2 space-y-3 border-l border-zinc-800 pl-3">
                <div>
                  <div className="text-[11px] text-zinc-500">Only orders of these labs</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {labs.map((lab) => <Chip key={lab.labId} on={draft.allowedLabIds.includes(lab.labId)} onClick={() => update("allowedLabIds", toggleIn(draft.allowedLabIds, lab.labId))}>{lab.labName}</Chip>)}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-zinc-500">Only these order types</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {ORDER_TYPES.map((type) => <Chip key={type} on={draft.allowedOrderTypes.includes(type)} onClick={() => update("allowedOrderTypes", toggleIn(draft.allowedOrderTypes, type))}>{pretty(type)}</Chip>)}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-zinc-500">Labs that receive orders (none selected = both)</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <Chip on={draft.integrationTypes.includes("NON_API")} onClick={() => update("integrationTypes", toggleIn(draft.integrationTypes, "NON_API"))}>over WhatsApp</Chip>
                    <Chip on={draft.integrationTypes.includes("API")} onClick={() => update("integrationTypes", toggleIn(draft.integrationTypes, "API"))}>through the API</Chip>
                  </div>
                </div>
              </div>
            </details>
          </Section>

          <Section title="Message">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Template">
                <select value={draft.templateKey} onChange={(e) => update("templateKey", e.target.value)} className={inputClass}>
                  {templates.map((t) => <option key={t.key} value={t.key}>{t.name}{t.isActive === false ? " — paused" : ""}</option>)}
                </select>
              </Field>
              {!isSummary && (
                <Field label="Poll">
                  <select value={draft.pollKey ?? ""} onChange={(e) => update("pollKey", e.target.value || null)} className={inputClass}>
                    <option value="">No poll</option>
                    {polls.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
                  </select>
                </Field>
              )}
              <Field label="Send to">
                <select value={draft.recipient} onChange={(e) => update("recipient", e.target.value as Rule["recipient"])} className={inputClass}>
                  <option value="LAB">{isSummary ? "Each lab — its group" : "The order’s lab — its group"}</option>
                  <option value="MANAGER">{isSummary ? "Each lab — its manager (else the group)" : "The order’s lab — its manager (else the group)"}</option>
                </select>
              </Field>
              {!isSummary && (
                <Field label="Priority when several are due together">
                  <select value={draft.priority} onChange={(e) => update("priority", Number(e.target.value))} className={inputClass}>
                    {[0, 1, 2, 3, 4].map((p) => <option key={p} value={p}>P{p}{p === 0 ? " — most urgent" : p === 4 ? " — least" : ""}</option>)}
                  </select>
                </Field>
              )}
            </div>
            {!isSummary && (
              <label className="mt-3 flex items-center gap-2 text-xs text-zinc-300">
                <input type="checkbox" checked={draft.action === "ESCALATE"} onChange={(e) => update("action", e.target.checked ? "ESCALATE" : "SEND")} className="accent-blue-500" />
                Mark the order as escalated when this is sent
              </label>
            )}
          </Section>

          {!isSummary && (
            <Section title="How often">
              <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-300">
                <select value={draft.repeatEveryMinutes ? "repeat" : "once"} onChange={(e) => {
                  if (e.target.value === "once") setDraft({ ...draft, repeatEveryMinutes: null, maxSends: 1 });
                  else setDraft({ ...draft, repeatEveryMinutes: 60, maxSends: 3 });
                }} className={`${inputClass} w-auto`}>
                  <option value="once">Send once</option>
                  <option value="repeat">Repeat while still true</option>
                </select>
                {draft.repeatEveryMinutes != null && (
                  <>
                    <span>every</span>
                    <input type="number" min={5} value={draft.repeatEveryMinutes} onChange={(e) => update("repeatEveryMinutes", Number(e.target.value))} className={`${inputClass} w-20`} aria-label="Repeat every (minutes)" />
                    <span>min, up to</span>
                    <input type="number" min={1} max={20} value={draft.maxSends} onChange={(e) => update("maxSends", Number(e.target.value))} className={`${inputClass} w-16`} aria-label="Maximum sends" />
                    <span>times</span>
                  </>
                )}
              </div>
              <div className="mt-3 grid grid-cols-3 gap-3">
                <Field label="Send window from (hour)">
                  <input type="number" min={0} max={23} value={draft.sendWindowStartHour ?? ""} placeholder="any" onChange={(e) => update("sendWindowStartHour", e.target.value === "" ? null : Number(e.target.value))} className={inputClass} />
                </Field>
                <Field label="to (hour)">
                  <input type="number" min={0} max={23} value={draft.sendWindowEndHour ?? ""} placeholder="any" onChange={(e) => update("sendWindowEndHour", e.target.value === "" ? null : Number(e.target.value))} className={inputClass} />
                </Field>
                <Field label="Catch-up window (min)">
                  <input type="number" min={0} value={draft.catchUpMinutes} onChange={(e) => update("catchUpMinutes", Number(e.target.value))} className={inputClass} />
                </Field>
              </div>
              <p className="mt-1.5 text-[11px] text-zinc-500">
                Catch-up: when this rule is new or edited, orders whose moment passed less than this long ago still get it;
                older ones are skipped, so a new rule never messages every old order at once.
              </p>
            </Section>
          )}

          {preview && (
            <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3 text-xs text-zinc-300">
              {isSummary
                ? <>Would go to {preview.summaryLabs} lab{preview.summaryLabs === 1 ? "" : "s"}, listing {preview.summaryOrders} order{preview.summaryOrders === 1 ? "" : "s"} in total right now.</>
                : <>Checked {preview.checked} open orders. <b className="font-medium text-zinc-100">{preview.sendNow}</b> would get it now, {preview.later} later, {preview.tooLate} skipped as too late, {preview.done} already sent.</>}
            </div>
          )}
          {isSummary && draft.id && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
              <p className="mb-2 text-xs text-zinc-400">
                <span className="font-medium text-zinc-200">Preview for one lab.</span> Pick a lab to see the exact list it would get if this went out now. Nothing is sent.
              </p>
              <div className="flex items-center gap-2">
                <select value={summaryLab ?? ""} onChange={(e) => setSummaryLab(Number(e.target.value))} className={`${inputClass} w-auto`} aria-label="Lab to preview">
                  {labs.map((lab) => <option key={lab.labId} value={lab.labId}>{lab.labName}</option>)}
                </select>
                <button type="button" onClick={() => void showSummary()} className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:text-zinc-100">Show this lab&apos;s message</button>
              </div>
              {summaryText && <pre className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-zinc-950/60 p-3 text-xs leading-relaxed text-zinc-300">{summaryText}</pre>}
            </div>
          )}
          {error && <div className="rounded-md bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</div>}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-zinc-800 px-5 py-4">
          <button type="button" onClick={onPreview} className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:text-zinc-100">Preview on open orders</button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200">Cancel</button>
            <button disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60">{saving ? "Saving…" : "Save rule"}</button>
          </div>
        </div>
      </form>
    </div>
  );
}

function TimingRow({ timing, setTiming, optional }: {
  timing: { timing: Timing; minutes: number } | null;
  setTiming: (timing: Timing | "none", minutes: number) => void;
  optional?: boolean;
}) {
  const current = timing?.timing ?? "none";
  const minutes = timing?.minutes ?? 0;
  return (
    <div className={`flex flex-wrap items-center gap-2 text-sm text-zinc-300 ${optional ? "mt-3" : ""}`}>
      {optional && <span className="text-[11px] text-zinc-500">Only orders</span>}
      {current !== "none" && (
        <>
          <input type="number" min={0} value={minutes} onChange={(e) => setTiming(current, Number(e.target.value))} className={`${inputClass} w-24`} aria-label="Minutes" />
          <span>min</span>
        </>
      )}
      <select value={current} onChange={(e) => setTiming(e.target.value as Timing | "none", minutes)} className={`${inputClass} w-auto`} aria-label="Measured from">
        {optional && <option value="none">— any time —</option>}
        {!optional && <option value="none">as soon as the status matches</option>}
        {(Object.keys(TIMING_LABEL) as Timing[]).map((key) => <option key={key} value={key}>{TIMING_LABEL[key]}</option>)}
      </select>
    </div>
  );
}

function StatusChips({ cond, onCycle }: { cond: Condition; onCycle: (status: string) => void }) {
  return (
    <>
      <div className="mt-3 text-[11px] text-zinc-500">LabStack status — click once for “is”, twice for “is not”:</div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {ORDER_STATUSES.map((status) => {
          const isIn = cond.statusIn.includes(status);
          const isNot = cond.statusNotIn?.includes(status) ?? false;
          return (
            <button key={status} type="button" onClick={() => onCycle(status)} aria-pressed={isIn || isNot}
              className={`rounded-full border px-2 py-0.5 text-[11px] ${isIn ? "border-blue-500 bg-blue-500/10 text-blue-200" : isNot ? "border-rose-500/60 bg-rose-500/10 text-rose-200 line-through" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}>
              {pretty(status)}
            </button>
          );
        })}
      </div>
    </>
  );
}

const inputClass = "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-xs text-zinc-400">{label}</span>{children}</label>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3"><div className="mb-2 text-xs font-medium text-zinc-300">{title}</div>{children}</div>;
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`rounded-full border px-2 py-0.5 text-[11px] ${on ? "border-blue-500 bg-blue-500/10 text-blue-200" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}>
      {children}
    </button>
  );
}
