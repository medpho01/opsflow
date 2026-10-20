"use client";

import { PickGroupDialog } from "@/components/head/connections/PickGroupDialog";
import { FormEvent, useCallback, useEffect, useState } from "react";

type LabConfig = {
  labId: number;
  labName: string;
  integrationType: "API" | "NON_API";
  waGroupJid: string | null;
  whatsappNumber: string | null;
  managerName: string | null;
  managerWhatsapp: string | null;
  isActive: boolean;
  confirmationSlaMinutes: number;
  reminderSlaMinutes: number;
  escalationSlaMinutes: number;
  initialTemplateKey: string;
  reminderTemplateKey: string;
  escalationTemplateKey: string;
  appointmentTemplateKey: string;
  appointmentRemindersEnabled: boolean;
  postAppointmentCheckEnabled: boolean;
  quietWindowMinutes: number;
  batchingMode?: "OFF" | "SHADOW" | "LIVE";
  maxBatchesPerSlot?: number;
  coordinators?: Coordinator[];
  maxMessagesPerDay?: number;
  slaBreachAlertsEnabled: boolean;
  slaBreachMaxPerOrder: number;
  dailyDigestEnabled: boolean;
  dailyDigestHour: number;
  dailyDigestMinute: number;
  dailyDigestSkipWhenEmpty: boolean;
};

type Draft = {
  labId: string;
  labName: string;
  integrationType: "API" | "NON_API";
  waGroupJid: string;
  whatsappNumber: string;
  managerName: string;
  managerWhatsapp: string;
  isActive: boolean;
  confirmationSlaMinutes: string;
  reminderSlaMinutes: string;
  escalationSlaMinutes: string;
  initialTemplateKey: string;
  reminderTemplateKey: string;
  escalationTemplateKey: string;
  appointmentTemplateKey: string;
  appointmentRemindersEnabled: boolean;
  postAppointmentCheckEnabled: boolean;
  quietWindowMinutes: string;
  batchingMode: "OFF" | "SHADOW" | "LIVE";
  maxBatchesPerSlot: string;
  coordinators: Coordinator[];
  maxMessagesPerDay: string;
  slaBreachAlertsEnabled: boolean;
  slaBreachMaxPerOrder: string;
  dailyDigestEnabled: boolean;
  /** "HH:MM" — one <input type="time">, split into hour/minute on save. */
  dailyDigestAt: string;
  dailyDigestSkipWhenEmpty: boolean;
};

const EMPTY_DRAFT: Draft = {
  labId: "", labName: "", integrationType: "NON_API", waGroupJid: "", whatsappNumber: "", managerName: "", managerWhatsapp: "", isActive: true,
  confirmationSlaMinutes: "60", reminderSlaMinutes: "180", escalationSlaMinutes: "300",
  initialTemplateKey: "NON_API_NEW_ORDER", reminderTemplateKey: "NON_API_REMINDER", escalationTemplateKey: "NON_API_ESCALATION",
  appointmentTemplateKey: "NON_API_APPOINTMENT_REMINDER", appointmentRemindersEnabled: false, postAppointmentCheckEnabled: true, quietWindowMinutes: "10",
  batchingMode: "OFF", maxBatchesPerSlot: "3", coordinators: [], maxMessagesPerDay: "8",
  slaBreachAlertsEnabled: true, slaBreachMaxPerOrder: "2",
  dailyDigestEnabled: false, dailyDigestAt: "19:00", dailyDigestSkipWhenEmpty: true,
};

const TEMPLATE_OPTIONS = [
  { key: "NON_API_NEW_ORDER", label: "New order" },
  { key: "NON_API_REMINDER", label: "Reminder" },
  { key: "NON_API_ESCALATION", label: "Escalation" },
  { key: "NON_API_APPOINTMENT_REMINDER", label: "Appointment reminder" },
];

function toDraft(lab: LabConfig): Draft {
  return {
    labId: String(lab.labId), labName: lab.labName, integrationType: lab.integrationType ?? "NON_API",
    waGroupJid: lab.waGroupJid ?? "",
    whatsappNumber: lab.whatsappNumber ?? "", isActive: lab.isActive,
    managerName: lab.managerName ?? "", managerWhatsapp: lab.managerWhatsapp ?? "",
    confirmationSlaMinutes: String(lab.confirmationSlaMinutes), reminderSlaMinutes: String(lab.reminderSlaMinutes), escalationSlaMinutes: String(lab.escalationSlaMinutes),
    initialTemplateKey: lab.initialTemplateKey, reminderTemplateKey: lab.reminderTemplateKey, escalationTemplateKey: lab.escalationTemplateKey,
    appointmentTemplateKey: lab.appointmentTemplateKey ?? "NON_API_APPOINTMENT_REMINDER",
    appointmentRemindersEnabled: lab.appointmentRemindersEnabled ?? false,
    postAppointmentCheckEnabled: lab.postAppointmentCheckEnabled ?? true,
    quietWindowMinutes: String(lab.quietWindowMinutes ?? 10),
    batchingMode: lab.batchingMode ?? "OFF",
    maxBatchesPerSlot: String(lab.maxBatchesPerSlot ?? 3),
    coordinators: Array.isArray(lab.coordinators) ? lab.coordinators : [],
    maxMessagesPerDay: String(lab.maxMessagesPerDay ?? 8),
    slaBreachAlertsEnabled: lab.slaBreachAlertsEnabled ?? true,
    slaBreachMaxPerOrder: String(lab.slaBreachMaxPerOrder ?? 2),
    dailyDigestEnabled: lab.dailyDigestEnabled ?? false,
    dailyDigestAt: `${String(lab.dailyDigestHour ?? 19).padStart(2, "0")}:${String(lab.dailyDigestMinute ?? 0).padStart(2, "0")}`,
    dailyDigestSkipWhenEmpty: lab.dailyDigestSkipWhenEmpty ?? true,
  };
}

