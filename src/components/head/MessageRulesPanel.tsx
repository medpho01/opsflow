"use client";

/**
 * Message rules — when OpsFlow messages a lab about an order.
 *
 * Each rule is evaluated every minute against every open order's current
 * state, so an edit here applies to all open orders on the next minute —
 * retroactively — limited by the rule's catch-up window. See
 * lib/provider-rules and DOCS/features/provider-communication/DESIGN.md.
 */

import { FormEvent, useCallback, useEffect, useState } from "react";

type Mode = "OFF" | "SHADOW" | "LIVE";

type TriggerCondition = {
  statusIn: string[];
  minutesSinceCreated?: number;
  minutesSinceStatusUpdated?: number;
  minutesBeforeAppointment?: number;
  minutesAfterAppointment?: number;
  metadataConditions?: unknown[];
};

type Rule = {
  id: string;
  builtInKey: string | null;
  name: string;
  description: string | null;
  isActive: boolean;
  version: number;
  allowedLabIds: number[];
  excludedLabIds: number[];
  allowedOrderTypes: string[];
  triggerCondition: TriggerCondition;
  conversationStatusIn: string[];
  onlyIfIntroduced: boolean;
  notAfterAppointment: boolean;
  requiresLabSetting: string | null;
  action: "SEND" | "ESCALATE";
  recipient: "LAB" | "MANAGER";
  templateKey: string;
  templateSlot: string | null;
  pollKey: string | null;
  priority: number;
  repeatEveryMinutes: number | null;
  maxSends: number;
  catchUpMinutes: number;
  sendWindowStartHour: number | null;
  sendWindowEndHour: number | null;
  stats?: Record<string, number>;
};

type Option = { key: string; name: string; isActive?: boolean };
type Lab = { labId: number; labName: string };
type Preview = { checked: number; sendNow: number; tooLate: number; later: number; done: number };

const ORDER_STATUSES = [
  "PENDING", "CREATED", "ORDER_SCHEDULED", "RESCHEDULED", "PHLEBO_ASSIGNED", "KIT_DISPATCHED",
  "PATIENT_VISITED", "SAMPLE_COLLECTED", "SAMPLE_DELIVERED", "SAMPLE_PROCESSED",
];
const ORDER_TYPES = ["HOME_SAMPLE", "CENTER_VISIT", "CAMP", "KIT_BASED"];

