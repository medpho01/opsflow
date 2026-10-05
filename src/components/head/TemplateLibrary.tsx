"use client";

/**
 * Message templates — the wording of what labs receive.
 *
 * WHEN a message goes, and to whom, is a message rule (Message Rules page);
 * this page is only the words. Each template is plain WhatsApp text with
 * {{variables}} filled from the order when it is sent. The editor shows the
 * variables a template may use, which ones it must keep, which rules send it,
 * and a preview with sample data.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { renderPreview } from "@/lib/non-api-labs/blocks";

type Template = {
  key: string;
  name: string;
  body: string;
  isActive: boolean;
  allowedVariables: string[];
  requiredVariables: string[];
};
type RuleRef = { name: string; templateKey: string; isActive: boolean };

const VARIABLE_HELP: Record<string, string> = {
  order_id: "LabStack order number",
  patient_name: "Patient's name",
  patient_mobile: "Patient's mobile",
  patient_address: "Full address from the patient's profile",
  map_url: "Google Maps link to the address",
  appointment_date: "Appointment date",
  appointment_time: "Appointment time",
  tests: "Packages on the order",
  location: "Area / centre",
  lab_name: "The lab's name",
  manager_name: "The lab manager's name",
  confirm_url: "LabStack confirmation link",
  phlebo_name: "Phlebo's name (LabStack, else the lab's reply)",
  phlebo_phone: "Phlebo's number (LabStack, else the lab's reply)",
  since_appointment: "Time since the appointment",
  sla_milestone: "What is overdue (deadline rules)",
  sla_deadline: "When the rule became due",
  sla_overdue_by: "How late it is now",
  sla_attempt_no: "Which reminder this is",
  sla_attempts_remaining: "Reminders left",
  summary_date: "The day a summary is about",
  order_count: "Orders in the summary",
  order_list: "The numbered list of orders",
  confirmed_count: "Confirmed orders in the summary",
  pending_count: "Unconfirmed orders in the summary",
};

export function TemplateLibrary() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [rules, setRules] = useState<RuleRef[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const [draftName, setDraftName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [templatesRes, rulesRes] = await Promise.all([fetch("/api/non-api-labs/templates"), fetch("/api/message-rules")]);
    const templatesData = await templatesRes.json().catch(() => ({}));
    const rulesData = await rulesRes.json().catch(() => ({}));
    setTemplates(templatesData.templates ?? []);
    setRules(rulesData.rules ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const current = templates.find((t) => t.key === selected) ?? null;
  useEffect(() => {
    if (current) { setDraftBody(current.body); setDraftName(current.name); setNotice(null); }
  }, [current?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const usedBy = useMemo(() => rules.filter((rule) => rule.templateKey === selected), [rules, selected]);
  const used = useMemo(() => [...draftBody.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]), [draftBody]);
  const missing = current ? current.requiredVariables.filter((v) => !used.includes(v)) : [];
  const unknown = current ? used.filter((v) => !current.allowedVariables.includes(v)) : [];
  const dirty = !!current && (draftBody !== current.body || draftName !== current.name);

  async function save() {
    if (!current) return;
    setBusy(true); setNotice(null);
    const response = await fetch(`/api/non-api-labs/templates/${current.key}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: draftBody, name: draftName }),
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) return setNotice({ tone: "err", text: data.error ?? "Could not save" });
    setNotice({ tone: "ok", text: "Saved — the next message uses this wording" });
    void load();
  }

  async function toggle(template: Template) {
    const response = await fetch(`/api/non-api-labs/templates/${template.key}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: template.body, isActive: !template.isActive }),
    });
    if (response.ok) void load();
  }

  async function create() {
    if (!draftName.trim()) return;
    setBusy(true);
    const response = await fetch("/api/non-api-labs/templates", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: draftName.trim(), body: "Hi {{lab_name}}, about order *{{order_id}}* ({{patient_name}}):\n\n" }),
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) return setNotice({ tone: "err", text: data.error ?? "Could not create" });
    setCreating(false);
    await load();
    setSelected(data.template.key);
  }

  async function remove(template: Template) {
    if (!window.confirm(`Delete “${template.name}”?`)) return;
    const response = await fetch(`/api/non-api-labs/templates/${template.key}`, { method: "DELETE" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return setNotice({ tone: "err", text: data.error ?? "Could not delete" });
    setSelected(null);
    void load();
  }

  function insert(variable: string) {
    setDraftBody((body) => `${body}{{${variable}}}`);
  }

  return (
    <div>
      <div className="mb-5">
        <div className="text-xs text-zinc-500 mb-1">Provider communication</div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Message templates</h1>
        <p className="text-sm text-zinc-400 mt-1 max-w-3xl">
          The wording of what labs receive. When a message goes, and to whom, is set by a rule on the Message Rules page.
        </p>
      </div>

      <div className="grid grid-cols-[18rem_minmax(0,1fr)] gap-4 max-lg:grid-cols-1">
        <div className="rounded-xl border border-zinc-800 overflow-hidden">
          {loading ? <div className="p-6 text-sm text-zinc-500">Loading…</div> : templates.map((template) => {
            const ruleCount = rules.filter((r) => r.templateKey === template.key && r.isActive).length;
            return (
              <button key={template.key} type="button" onClick={() => setSelected(template.key)}
                className={`block w-full border-b border-zinc-800/60 px-3 py-2.5 text-left last:border-b-0 ${selected === template.key ? "bg-blue-500/10" : "hover:bg-zinc-900/60"}`}>
                <div className={`text-sm ${template.isActive ? "text-zinc-100" : "text-zinc-500 line-through"}`}>{template.name}</div>
                <div className="text-[11px] text-zinc-500">{ruleCount > 0 ? `used by ${ruleCount} active rule${ruleCount > 1 ? "s" : ""}` : "not used by an active rule"}</div>
              </button>
            );
          })}
          <div className="border-t border-zinc-800 p-3">
            {creating ? (
              <div className="flex gap-2">
                <input autoFocus value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="Name of the new message" className={inputClass} />
                <button onClick={() => void create()} disabled={busy} className="rounded-md bg-blue-600 px-3 text-xs font-semibold text-white">Add</button>
              </div>
            ) : (
              <button onClick={() => { setCreating(true); setSelected(null); setDraftName(""); }} className="text-xs font-medium text-blue-400 hover:text-blue-300">+ New template</button>
            )}
          </div>
        </div>

        {!current ? (
          <div className="rounded-xl border border-dashed border-zinc-800 p-10 text-center text-sm text-zinc-500">Pick a template to edit its wording.</div>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)_20rem] gap-4 max-xl:grid-cols-1">
            <div className="space-y-3">
              <input value={draftName} onChange={(e) => setDraftName(e.target.value)} className={inputClass} aria-label="Template name" />
              <textarea value={draftBody} onChange={(e) => setDraftBody(e.target.value)} rows={18} spellCheck={false}
                className={`${inputClass} font-mono text-[13px] leading-6`} aria-label="Message text" />
              {missing.length > 0 && <div className="text-xs text-amber-300">Must include: {missing.map((v) => `{{${v}}}`).join(", ")}</div>}
              {unknown.length > 0 && <div className="text-xs text-rose-300">Not available here: {unknown.map((v) => `{{${v}}}`).join(", ")}</div>}
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => void save()} disabled={busy || !dirty || missing.length > 0 || unknown.length > 0}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
                <button onClick={() => void toggle(current)} className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:text-zinc-100">
                  {current.isActive ? "Pause this message" : "Resume this message"}
                </button>
                {!usedBy.length && <button onClick={() => void remove(current)} className="text-xs text-zinc-500 hover:text-rose-400">Delete</button>}
                {notice && <span className={`text-xs ${notice.tone === "ok" ? "text-emerald-300" : "text-rose-300"}`}>{notice.text}</span>}
              </div>
              <div className="text-[11px] text-zinc-500">
                {usedBy.length ? <>Sent by: {usedBy.map((r) => r.name).join(" · ")}</> : "No rule sends this message yet."}
                {!current.isActive && " Paused: rules that send it skip it."}
              </div>
            </div>
            <div className="space-y-3">
              <div>
                <div className="mb-1.5 text-[10px] uppercase tracking-wide text-zinc-600">Preview · sample data</div>
                <div className="whitespace-pre-wrap break-words rounded-lg bg-emerald-900/20 px-3 py-2 text-[12px] leading-5 text-zinc-200">{renderPreview(draftBody)}</div>
              </div>
              <div>
                <div className="mb-1.5 text-[10px] uppercase tracking-wide text-zinc-600">Insert a variable</div>
                <div className="flex flex-wrap gap-1.5">
                  {current.allowedVariables.map((variable) => (
                    <button key={variable} type="button" onClick={() => insert(variable)} title={VARIABLE_HELP[variable] ?? variable}
                      className={`rounded-full border px-2 py-0.5 text-[11px] ${current.requiredVariables.includes(variable) ? "border-amber-500/50 text-amber-200" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}>
                      {variable}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const inputClass = "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500";