type SetupStatus = "NOT_CONFIGURED" | "NEEDS_GROUP" | "PAUSED" | "LIVE";
type StatusFilter = "ALL" | "CONFIGURED" | SetupStatus;
type SortKey = "fulfilled" | "open" | "recent" | "name" | "id";
type Coordinator = { jid: string; name: string };
type Activity = "VERY_ACTIVE" | "ACTIVE" | "SOME" | "QUIET" | "DORMANT";

/** One lab as LabStack knows it, plus our config for it when there is one. */
type CatalogRow = {
  labId: number;
  labName: string;
  city: string | null;
  sourceActive: boolean;
  openOrders: number;
  /** Lifetime REPORT_DELIVERED orders — the measure of how much this lab matters. */
  fulfilledOrders: number;
  /** LabStack's own set-up (the truth): API when an order type is switched to the lab's API. */
  integration: "API" | "NON_API";
  apiProvider: string | null;
  apiChannels: string[];
  /** Orders placed (not cancelled) in the last 7 / 30 days. */
  orders7d: number;
  orders30d: number;
  lastOrderAt: string | null;
  activity: Activity;
  configured: boolean;
  orphaned?: boolean;
  config: LabConfig | null;
  status: SetupStatus;
  /** Best guess at this lab's WhatsApp group, or null when nothing is convincing. */
  suggestedGroup: { jid: string; subject: string; score: number } | null;
  /** The stored jid matches no group the gateway has ever seen — almost always a typo. */
  unknownGroup?: boolean;
  groupNotMember?: boolean;
};

/** A WhatsApp group the gateway can actually see. */
type WaGroupOption = { jid: string; subject: string; sendEnabled: boolean; active: boolean; labId: number | null };

type Filters = {
  q: string;
  status: StatusFilter;
  type: "ALL" | "NON_API" | "API";
  includeInactive: boolean;
  sort: SortKey;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
};

type PageData = {
  labs: CatalogRow[];
  groups: WaGroupOption[];
  total: number;
  page: number;
  pageCount: number;
  statusCounts: Record<SetupStatus, number>;
  configuredCount: number;
};

const DEFAULT_FILTERS: Filters = {
  q: "", status: "ALL", type: "ALL", includeInactive: false, sort: "fulfilled", dir: "desc", page: 1, pageSize: 25,
};

const STATUS_LABELS: Record<SetupStatus, string> = {
  LIVE: "Live",
  PAUSED: "Paused",
  NEEDS_GROUP: "Needs a group",
  NOT_CONFIGURED: "Not configured",
};

const STATUS_TONES: Record<SetupStatus, string> = {
  LIVE: "bg-emerald-500/10 text-emerald-300",
  PAUSED: "bg-zinc-700/40 text-zinc-300",
  NEEDS_GROUP: "bg-rose-500/10 text-rose-300",
  NOT_CONFIGURED: "bg-transparent text-zinc-500",
};

const SORT_OPTIONS: Array<{ key: SortKey; label: string; dir: "asc" | "desc" }> = [
  { key: "fulfilled", label: "Most orders fulfilled", dir: "desc" },
  { key: "open", label: "Most open orders", dir: "desc" },
  { key: "recent", label: "Most orders, last 7 days", dir: "desc" },
  { key: "name", label: "Name (A–Z)", dir: "asc" },
  { key: "id", label: "Lab ID", dir: "asc" },
];

/**
 * One page of the roster. The server searches, filters, sorts and pages —
 * thousands of labs are too many to ship here and sort in the browser.
 */