type Timing = "created" | "beforeAppointment" | "afterAppointment" | "statusChanged";
const TIMING_FIELD: Record<Timing, keyof TriggerCondition> = {
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

const MODE_TEXT: Record<Mode, { title: string; detail: string }> = {
  OFF: { title: "Off", detail: "Rules do nothing. The previous scheduler sends the timed messages." },
  SHADOW: { title: "Shadow", detail: "Rules work out what they would send and record it, but send nothing. The previous scheduler keeps sending — compare the two before going live." },
  LIVE: { title: "Live", detail: "Rules send the timed messages. The previous scheduler stands down; what it already sent is not repeated." },
};

function timingOf(cond: TriggerCondition): { timing: Timing; minutes: number } {
  for (const timing of Object.keys(TIMING_FIELD) as Timing[]) {
    const value = cond[TIMING_FIELD[timing]];
    if (typeof value === "number") return { timing, minutes: value };
  }
  return { timing: "statusChanged", minutes: 0 };
}

function duration(minutes: number): string {
  if (minutes === 0) return "immediately";
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} min`;
}

function describe(rule: Rule, labs: Lab[], templates: Option[]): string {
  const { timing, minutes } = timingOf(rule.triggerCondition);
  const when = minutes === 0 && timing === "statusChanged" ? "As soon as the order is" : `${duration(minutes)} ${TIMING_LABEL[timing]}, if the order is`;
  const statuses = rule.triggerCondition.statusIn.map((s) => s.replaceAll("_", " ").toLowerCase()).join(" / ");
  const to = rule.recipient === "MANAGER" ? "the lab manager" : "the lab";
  const template = templates.find((t) => t.key === rule.templateKey)?.name ?? rule.templateKey;
  const repeat = rule.repeatEveryMinutes ? `, then every ${duration(rule.repeatEveryMinutes)} up to ${rule.maxSends} times` : "";
  const scope = rule.allowedLabIds.length > 0
    ? ` · only ${rule.allowedLabIds.map((id) => labs.find((l) => l.labId === id)?.labName ?? `lab ${id}`).join(", ")}`
    : "";
  return `${when} ${statuses}: send “${template}” to ${to}${repeat}${scope}`;
}

const EMPTY_RULE: Rule = {
  id: "", builtInKey: null, name: "", description: null, isActive: false, version: 1,
  allowedLabIds: [], excludedLabIds: [], allowedOrderTypes: [],
  triggerCondition: { statusIn: ["PENDING", "CREATED"], minutesSinceCreated: 60 },
  conversationStatusIn: [], onlyIfIntroduced: true, notAfterAppointment: false, requiresLabSetting: null,
  action: "SEND", recipient: "LAB", templateKey: "NON_API_REMINDER", templateSlot: null, pollKey: null,
  priority: 4, repeatEveryMinutes: null, maxSends: 1, catchUpMinutes: 30, sendWindowStartHour: null, sendWindowEndHour: null,
};

/** The editable fields, as the API takes them. */
function payload(rule: Rule) {
  const { id: _id, builtInKey: _b, version: _v, stats: _s, ...rest } = rule;
  void _id; void _b; void _v; void _s;
  return rest;
}

export function MessageRulesPanel() {
  const [mode, setMode] = useState<Mode>("SHADOW");
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
  const [confirmLive, setConfirmLive] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const flash = (text: string) => { setToast(text); window.setTimeout(() => setToast(null), 3000); };

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/message-rules");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load message rules");
      setMode(data.mode); setRules(data.rules); setTemplates(data.templates); setPolls(data.polls); setLabs(data.labs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load message rules");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function switchMode(next: Mode) {
    if (next === "LIVE" && !confirmLive) { setConfirmLive(true); return; }
    setConfirmLive(false);
    const response = await fetch("/api/message-rules/mode", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: next }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return flash(data.error ?? "Could not switch mode");
    flash(next === "LIVE"
      ? `Rules are live. ${data.imported ?? 0} earlier messages recorded so they won't repeat; ${data.retired ?? 0} scheduled steps handed over.`
      : `Mode set to ${MODE_TEXT[next].title}`);
    void load();
  }

  async function toggle(rule: Rule) {
    const response = await fetch(`/api/message-rules/${rule.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: !rule.isActive }),
    });
    if (!response.ok) return flash("Could not update the rule");
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
    setPreview(null);
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
    flash(draft.id ? "Saved — applies to open orders from the next minute" : "Rule created");
    void load();
  }

  const builtIns = rules.filter((rule) => rule.builtInKey);
  const authored = rules.filter((rule) => !rule.builtInKey);

  return (
    <div>
      <div className="mb-5">
        <div className="text-xs text-zinc-500 mb-1">Provider communication</div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Message rules</h1>
        <p className="text-sm text-zinc-400 mt-1 max-w-3xl">
          When a lab is messaged about an order. Every rule is checked each minute against every open order&apos;s current
          status, so a change here applies to all open orders straight away. The new-order message, the evening list and
          delivery deadlines are set elsewhere and are unaffected.
        </p>
      </div>

      <div className="mb-5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-xs font-medium text-zinc-300">Engine</div>
          <div className="inline-flex overflow-hidden rounded-lg border border-zinc-700" role="group" aria-label="Message rules engine mode">
            {(["OFF", "SHADOW", "LIVE"] as Mode[]).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={mode === option}
                onClick={() => option !== mode && void switchMode(option)}
                className={`px-3 py-1.5 text-xs font-medium ${mode === option
                  ? option === "LIVE" ? "bg-emerald-500/15 text-emerald-300" : option === "SHADOW" ? "bg-blue-500/15 text-blue-300" : "bg-zinc-700/60 text-zinc-200"
                  : "text-zinc-500 hover:text-zinc-300"}`}
              >
                {MODE_TEXT[option].title}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-zinc-500 flex-1 min-w-[16rem]">{MODE_TEXT[mode].detail}</p>
        </div>
        {confirmLive && (
          <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-zinc-300">
            Going live hands the timed messages (reminders, appointment pings, status check) to these rules. Messages already
            sent are recorded so they are not repeated, and the previous scheduler&apos;s pending steps are retired.
            <div className="mt-2 flex gap-2">
              <button onClick={() => void switchMode("LIVE")} className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500">Go live</button>
              <button onClick={() => setConfirmLive(false)} className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
            </div>
          </div>
        )}
      </div>

      {loading ? <div className="p-10 text-center text-sm text-zinc-500">Loading rules…</div>
        : error ? <div className="p-10 text-center text-sm text-rose-300">{error} <button onClick={() => void load()} className="underline">Try again</button></div>
        : (
          <>
            <RuleList title="Built-in" hint="Today's steps, as rules. Edit the timing or pause one; they can't be deleted." rules={builtIns}
              mode={mode} labs={labs} templates={templates} onEdit={(rule) => { setDraft(rule); setPreview(null); setFormError(null); }} onToggle={toggle} />
            <div className="mt-6 flex items-center justify-between">
              <div className="text-xs font-medium text-zinc-300">Your rules</div>
              <button onClick={() => { setDraft({ ...EMPTY_RULE }); setPreview(null); setFormError(null); }} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500">+ New rule</button>
            </div>
            {authored.length === 0
              ? <p className="mt-2 rounded-xl border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">No rules of your own yet. New rules start paused, so you can preview them first.</p>
              : <RuleList rules={authored} mode={mode} labs={labs} templates={templates}
                  onEdit={(rule) => { setDraft(rule); setPreview(null); setFormError(null); }} onToggle={toggle} onDelete={remove} />}
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

function RuleList({ title, hint, rules, mode, labs, templates, onEdit, onToggle, onDelete }: {
  title?: string; hint?: string; rules: Rule[]; mode: Mode; labs: Lab[]; templates: Option[];
  onEdit: (rule: Rule) => void; onToggle: (rule: Rule) => void; onDelete?: (rule: Rule) => void;
}) {
  return (
    <div className="mt-2">
      {title && <div className="mb-2"><span className="text-xs font-medium text-zinc-300">{title}</span>{hint && <span className="ml-2 text-[11px] text-zinc-500">{hint}</span>}</div>}
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
                  {rule.requiresLabSetting && <span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">only labs with {rule.requiresLabSetting === "appointmentRemindersEnabled" ? "appointment reminders" : "status check"} on</span>}
                  {rule.pollKey && <span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">with poll</span>}
                  {rule.action === "ESCALATE" && <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">escalation</span>}
                </div>
                <div className="mt-0.5 text-[11px] text-zinc-400">{describe(rule, labs, templates)}</div>
                <div className="mt-1 text-[11px] text-zinc-500">
                  Sent {sent}
                  {mode !== "LIVE" && <> · would send {s.wouldSend ?? 0} (shadow)</>}
                  {(s.missed ?? 0) > 0 && <> · {s.missed} too late to send</>}
                  {(s.skipped ?? 0) > 0 && <> · {s.skipped} skipped</>}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <button onClick={() => onEdit(rule)} className="text-xs font-medium text-blue-400 hover:text-blue-300">Edit</button>
                {onDelete && <button onClick={() => onDelete(rule)} className="text-xs text-zinc-500 hover:text-rose-400">Delete</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RuleEditor({ draft, setDraft, templates, polls, labs, saving, error, preview, onPreview, onSave, onClose }: {
  draft: Rule; setDraft: (rule: Rule) => void; templates: Option[]; polls: Option[]; labs: Lab[];
  saving: boolean; error: string | null; preview: Preview | null;
  onPreview: () => void; onSave: (event: FormEvent) => void; onClose: () => void;
}) {
  const update = <K extends keyof Rule>(key: K, value: Rule[K]) => setDraft({ ...draft, [key]: value });
  const { timing, minutes } = timingOf(draft.triggerCondition);

  function setTiming(nextTiming: Timing, nextMinutes: number) {
    const cond: TriggerCondition = { ...draft.triggerCondition };
    for (const field of Object.values(TIMING_FIELD)) delete cond[field];
    (cond as Record<string, unknown>)[TIMING_FIELD[nextTiming]] = Math.max(0, Math.round(nextMinutes));
    update("triggerCondition", cond);
  }
  function toggleIn<T>(list: T[], value: T): T[] {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/65 p-4">
      <form onSubmit={onSave} className="mx-auto my-8 max-w-2xl rounded-xl border border-zinc-700 bg-zinc-950 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
          <div>
            <h2 className="font-semibold text-zinc-100">{draft.id ? "Edit rule" : "New rule"}</h2>
            <p className="mt-0.5 text-xs text-zinc-500">Saved changes apply to every open order from the next minute.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-zinc-500 hover:text-zinc-200">✕</button>
        </div>
        <div className="space-y-4 p-5">
          <Field label="Name"><input required value={draft.name} onChange={(e) => update("name", e.target.value)} className={inputClass} /></Field>

          <Section title="When">
            <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-300">
              <input type="number" min={0} value={minutes} onChange={(e) => setTiming(timing, Number(e.target.value))} className={`${inputClass} w-24`} aria-label="Minutes" />
              <span>minutes</span>
              <select value={timing} onChange={(e) => setTiming(e.target.value as Timing, minutes)} className={`${inputClass} w-auto`} aria-label="Measured from">
                {(Object.keys(TIMING_LABEL) as Timing[]).map((key) => <option key={key} value={key}>{TIMING_LABEL[key]}</option>)}
              </select>
            </div>
            <div className="mt-3 text-[11px] text-zinc-500">…while the order is in any of these LabStack statuses:</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {ORDER_STATUSES.map((status) => (
                <Chip key={status} on={draft.triggerCondition.statusIn.includes(status)}
                  onClick={() => update("triggerCondition", { ...draft.triggerCondition, statusIn: toggleIn(draft.triggerCondition.statusIn, status) })}>
                  {status.replaceAll("_", " ").toLowerCase()}
                </Chip>
              ))}
            </div>
            <label className="mt-3 flex items-center gap-2 text-xs text-zinc-300">
              <input type="checkbox" checked={draft.notAfterAppointment} onChange={(e) => update("notAfterAppointment", e.target.checked)} className="accent-blue-500" />
              Never once the appointment has passed
            </label>
            <label className="mt-1.5 flex items-center gap-2 text-xs text-zinc-300">
              <input type="checkbox" checked={draft.onlyIfIntroduced} onChange={(e) => update("onlyIfIntroduced", e.target.checked)} className="accent-blue-500" />
              Only orders the lab was sent the new-order message for
            </label>
          </Section>

          <Section title="Who gets it">
            <p className="text-xs text-zinc-300">
              The lab on the order — each message goes to the WhatsApp group (or manager) of whichever lab the order belongs to.
            </p>
            {(() => {
              const narrowed = draft.allowedLabIds.length > 0 || draft.allowedOrderTypes.length > 0 || !!draft.requiresLabSetting;
              return (
                <details open={narrowed} className="mt-3">
                  <summary className="cursor-pointer text-[11px] text-zinc-400 hover:text-zinc-200">
                    {narrowed ? "Limited to some orders" : "Applies to every order of every configured lab — limit it"}
                  </summary>
                  <div className="mt-2 space-y-3 border-l border-zinc-800 pl-3">
                    <div>
                      <div className="text-[11px] text-zinc-500">Only orders of these labs</div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {labs.map((lab) => (
                          <Chip key={lab.labId} on={draft.allowedLabIds.includes(lab.labId)} onClick={() => update("allowedLabIds", toggleIn(draft.allowedLabIds, lab.labId))}>{lab.labName}</Chip>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-zinc-500">Only these order types</div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {ORDER_TYPES.map((type) => (
                          <Chip key={type} on={draft.allowedOrderTypes.includes(type)} onClick={() => update("allowedOrderTypes", toggleIn(draft.allowedOrderTypes, type))}>{type.replaceAll("_", " ").toLowerCase()}</Chip>
                        ))}
                      </div>
                    </div>
                    <div className="max-w-xs">
                      <Field label="Only labs that switched this on in Lab Config">
                        <select value={draft.requiresLabSetting ?? ""} onChange={(e) => update("requiresLabSetting", e.target.value || null)} className={inputClass}>
                          <option value="">Any lab</option>
                          <option value="appointmentRemindersEnabled">Appointment reminders</option>
                          <option value="postAppointmentCheckEnabled">Status check after appointment</option>
                        </select>
                      </Field>
                    </div>
                  </div>
                </details>
              );
            })()}
          </Section>

          <Section title="Message">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Template">
                <select value={draft.templateKey} onChange={(e) => update("templateKey", e.target.value)} className={inputClass}>
                  {templates.map((t) => <option key={t.key} value={t.key}>{t.name}{t.isActive === false ? " — paused" : ""}</option>)}
                </select>
              </Field>
              <Field label="Poll">
                <select value={draft.pollKey ?? ""} onChange={(e) => update("pollKey", e.target.value || null)} className={inputClass}>
                  <option value="">No poll</option>
                  {polls.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
                </select>
              </Field>
              <Field label="Send to">
                <select value={draft.recipient} onChange={(e) => update("recipient", e.target.value as Rule["recipient"])} className={inputClass}>
                  <option value="LAB">The order&apos;s lab — its group</option>
                  <option value="MANAGER">The order&apos;s lab — its manager (else the group)</option>
                </select>
              </Field>
              <Field label="Priority when several are due together">
                <select value={draft.priority} onChange={(e) => update("priority", Number(e.target.value))} className={inputClass}>
                  {[0, 1, 2, 3, 4].map((p) => <option key={p} value={p}>P{p}{p === 0 ? " — most urgent" : p === 4 ? " — least" : ""}</option>)}
                </select>
              </Field>
            </div>
            <label className="mt-3 flex items-center gap-2 text-xs text-zinc-300">
              <input type="checkbox" checked={draft.action === "ESCALATE"} onChange={(e) => update("action", e.target.checked ? "ESCALATE" : "SEND")} className="accent-blue-500" />
              Mark the order as escalated when this is sent
            </label>
          </Section>

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

          {preview && (
            <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3 text-xs text-zinc-300">
              Checked {preview.checked} open orders. <b className="font-medium text-zinc-100">{preview.sendNow}</b> would get it now,
              {" "}{preview.later} later, {preview.tooLate} skipped as too late, {preview.done} already sent.
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