async function requestLabs(filters: Filters, refresh = false) {
  const params = new URLSearchParams({
    q: filters.q, status: filters.status, type: filters.type, sort: filters.sort, dir: filters.dir,
    page: String(filters.page), pageSize: String(filters.pageSize),
    ...(filters.includeInactive ? { includeInactive: "1" } : {}),
    ...(refresh ? { refresh: "1" } : {}),
  });
  const response = await fetch(`/api/non-api-labs/catalog?${params}`);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

/** A lab is only "on" when it is configured AND switched on. */
const isLive = (row: CatalogRow) => !!row.config?.isActive;

const formatCount = (value: number) => value.toLocaleString("en-IN");

export function NonApiLabConfigPanel() {
  const [labs, setLabs] = useState<CatalogRow[]>([]);
  const [groups, setGroups] = useState<WaGroupOption[]>([]);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  // Typed text, applied to `filters.q` after a pause so each keystroke is not a request.
  const [search, setSearch] = useState("");
  const [meta, setMeta] = useState<Omit<PageData, "labs" | "groups"> | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingLabId, setEditingLabId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  // Connect a WhatsApp group to a lab that has none (the same one step as on a group).
  const [pickingFor, setPickingFor] = useState<CatalogRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const flash = (message: string) => { setToast(message); window.setTimeout(() => setToast(null), 2400); };

  const apply = useCallback((data: PageData) => {
    setLabs(data.labs ?? []);
    setGroups(data.groups ?? []);
    setMeta({
      total: data.total, page: data.page, pageCount: data.pageCount,
      statusCounts: data.statusCounts, configuredCount: data.configuredCount,
    });
    setListError(null);
  }, []);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const { response, data } = await requestLabs(filters, refresh);
      if (response.ok) apply(data);
      else setListError(data.error ?? "Could not load labs");
    } catch {
      setListError("Could not load labs");
    } finally {
      setLoading(false);
    }
  }, [filters, apply]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void requestLabs(filters).then(({ response, data }) => {
      if (cancelled) return;
      if (response.ok) apply(data);
      else setListError(data.error ?? "Could not load labs");
      setLoading(false);
    }).catch(() => {
      if (!cancelled) { setListError("Could not load labs"); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [filters, apply]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((current) => (current.q === search ? current : { ...current, q: search, page: 1 }));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  /** Any filter change returns to page 1; paging itself does not. */
  function setFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((current) => ({ ...current, [key]: value, ...(key === "page" ? {} : { page: 1 }) }));
  }

  /**
   * Open the editor for a lab from the catalogue.
   *
   * There is no "add" path any more. A lab that has never been configured is
   * still a real lab in LabStack, so its id and name are taken from there and
   * only the parts OpsFlow owns are editable.
   */
  function editLab(row: CatalogRow) {
    setEditingLabId(row.configured ? row.labId : null);
    setDraft(row.config
      ? toDraft(row.config)
      : {
          ...EMPTY_DRAFT,
          labId: String(row.labId),
          labName: row.labName,
          // How LabStack sends this lab its orders.
          integrationType: row.integration,
          // Prefilled from the gateway's own group list, so the commonest case
          // needs no typing at all.
          waGroupJid: row.suggestedGroup?.jid ?? "",
        });
    setError(null);
    setOpen(true);
  }

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(null);
    const payload = {
      labId: Number(draft.labId), labName: draft.labName, integrationType: draft.integrationType,
      waGroupJid: draft.waGroupJid || null, whatsappNumber: draft.whatsappNumber || null,
      managerName: draft.managerName || null, managerWhatsapp: draft.managerWhatsapp || null,
      isActive: draft.isActive,
      confirmationSlaMinutes: Number(draft.confirmationSlaMinutes), reminderSlaMinutes: Number(draft.reminderSlaMinutes), escalationSlaMinutes: Number(draft.escalationSlaMinutes),
      initialTemplateKey: draft.initialTemplateKey, reminderTemplateKey: draft.reminderTemplateKey, escalationTemplateKey: draft.escalationTemplateKey,
      appointmentTemplateKey: draft.appointmentTemplateKey,
      appointmentRemindersEnabled: draft.appointmentRemindersEnabled,
      postAppointmentCheckEnabled: draft.postAppointmentCheckEnabled,
      quietWindowMinutes: Number(draft.quietWindowMinutes),
      batchingMode: draft.batchingMode,
      maxBatchesPerSlot: Number(draft.maxBatchesPerSlot),
      coordinators: draft.coordinators,
      maxMessagesPerDay: Number(draft.maxMessagesPerDay),
      slaBreachAlertsEnabled: draft.slaBreachAlertsEnabled,
      slaBreachMaxPerOrder: Number(draft.slaBreachMaxPerOrder),
      dailyDigestEnabled: draft.dailyDigestEnabled,
      // A blank time input must not save as 00:00 — that would move the digest
      // to midnight without anyone asking for it.
      dailyDigestHour: Number((draft.dailyDigestAt || "19:00").split(":")[0]),
      dailyDigestMinute: Number((draft.dailyDigestAt || "19:00").split(":")[1]),
      dailyDigestSkipWhenEmpty: draft.dailyDigestSkipWhenEmpty,
    };
    const response = await fetch(editingLabId ? `/api/non-api-labs/${editingLabId}` : "/api/non-api-labs", {
      method: editingLabId ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    setSaving(false);
    if (!response.ok) {
      const details = data.details ? Object.values(data.details).join(" · ") : null;
      setError(details || data.error || "Could not save configuration");
      return;
    }
    setOpen(false); flash(editingLabId ? "Provider configuration updated" : "Provider configured"); load();
  }

  /**
   * Flip a lab on or off.
   *
   * An unconfigured lab cannot simply be switched on: the validator requires a
   * WhatsApp group or number before a config can exist at all, and a lab that
   * is "active" with nowhere to send would fail silently every tick. So the
   * switch opens the editor instead of pretending to work.
   */
  /**
   * Set how a lab receives orders, straight from the table.
   *
   * The same choice lives in the edit dialog, but classifying a dozen labs one
   * modal at a time is the slow way round — and this is the field that decides
   * whether a lab gets the confirmation ladder at all, so it earns a place in
   * the row.
   *
   * PUT merges over the stored config and re-validates, so switching to
   * NON_API on a lab with no WhatsApp target is rejected by the same rule that
   * governs the dialog rather than by a second copy of it here.
   */
  async function setIntegration(row: CatalogRow, integrationType: "API" | "NON_API") {
    if (!row.configured || !row.config) {
      editLab(row);
      return;
    }
    if (row.config.integrationType === integrationType) return;

    const previous = row.config.integrationType;
    setLabs((current) => current.map((item) =>
      item.labId === row.labId && item.config ? { ...item, config: { ...item.config, integrationType } } : item));

    const response = await fetch(`/api/non-api-labs/${row.labId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ integrationType }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setLabs((current) => current.map((item) =>
        item.labId === row.labId && item.config ? { ...item, config: { ...item.config, integrationType: previous } } : item));
      const details = data.details ? Object.values(data.details).join(" · ") : null;
      return flash(details || data.error || "Could not change how this lab receives orders");
    }
    flash(integrationType === "NON_API"
      ? `${row.labName} now gets the confirmation ladder`
      : `${row.labName} set to API — breach alerts only`);
    void load();
  }

  async function toggleActive(row: CatalogRow) {
    if (!row.configured || !row.config) {
      flash("Add a WhatsApp target first");
      editLab(row);
      return;
    }
    const next = !row.config.isActive;
    // Optimistic: the switch should move under the finger, not after a round trip.
    setLabs((current) => current.map((item) =>
      item.labId === row.labId && item.config ? { ...item, config: { ...item.config, isActive: next } } : item));

    const response = await fetch(`/api/non-api-labs/${row.labId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: next }),
    });
    if (!response.ok) {
      setLabs((current) => current.map((item) =>
        item.labId === row.labId && item.config ? { ...item, config: { ...item.config, isActive: !next } } : item));
      return flash("Could not update lab status");
    }
    flash(next ? `${row.labName} is now active` : `${row.labName} paused`);
    // Re-read so the status badge follows the switch.
    void load();
  }

  const statusCounts = meta?.statusCounts;
  const statusOption = (value: StatusFilter, label: string, count?: number) => (
    <option value={value}>{label}{typeof count === "number" ? ` (${formatCount(count)})` : ""}</option>
  );
  const firstRow = meta && meta.total > 0 ? (meta.page - 1) * filters.pageSize + 1 : 0;
  const lastRow = meta ? Math.min(meta.page * filters.pageSize, meta.total) : 0;

  return (
    <div>
      <p className="mb-3 text-xs text-zinc-500">Every LabStack lab, busiest first. Connect a lab to its WhatsApp group and it gets the standard messages; Edit for the manager&apos;s number or to pause a lab.</p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, city or lab ID"
          aria-label="Search labs"
          className="w-72 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
        />
        <select
          value={filters.status}
          onChange={(e) => setFilter("status", e.target.value as StatusFilter)}
          aria-label="Filter by setup status"
          className={selectClass}
        >
          {statusOption("ALL", "All labs")}
          {statusOption("CONFIGURED", "Configured", meta?.configuredCount)}
          {(["LIVE", "PAUSED", "NEEDS_GROUP", "NOT_CONFIGURED"] as SetupStatus[]).map((status) => (
            <option key={status} value={status}>{STATUS_LABELS[status]}{statusCounts ? ` (${formatCount(statusCounts[status])})` : ""}</option>
          ))}
        </select>
        <select
          value={filters.type}
          onChange={(e) => setFilter("type", e.target.value as Filters["type"])}
          aria-label="Filter by how the lab receives orders"
          className={selectClass}
        >
          <option value="ALL">Any order channel</option>
          <option value="NON_API">Not API-integrated (LabStack)</option>
          <option value="API">API-integrated (LabStack)</option>
        </select>
        <label className="flex items-center gap-2 text-xs text-zinc-400 px-1">
          <input
            type="checkbox"
            checked={filters.includeInactive}
            onChange={(e) => setFilter("includeInactive", e.target.checked)}
            className="accent-blue-500"
          />
          Include labs inactive in LabStack
        </label>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={filters.sort}
            onChange={(e) => {
              const option = SORT_OPTIONS.find((item) => item.key === e.target.value)!;
              setFilters((current) => ({ ...current, sort: option.key, dir: option.dir, page: 1 }));
            }}
            aria-label="Sort labs"
            className={selectClass}
          >
            {SORT_OPTIONS.map((option) => <option key={option.key} value={option.key}>Sort: {option.label}</option>)}
          </select>
          <button
            type="button"
            onClick={() => setFilter("dir", filters.dir === "asc" ? "desc" : "asc")}
            aria-label={filters.dir === "asc" ? "Ascending — switch to descending" : "Descending — switch to ascending"}
            title={filters.dir === "asc" ? "Ascending" : "Descending"}
            className="rounded-lg border border-zinc-700 px-2.5 py-2 text-xs text-zinc-400 hover:text-zinc-200"
          >
            {filters.dir === "asc" ? "↑" : "↓"}
          </button>
          <button
            type="button"
            onClick={() => void load(true)}
            title="Re-read order counts from LabStack (they are cached for 5 minutes)"
            className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-400 hover:text-zinc-200"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 overflow-hidden">
        {listError ? (
          <div className="p-10 text-center text-sm text-rose-300">{listError} <button onClick={() => void load()} className="underline">Try again</button></div>
        ) : !meta && loading ? <div className="p-10 text-center text-sm text-zinc-500">Loading labs from LabStack…</div> : labs.length === 0 ? (
          <div className="p-10 text-center"><p className="text-sm text-zinc-400">{filters.q ? `No lab matches “${filters.q}”.` : "No labs match these filters."}</p></div>
        ) : <div className={`overflow-x-auto transition-opacity ${loading ? "opacity-60" : ""}`}><table className="w-full text-sm">
          <thead className="bg-zinc-950/70"><tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500 border-b border-zinc-800">
            <th className="px-4 py-2.5">Lab</th>
            <SortHeader label="Fulfilled" sortKey="fulfilled" filters={filters} onSort={setFilters} title="Lifetime orders with the report delivered" />
            <SortHeader label="Open" sortKey="open" filters={filters} onSort={setFilters} title="Orders not yet delivered or cancelled" />
            <SortHeader label="Recent orders" sortKey="recent" filters={filters} onSort={setFilters} title="Orders placed in the last 7 days (and 30 days), cancelled ones excluded" />
            <th className="px-3 py-2.5">Status</th>
            <th className="px-3 py-2.5">Receives orders</th>
            <th className="px-3 py-2.5">WhatsApp group</th>
            <th className="px-3 py-2.5">Active</th>
            <th className="px-4 py-2.5 text-right">Config</th>
          </tr></thead>
          <tbody>{labs.map((row) => {
            const cfg = row.config;
            const isApi = cfg?.integrationType === "API";
            return (
            <tr key={row.labId} className="border-b border-zinc-800/60 hover:bg-zinc-900/40">
              <td className="px-4 py-3">
                <div className="font-medium text-zinc-100">{row.labName}</div>
                <div className="font-mono text-[11px] text-zinc-500">
                  Lab #{row.labId}{row.city ? ` · ${row.city}` : ""}
                  {row.orphaned && <span className="ml-1 text-amber-400">· not in LabStack</span>}
                  {!row.sourceActive && !row.orphaned && <span className="ml-1 text-zinc-600">· inactive in LabStack</span>}
                </div>
              </td>
              <td className="px-3 py-3 tabular-nums text-zinc-200">{formatCount(row.fulfilledOrders)}</td>
              <td className="px-3 py-3 tabular-nums text-zinc-400">{formatCount(row.openOrders)}</td>
              <td className="px-3 py-3"><RecentActivity row={row} /></td>
              <td className="px-3 py-3">
                <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONES[row.status]}`}>{STATUS_LABELS[row.status]}</span>
              </td>
              <td className="px-3 py-3">
                <IntegrationPicker
                  value={cfg?.integrationType ?? null}
                  onPick={(next) => setIntegration(row, next)}
                  labName={row.labName}
                />
                <LabStackIntegration row={row} />
              </td>
              <td className="px-3 py-3 max-w-[16rem]">
                {cfg?.waGroupJid ? <>
                  <div className={`text-xs truncate ${row.unknownGroup || row.groupNotMember ? "text-amber-400" : "text-zinc-300"}`} title={groups.find((g) => g.jid === cfg.waGroupJid)?.subject ?? cfg.waGroupJid}>
                    {row.unknownGroup ? "⚠ Unknown group" : row.groupNotMember ? "⚠ Linked number not in this group" : groups.find((g) => g.jid === cfg.waGroupJid)?.subject ?? cfg.waGroupJid}
                  </div>
                </>
                  : cfg?.whatsappNumber ? <div className="font-mono text-[11px] text-zinc-400">DM {cfg.whatsappNumber}</div>
                  : <div className="flex items-center gap-2">
                      {row.suggestedGroup ? <span className="text-[11px] text-zinc-500 truncate" title={row.suggestedGroup.subject}>Suggested: {row.suggestedGroup.subject}</span> : <span className="text-xs text-zinc-600">—</span>}
                      <button onClick={() => setPickingFor(row)} className="shrink-0 text-xs font-medium text-blue-400 hover:text-blue-300">Connect</button>
                    </div>}
              </td>
              <td className="px-3 py-3"><Toggle on={isLive(row)} disabled={!row.configured} onClick={() => toggleActive(row)} label={row.labName} /></td>
              <td className="px-4 py-3 text-right">
                <button onClick={() => editLab(row)} className="text-xs font-medium text-blue-400 hover:text-blue-300">
                  {row.configured ? "Edit" : "Configure"}
                </button>
              </td>
            </tr>);
          })}</tbody>
        </table></div>}
        {meta && meta.total > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 px-4 py-3 text-xs text-zinc-400">
            <span>Showing {formatCount(firstRow)}–{formatCount(lastRow)} of {formatCount(meta.total)} labs</span>
            <label className="flex items-center gap-2">
              Rows
              <select
                value={filters.pageSize}
                onChange={(e) => setFilter("pageSize", Number(e.target.value))}
                className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
              >
                {[25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
            <Pagination page={meta.page} pageCount={meta.pageCount} onPage={(page) => setFilter("page", page)} />
          </div>
        )}
      </div>
      {pickingFor && (
        <PickGroupDialog
          target={{ kind: "LAB", id: pickingFor.labId, name: pickingFor.labName }}
          suggestedJid={pickingFor.suggestedGroup?.jid ?? null}
          onClose={() => setPickingFor(null)}
          onDone={(message) => { setPickingFor(null); flash(message); void load(); }}
        />
      )}
      {open && <div className="fixed inset-0 z-50 bg-black/65 p-4 overflow-y-auto"><div className="max-w-xl mx-auto my-8 rounded-xl border border-zinc-700 bg-zinc-950 shadow-2xl"><form onSubmit={save}><div className="px-5 py-4 border-b border-zinc-800 flex justify-between items-center"><div><h2 className="font-semibold text-zinc-100">{editingLabId ? "Edit lab" : "Configure a lab"}</h2><p className="text-xs text-zinc-500 mt-0.5">This never modifies LabStack&apos;s source lab record.</p></div><button type="button" onClick={() => setOpen(false)} className="text-zinc-500 hover:text-zinc-200">✕</button></div><div className="p-5 space-y-4"><div className="grid grid-cols-3 gap-3"><Field label="Lab ID"><input disabled type="number" value={draft.labId} className={inputClass} /></Field><div className="col-span-2"><Field label="Lab name"><input disabled value={draft.labName} className={inputClass} /></Field></div></div><p className="text-[11px] text-zinc-500 -mt-1">Both come from LabStack and are read-only here. Everything below is OpsFlow&apos;s own configuration.</p><div>
                <div className="text-xs font-medium text-zinc-300 mb-2">How does this lab receive orders?</div>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { value: "NON_API", title: "Over WhatsApp", detail: "Gets the confirmation workflow and breach alerts." },
                    { value: "API", title: "Through the API", detail: "Breach alerts only — it already has the order." },
                  ] as const).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => update("integrationType", option.value)}
                      className={`rounded-lg border px-3 py-2.5 text-left transition ${draft.integrationType === option.value ? "border-blue-500 bg-blue-500/10" : "border-zinc-700 hover:border-zinc-600"}`}
                    >
                      <div className={`text-sm font-medium ${draft.integrationType === option.value ? "text-blue-300" : "text-zinc-200"}`}>{option.title}</div>
                      <div className="text-[11px] text-zinc-500 mt-0.5">{option.detail}</div>
                    </button>
                  ))}
                </div>
              </div><Field label="WhatsApp group"><select value={draft.waGroupJid} onChange={(e) => update("waGroupJid", e.target.value)} className={inputClass}>
                <option value="">— no group —</option>
                {!!draft.waGroupJid && !groups.some((g) => g.jid === draft.waGroupJid) && (
                  <option value={draft.waGroupJid}>⚠ {draft.waGroupJid} — not a group the gateway can see</option>
                )}
                {groups.map((g) => (
                  <option key={g.jid} value={g.jid}>
                    {g.subject || g.jid}
                  </option>
                ))}
              </select></Field><p className="text-[11px] text-zinc-500 -mt-2">Picked from the {groups.length} groups the gateway can actually see, so the id is never typed. </p><p className="text-[11px] text-zinc-500 -mt-2">The provider&apos;s ops group, so a reply is visible to their whole desk. Required for API labs too — that is where breach alerts go. </p><Field label="Lab WhatsApp number (fallback, used only without a group)"><input value={draft.whatsappNumber} onChange={(e) => update("whatsappNumber", e.target.value)} placeholder="+9198…" className={inputClass} /></Field><div className="grid grid-cols-2 gap-3"><Field label="Lab manager (name)"><input value={draft.managerName} onChange={(e) => update("managerName", e.target.value)} placeholder="Optional" className={inputClass} /></Field><Field label="Lab manager WhatsApp"><input value={draft.managerWhatsapp} onChange={(e) => update("managerWhatsapp", e.target.value)} placeholder="+9198…" className={inputClass} /></Field></div><p className="text-[11px] text-zinc-500 -mt-2">Rules set to “send to the lab manager” (the final reminder) go here; without a number they go to the group.</p><div className="max-w-[14rem]"><Field label="Quiet window (minutes)"><input required type="number" min="0" max="240" value={draft.quietWindowMinutes} onChange={(e) => update("quietWindowMinutes", e.target.value)} className={inputClass} /></Field></div><p className="text-[11px] text-zinc-500 -mt-2">Minimum gap between two messages about the same order. What is sent, and when, is set on the Message Rules page.</p><p className="text-[11px] text-zinc-500">Messages are the same for every lab (Message Rules). Follow-ups for several orders go as one numbered message per ask, at set times in working hours, and reply to the earlier message.</p><CoordinatorPicker labId={draft.labId} groupJid={draft.waGroupJid} value={draft.coordinators} onChange={(next) => update("coordinators", next)} />{draft.labId && <CombinedMessages labId={Number(draft.labId)} />}<label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" checked={draft.isActive} onChange={(e) => update("isActive", e.target.checked)} className="accent-blue-500" /> Enable automation for this lab</label>{error && <div className="rounded-md bg-rose-500/10 text-rose-300 text-sm px-3 py-2">{error}</div>}</div><div className="px-5 py-4 border-t border-zinc-800 flex justify-end gap-2"><button type="button" onClick={() => setOpen(false)} className="px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200">Cancel</button><button disabled={saving} className="rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white font-semibold text-sm px-4 py-2">{saving ? "Saving…" : "Save configuration"}</button></div></form></div></div>}
      {toast && <div className="fixed z-[60] left-1/2 bottom-6 -translate-x-1/2 rounded-lg bg-zinc-100 text-zinc-950 px-4 py-2 text-sm font-medium shadow-lg">{toast}</div>}
    </div>
  );
}

/**
 * How a lab receives orders, as a two-way choice in the row.
 *
 * This is the field that decides whether a lab gets the confirmation ladder,
 * so it is worth setting without opening a dialog. An unconfigured lab shows
 * "Set up" instead: there is no config to PATCH yet, and one cannot be created
 * without a WhatsApp target, so the click hands over to the editor.
 */
function IntegrationPicker({
  value,
  onPick,
  labName,
}: {
  value: "API" | "NON_API" | null;
  onPick: (next: "API" | "NON_API") => void;
  labName: string;
}) {
  if (!value) {
    return (
      <button
        type="button"
        onClick={() => onPick("NON_API")}
        className="rounded border border-dashed border-zinc-700 px-2 py-1 text-[11px] text-zinc-500 hover:border-blue-500 hover:text-blue-300"
      >
        Set up
      </button>
    );
  }
  const options = [
    { key: "NON_API" as const, label: "WhatsApp", hint: `${labName} gets the confirmation ladder and breach alerts` },
    { key: "API" as const, label: "API", hint: `${labName} already receives orders over the API — breach alerts only` },
  ];
  return (
    <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden" role="group" aria-label={`How ${labName} receives orders`}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          title={option.hint}
          aria-pressed={value === option.key}
          onClick={() => onPick(option.key)}
          className={`px-2 py-1 text-[11px] font-medium transition ${
            value === option.key
              ? option.key === "NON_API"
                ? "bg-blue-500/15 text-blue-300"
                : "bg-zinc-700/60 text-zinc-200"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Active switch.
 *
 * Disabled until the lab is configured, because a lab with no WhatsApp target
 * cannot be activated — the config validator rejects it. Clicking the disabled
 * switch still opens the editor rather than doing nothing, which is why the
 * wrapper stays clickable and only the visual reads as inert.
 */
function Toggle({ on, disabled, onClick, label }: { on: boolean; disabled?: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${on ? "Deactivate" : "Activate"} ${label}`}
      title={disabled ? "Configure a WhatsApp target first" : on ? "Active — click to pause" : "Paused — click to activate"}
      onClick={onClick}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${
        on ? "bg-emerald-500" : disabled ? "bg-zinc-800" : "bg-zinc-700"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${on ? "translate-x-[1.15rem]" : "translate-x-1"} ${disabled ? "opacity-50" : ""}`}
      />
    </button>
  );
}

const inputClass = "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500 disabled:opacity-50";
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="block text-xs text-zinc-400 mb-1">{label}</span>{children}</label>; }
const selectClass = "rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-200 outline-none focus:border-blue-500";

/** A column header that sorts by its column; clicking again flips the direction. */
function SortHeader({
  label, sortKey, filters, onSort, title,
}: {
  label: string;
  sortKey: SortKey;
  filters: Filters;
  onSort: (update: (current: Filters) => Filters) => void;
  title: string;
}) {
  const active = filters.sort === sortKey;
  return (
    <th className="px-3 py-2.5" aria-sort={active ? (filters.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        title={title}
        onClick={() => onSort((current) => ({
          ...current,
          sort: sortKey,
          dir: current.sort === sortKey ? (current.dir === "asc" ? "desc" : "asc") : "desc",
          page: 1,
        }))}
        className={`uppercase tracking-wide ${active ? "text-zinc-200" : "text-zinc-500 hover:text-zinc-300"}`}
      >
        {label}{active ? (filters.dir === "asc" ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );
}

/** First, previous, a window of pages around the current one, next, last. */
function Pagination({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (page: number) => void }) {
  if (pageCount <= 1) return null;
  const start = Math.max(1, Math.min(page - 2, pageCount - 4));
  const pages = Array.from({ length: Math.min(5, pageCount) }, (_, i) => start + i);
  const button = (label: string, target: number, disabled: boolean, current = false) => (
    <button
      key={`${label}-${target}`}
      type="button"
      onClick={() => onPage(target)}
      disabled={disabled}
      aria-current={current ? "page" : undefined}
      className={`min-w-[2rem] rounded border px-2 py-1 ${current ? "border-blue-500 bg-blue-500/10 text-blue-300" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"} disabled:opacity-40`}
    >
      {label}
    </button>
  );
  return (
    <div className="ml-auto flex items-center gap-1">
      {button("«", 1, page === 1)}
      {button("‹", page - 1, page === 1)}
      {pages.map((p) => button(String(p), p, false, p === page))}
      {button("›", page + 1, page === pageCount)}
      {button("»", pageCount, page === pageCount)}
      <span className="ml-2 text-zinc-500">Page {page} of {pageCount}</span>
    </div>
  );
}

type CombinedMessage = { id: string; intent: string; shadow: boolean; slotAt: string; itemCount: number; text: string; createdAt: string };

const INTENT_LABEL: Record<string, string> = {
  STATUS: "Status check", PHLEBO: "Assign a phlebo", ETA: "Phlebo on time?", UNCONFIRMED: "Awaiting confirmation",
  REPORT: "Reports pending", OVERDUE: "Running late", ESCALATION: "Manager escalation",
};

/** The lab's recent combined messages — sent (On) or recorded only (Preview). */
function CombinedMessages({ labId }: { labId: number }) {
  const [rows, setRows] = useState<CombinedMessage[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/non-api-labs/${labId}/batches`).then((r) => (r.ok ? r.json() : { batches: [] }))
      .then((d) => { if (!cancelled) setRows(d.batches ?? []); }).catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [labId]);
  if (!rows || rows.length === 0) return null;
  return (
    <details className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 -mt-1">
      <summary className="cursor-pointer text-xs text-zinc-300">Recent combined messages ({rows.length})</summary>
      <ul className="mt-2 space-y-1">
        {rows.map((b) => (
          <li key={b.id}>
            <button type="button" onClick={() => setOpenId(openId === b.id ? null : b.id)} className="w-full text-left text-xs text-zinc-400 hover:text-zinc-200">
              {new Date(b.slotAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
              {" · "}{INTENT_LABEL[b.intent] ?? b.intent}{" · "}{b.itemCount} order{b.itemCount === 1 ? "" : "s"}
              {b.shadow && <span className="ml-1.5 rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">preview</span>}
            </button>
            {openId === b.id && <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-zinc-950/60 p-2 text-[11px] leading-relaxed text-zinc-300">{b.text}</pre>}
          </li>
        ))}
      </ul>
    </details>
  );
}

const ACTIVITY: Record<Activity, { label: string; tone: string }> = {
  VERY_ACTIVE: { label: "Very active", tone: "bg-emerald-500/15 text-emerald-300" },
  ACTIVE: { label: "Active", tone: "bg-sky-500/15 text-sky-300" },
  SOME: { label: "Some", tone: "bg-zinc-700/50 text-zinc-300" },
  QUIET: { label: "Quiet", tone: "bg-transparent text-zinc-500" },
  DORMANT: { label: "Dormant", tone: "bg-transparent text-zinc-600" },
};

/** How busy the lab is right now: a band, then the counts behind it. */
function RecentActivity({ row }: { row: CatalogRow }) {
  const band = ACTIVITY[row.activity] ?? ACTIVITY.DORMANT;
  const last = row.lastOrderAt
    ? new Date(row.lastOrderAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" })
    : null;
  return (
    <div className="whitespace-nowrap">
      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${band.tone}`}>{band.label}</span>
      <div className="mt-1 text-[11px] tabular-nums text-zinc-500">
        {row.orders7d > 0 || row.orders30d > 0
          ? <><span className="text-zinc-300">{formatCount(row.orders7d)}</span> · 7d &nbsp;{formatCount(row.orders30d)} · 30d</>
          : last ? <>last order {last}</> : <>no orders yet</>}
      </div>
    </div>
  );
}

/** What LabStack says about how this lab gets orders — flagged when OpsFlow's setting disagrees. */
function LabStackIntegration({ row }: { row: CatalogRow }) {
  const provider = row.apiProvider ? row.apiProvider.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : null;
  const text = row.integration === "API"
    ? `LabStack: API${provider ? ` · ${provider}` : ""}${row.apiChannels.length ? ` (${row.apiChannels.join(", ")})` : ""}`
    : `LabStack: no API${provider ? ` (${provider} set, no order type on it)` : ""}`;
  const mismatch = !!row.config && row.config.integrationType !== row.integration;
  return (
    <div className={`mt-1 text-[11px] ${mismatch ? "text-amber-400" : "text-zinc-500"}`} title={mismatch ? "OpsFlow's setting differs from LabStack's" : undefined}>
      {mismatch ? "⚠ " : ""}{text}
    </div>
  );
}

type GroupMember = { jid: string; name: string; messages: number; team: boolean; auto?: boolean };

/**
 * The lab's coordinators: the people every bot message @mentions. People answer
 * people — in the Oct 2026 chats, @mentioned asks got answered, broadcasts did
 * not. Picked from who actually writes in the lab's group, lab people first.
 */
function CoordinatorPicker({ labId, groupJid, value, onChange }: {
  labId: string; groupJid: string; value: Coordinator[]; onChange: (next: Coordinator[]) => void;
}) {
  const [members, setMembers] = useState<GroupMember[] | null>(null);
  useEffect(() => {
    if (!labId || !groupJid) return;
    let cancelled = false;
    fetch(`/api/non-api-labs/${labId}/members?groupJid=${encodeURIComponent(groupJid)}`)
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((d) => { if (!cancelled) setMembers(d.members ?? []); })
      .catch(() => { if (!cancelled) setMembers([]); });
    return () => { cancelled = true; };
  }, [labId, groupJid]);
  const picked = new Set(value.map((c) => c.jid));
  const toggle = (member: GroupMember) => onChange(picked.has(member.jid)
    ? value.filter((c) => c.jid !== member.jid)
    : [...value, { jid: member.jid, name: member.name }].slice(0, 5));
  return (
    <div>
      <div className="text-xs font-medium text-zinc-300 mb-1">Who the bot @mentions</div>
      {!groupJid ? <p className="text-[11px] text-zinc-500">Pick the lab&apos;s WhatsApp group first.</p>
        : members === null ? <p className="text-[11px] text-zinc-500">Loading the group&apos;s members…</p>
        : members.length === 0 ? <p className="text-[11px] text-zinc-500">Nobody has written in this group yet.</p>
        : <div className="max-h-40 overflow-y-auto rounded-lg border border-zinc-800 divide-y divide-zinc-800/60">
            {members.slice(0, 15).map((member) => (
              <label key={member.jid} className="flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-300">
                <input type="checkbox" checked={picked.has(member.jid)} onChange={() => toggle(member)} className="accent-blue-500" />
                <span className="truncate">{member.name}</span>
                {member.team ? <span className="text-[10px] text-zinc-500">LabStack team</span>
                  : member.auto && <span className="text-[10px] text-emerald-400">automatic</span>}
                <span className="ml-auto tabular-nums text-[10px] text-zinc-500">{member.messages} msgs</span>
              </label>
            ))}
          </div>}
      <p className="text-[11px] text-zinc-500 mt-1">
        {value.length ? <>Picked here: {value.map((c) => c.name).join(", ")}. Untick everyone to go back to automatic.</>
          : <>Automatic: {members?.find((m) => m.auto)?.name ?? "the lab person who writes most in the group"} — nothing to set. Tick someone only to override.</>}
      </p>
    </div>
  );
}
