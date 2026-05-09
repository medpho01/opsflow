"use client";

import { useEffect, useState, useCallback } from "react";
import ScheduleTab from "@/components/roster/ScheduleTab";

interface Store {
  id: number;
  storeName: string;
  city?: string | null;
}

interface DataSource {
  id: string;
  sourceId: string;
  displayName: string;
}

interface TeamMember {
  id: number;
  userId: number;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  currentLoad: number;
  maxConcurrentTasks: number;
  phone?: string | null;
  storeId: number;
  stores: number[];
  storeCount: number;
  capabilities: { dataSourceId: string; dataSource?: DataSource; assignedAt: string }[];
  capabilityCount: number;
  teamMember?: {
    id: number;
    maxConcurrentTasks: number;
    storeAssignments: { storeId: number }[];
    dailyRosters: { status: string; date: string; updatedAt: string }[];
    capabilities?: { dataSourceId: string; dataSource?: DataSource; assignedAt: string }[];
    skills?: Array<{ skillTag: { id: number; name: string; label: string } }>;
  };
  dailyRosters?: { status: string; date: string; updatedAt: string }[];
  rosterStatus?: string;
  hasException?: boolean;
}

const roleLabel: Record<string, string> = { OPS_AGENT: "Ops Agent", STORE_ADMIN: "Store Admin" };
const rosterStatusColor: Record<string, string> = {
  ACTIVE: "bg-green-500",
  ON_FIELD: "bg-blue-500",
  ON_LEAVE: "bg-amber-500",
  OFF: "bg-zinc-600",
};

// ─── Edit Drawer ────────────────────────────────────────────────────────────
function EditDrawer({
  member,
  stores,
  onClose,
  onSaved,
  onDeleted,
}: {
  member: TeamMember;
  stores: Store[];
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"profile" | "sources" | "stores" | "schedule">("profile");
  const [form, setForm] = useState({
    name: member.name,
    email: member.email,
    phone: member.phone ?? "",
    role: member.role,
    isActive: member.isActive,
    maxConcurrentTasks: member.maxConcurrentTasks ?? 5,
  });
  const [newPw, setNewPw] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [assignedStoreIds, setAssignedStoreIds] = useState<Set<number>>(
    new Set(member.stores ?? [])
  );
  const [assignedCapabilities, setAssignedCapabilities] = useState<Set<string>>(
    new Set(member.capabilities?.map((c) => c.dataSourceId) ?? [])
  );
  const [allSources, setAllSources] = useState<DataSource[]>([]);

  const [currentSchedule, setCurrentSchedule] = useState<any[]>([]);

  // Fetch available data sources for Sources tab
  useEffect(() => {
    fetch("/api/data-sources")
      .then((r) => r.json())
      .then((d) => { if (d.dataSources) setAllSources(d.dataSources); })
      .catch(() => {});
  }, []);

  // Sync state when member prop changes (e.g., after API refresh)
  useEffect(() => {
    setAssignedStoreIds(new Set(member.stores ?? []));
    setAssignedCapabilities(
      new Set(member.capabilities?.map((c) => c.dataSourceId) ?? [])
    );
  }, [member.userId, member.stores, member.capabilities]);

  // Auto-dismiss success message after 2.5 seconds
  useEffect(() => {
    if (success) {
      const timeout = setTimeout(() => setSuccess(""), 2500);
      return () => clearTimeout(timeout);
    }
  }, [success]);

  // ── Save profile ─────────────────────────────────────────────
  async function saveProfile() {
    setError(""); setSuccess("");
    setSaving(true);
    try {
      // 1. Save profile changes
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        role: form.role,
        isActive: form.isActive,
        maxConcurrentTasks: Number(form.maxConcurrentTasks),
      };
      if (newPw.trim()) body.resetPassword = newPw.trim();

      const res = await fetch(`/api/team/${member.userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Profile save failed"); return; }

      // 2. Save store assignments — single PUT replaces entire set atomically
      {
        const storeRes = await fetch(`/api/team/${member.userId}/stores`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ storeIds: Array.from(assignedStoreIds) }),
        });
        if (!storeRes.ok) { setError("Failed to save store assignments"); return; }
      }

      // 3. Save data source capability assignments (sync)
      {
        const currentCaps = new Set(member.capabilities?.map(c => c.dataSourceId) ?? []);
        const toAdd = Array.from(assignedCapabilities).filter(id => !currentCaps.has(id));
        const toRemove = Array.from(currentCaps).filter(id => !assignedCapabilities.has(id));

        for (const dataSourceId of toAdd) {
          const capRes = await fetch(`/api/team/${member.userId}/order-types`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dataSourceId }),
          });
          if (!capRes.ok) { setError("Failed to add data source"); return; }
        }

        for (const dataSourceId of toRemove) {
          const capRes = await fetch(`/api/team/${member.userId}/order-types/${dataSourceId}`, {
            method: "DELETE",
          });
          if (!capRes.ok) { setError("Failed to remove data source"); return; }
        }
      }

      // 4. Save schedule (if any changes were made)
      if (currentSchedule.length > 0) {
        const scheduleRes = await fetch(`/api/roster/schedule/${member.userId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ schedule: currentSchedule }),
        });
        if (!scheduleRes.ok) {
          const scheduleData = await scheduleRes.json();
          setError(scheduleData.error ?? "Failed to save schedule");
          return;
        }
      }

      setSuccess("All changes saved");
      setNewPw("");
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  // ── Quick deactivate (no drawer close, just toggles isActive) ───
  async function deactivateAccount() {
    setError(""); setSaving(true);
    try {
      const res = await fetch(`/api/team/${member.userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: false }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed to deactivate"); return; }
      setForm((f) => ({ ...f, isActive: false }));
      setSuccess("Account deactivated");
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  // ── Permanent delete ─────────────────────────────────────────
  async function deleteMember() {
    setDeleting(true); setError("");
    let deleted = false;
    try {
      const res = await fetch(`/api/team/${member.userId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Delete failed");
        setDeleteConfirm(false);
        return;
      }
      deleted = true;
    } finally {
      setDeleting(false);
    }
    // Call onDeleted AFTER finally so state is clean before unmount
    if (deleted) onDeleted();
  }

  // ── Store assignment toggle (draft only, no API call) ────────
  function toggleStore(storeId: number, has: boolean) {
    const newSet = new Set(assignedStoreIds);
    if (has) newSet.delete(storeId);
    else newSet.add(storeId);
    setAssignedStoreIds(newSet);
    // Changes will be saved when "Save Changes" button is clicked
  }

  // ── Capability toggle (draft only, no API call) ──────────────
  function toggleCapability(dataSourceId: string) {
    const has = assignedCapabilities.has(dataSourceId);
    const newSet = new Set(assignedCapabilities);
    if (has) newSet.delete(dataSourceId);
    else newSet.add(dataSourceId);
    setAssignedCapabilities(newSet);
    // Changes will be saved when "Save Changes" button is clicked
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-md bg-zinc-900 border-l border-zinc-800 h-full flex flex-col overflow-hidden shadow-2xl" style={{ colorScheme: "dark" }}>
        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">Edit Member</h2>
            <p className="text-xs text-zinc-500 mt-0.5">{member.email}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Success/Error Messages - Always Visible */}
        {error && (
          <div className="mx-4 mt-3 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        {success && (
          <div className="mx-4 mt-3 text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2 flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Changes saved
          </div>
        )}

        {/* Tabs */}
        <div className="px-4 py-3 border-b border-zinc-800 flex gap-2 overflow-x-auto bg-zinc-800/30">
          {[
            { id: "profile", label: "Profile" },
            { id: "sources", label: "Sources" },
            { id: "stores", label: "Stores" },
            { id: "schedule", label: "Schedule" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              className={`px-3 py-2 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
                activeTab === tab.id
                  ? "bg-blue-600 text-white"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* PROFILE TAB */}
          {activeTab === "profile" && (
            <>
              <div>
                <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Profile</h3>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Login Email (Username)</label>
                    <div className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-400">
                      {member.email}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Full Name</label>
                    <input
                      type="text"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Role</label>
                    <select
                      value={form.role}
                      onChange={(e) => setForm({ ...form, role: e.target.value })}
                      className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      <option value="OPS_AGENT">Ops Agent</option>
                      <option value="STORE_ADMIN">Store Admin</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Phone (WhatsApp)</label>
                    <input
                      type="text"
                      value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })}
                      placeholder="+91 9876543210"
                      className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Max Concurrent Tasks</label>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={form.maxConcurrentTasks}
                      onChange={(e) => setForm({ ...form, maxConcurrentTasks: parseInt(e.target.value) || 5 })}
                      className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <div>
                      <div className="text-sm text-zinc-200 font-medium">Active Account</div>
                      <div className="text-xs text-zinc-500">Inactive users cannot log in</div>
                    </div>
                    <button
                      onClick={() => setForm({ ...form, isActive: !form.isActive })}
                      className={`relative w-10 h-5.5 rounded-full transition-colors ${form.isActive ? "bg-blue-600" : "bg-zinc-700"}`}
                    >
                      <span className={`absolute top-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform ${form.isActive ? "left-5" : "left-0.5"}`} />
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Reset Password</h3>
                <div className="space-y-2">
                  <input
                    type="password"
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    placeholder="New password (min 8 chars)"
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <p className="text-[10px] text-zinc-600">Leave blank to keep current password. Changing will invalidate all active sessions.</p>
                </div>
              </div>

              {/* Danger Zone */}
              <div className="border border-red-500/20 rounded-lg p-4 bg-red-500/5">
                <h3 className="text-xs font-semibold text-red-400/80 uppercase tracking-wider mb-3">Danger Zone</h3>
                <div className="space-y-2">
                  {/* Deactivate — only show if currently active */}
                  {form.isActive && (
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs font-medium text-zinc-300">Deactivate Account</div>
                        <div className="text-[10px] text-zinc-500">Block login without deleting data</div>
                      </div>
                      <button
                        onClick={deactivateAccount}
                        disabled={saving}
                        className="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-lg transition-colors disabled:opacity-50"
                      >
                        Deactivate
                      </button>
                    </div>
                  )}

                  {/* Delete */}
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-medium text-zinc-300">Delete Member</div>
                      <div className="text-[10px] text-zinc-500">Permanently remove account and all data</div>
                    </div>
                    {deleteConfirm ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-red-400">Sure?</span>
                        <button
                          onClick={deleteMember}
                          disabled={deleting}
                          className="px-2.5 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors disabled:opacity-50"
                        >
                          {deleting ? "Deleting…" : "Yes, Delete"}
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(false)}
                          disabled={deleting}
                          className="px-2.5 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeleteConfirm(true)}
                        className="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-red-500/20 text-red-400 border border-red-500/30 rounded-lg transition-colors"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </div>

            </>
          )}

          {/* ORDER TYPES TAB */}
          {activeTab === "sources" && (
            <div>
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Data Sources</h3>
              <p className="text-xs text-zinc-500 mb-4">Select which data sources this member can handle tasks from</p>
              {allSources.length === 0 ? (
                <p className="text-xs text-zinc-600">No data sources configured</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {allSources.map((source) => (
                    <button
                      key={source.id}
                      onClick={() => toggleCapability(source.id)}
                      className={`text-xs px-2.5 py-1 rounded-full border transition-colors font-medium ${
                        assignedCapabilities.has(source.id)
                          ? "bg-green-600/20 border-green-500/40 text-green-300 hover:bg-red-500/20 hover:border-red-500/40 hover:text-red-300"
                          : "bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300"
                      }`}
                    >
                      {assignedCapabilities.has(source.id) ? "✓ " : "+ "}{source.displayName}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* STORES TAB */}
          {activeTab === "stores" && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Store Access</h3>
                {stores.length > 0 && (
                  <button
                    onClick={() => {
                      const allSelected = stores.every((s) => assignedStoreIds.has(s.id));
                      if (allSelected) {
                        setAssignedStoreIds(new Set());
                      } else {
                        setAssignedStoreIds(new Set(stores.map((s) => s.id)));
                      }
                    }}
                    className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    {stores.every((s) => assignedStoreIds.has(s.id)) ? "Deselect All" : "Select All"}
                  </button>
                )}
              </div>
              <p className="text-xs text-zinc-500 mb-4">
                Assign this team member to stores
                {stores.length > 0 && (
                  <span className="ml-1.5 text-zinc-600">
                    ({assignedStoreIds.size}/{stores.length} selected)
                  </span>
                )}
              </p>
              {stores.length === 0 ? (
                <p className="text-xs text-zinc-600">No stores configured yet</p>
              ) : (
                <div className="space-y-1.5">
                  {stores.map((store) => {
                    const has = assignedStoreIds.has(store.id);
                    return (
                      <label
                        key={store.id}
                        className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-zinc-800 cursor-pointer transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={has}
                          onChange={() => toggleStore(store.id, has)}
                          className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-zinc-900 cursor-pointer"
                        />
                        <span className="text-sm text-zinc-300">{store.storeName || `Store #${store.id}`}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* SCHEDULE TAB */}
          {activeTab === "schedule" && (
            <ScheduleTab
              userId={member.userId}
              onSaved={onSaved}
              onScheduleChange={setCurrentSchedule}
            />
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-zinc-800 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Close
          </button>
          <button
            onClick={saveProfile}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main TeamPanel ────────────────────────────────────────────────────────────
export default function TeamPanel() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "OPS_AGENT" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editMember, setEditMember] = useState<TeamMember | null>(null);
  const [selectedForException, setSelectedForException] = useState<{ member: TeamMember; action: "leave" | "sick" | "off" } | null>(null);
  const [exceptionNote, setExceptionNote] = useState("");
  const [exceptionLoading, setExceptionLoading] = useState(false);
  // W2 — store-first lens. `null` = "All stores" (no filter).
  const [storeFilter, setStoreFilter] = useState<number | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const teamUrl = storeFilter !== null
        ? `/api/team?storeId=${storeFilter}`
        : "/api/team";
      const [teamRes, storeRes] = await Promise.all([
        fetch(teamUrl),
        fetch("/api/stores"),
      ]);
      const [teamData, storeData] = await Promise.all([
        teamRes.json(),
        storeRes.json(),
      ]);
      setMembers(teamData.members ?? []);
      setStores(storeData.stores ?? []);
    } finally {
      setLoading(false);
    }
  }, [storeFilter]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  async function handleAddMember(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      const res = await fetch("/api/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed to create member"); return; }
      setShowAddForm(false);
      setForm({ name: "", email: "", password: "", role: "OPS_AGENT" });
      fetchAll();
    } finally {
      setSaving(false);
    }
  }

  // When edit drawer saves, refresh
  function onSaved() {
    fetchAll();
    // Re-sync the editMember data so drawer updates in place
    if (editMember) {
      setTimeout(() => {
        fetch("/api/team").then((r) => r.json()).then((d) => {
          const updated = (d.members as TeamMember[]).find((m) => m.userId === editMember.userId);
          if (updated) setEditMember(updated);
        });
      }, 100);
    }
  }

  // Create exception (mark as leave/sick/off)
  async function handleCreateException() {
    if (!selectedForException) return;

    setExceptionLoading(true);
    try {
      const today = new Date();
      const year = today.getFullYear();
      const month = String(today.getMonth() + 1).padStart(2, '0');
      const day = String(today.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      const res = await fetch("/api/roster/exception", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: selectedForException.member.userId,
          date: dateStr,
          status: selectedForException.action.toUpperCase(),
          note: exceptionNote.trim() || null,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create exception");
      }

      fetchAll();
      setSelectedForException(null);
      setExceptionNote("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error creating exception");
    } finally {
      setExceptionLoading(false);
    }
  }

  // Mark as Active (create ACTIVE exception to override OFF status)
  async function handleMarkActive(member: TeamMember) {
    if (!confirm(`Mark ${member.name} as Active for today?`)) return;

    setExceptionLoading(true);
    try {
      const today = new Date();
      const year = today.getFullYear();
      const month = String(today.getMonth() + 1).padStart(2, '0');
      const day = String(today.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      console.log("Creating ACTIVE exception for userId:", member.userId, "date:", dateStr);

      const res = await fetch("/api/roster/exception", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: member.userId,
          date: dateStr,
          status: "ACTIVE",
          note: "Marked as active",
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || data.message || "Failed to mark as active");
      }

      fetchAll();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Error marking as active";
      console.error("Mark active error:", errorMsg);
      setError(errorMsg);
    } finally {
      setExceptionLoading(false);
    }
  }

  // Remove exception (revert to schedule-based status)
  async function handleRemoveException(member: TeamMember) {
    if (!confirm(`Revert exception for ${member.name}?`)) return;

    setExceptionLoading(true);
    try {
      const today = new Date();
      const year = today.getFullYear();
      const month = String(today.getMonth() + 1).padStart(2, '0');
      const day = String(today.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      console.log("Removing exception for userId:", member.userId, "date:", dateStr);

      const res = await fetch(`/api/roster/exception/${member.userId}/${dateStr}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to remove exception");
      }

      fetchAll();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Error removing exception";
      console.error("Remove exception error:", errorMsg);
      setError(errorMsg);
    } finally {
      setExceptionLoading(false);
    }
  }

  return (
    <div className="h-full flex flex-col bg-zinc-950">
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-zinc-800 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-base font-semibold text-white">Team</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            {members.length} {storeFilter !== null ? "members at this store" : "members"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* W2 — store-first lens */}
          <select
            value={storeFilter ?? ""}
            onChange={(e) => setStoreFilter(e.target.value ? Number(e.target.value) : null)}
            className="px-3 py-1.5 bg-zinc-900 border border-zinc-700 text-zinc-300 text-xs rounded-lg hover:bg-zinc-800 focus:outline-none focus:ring-1 focus:ring-blue-500"
            title="Filter team to one store"
          >
            <option value="">All stores</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>{s.storeName ?? `Store #${s.id}`}</option>
            ))}
          </select>
          {storeFilter !== null && (
            <button
              onClick={() => setStoreFilter(null)}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              title="Clear store filter"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Add Member
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-5">
        {/* W4 — Performance leaderboard (collapsed by default; lives inline so heads
            don't have to bounce to Analytics) */}
        {!loading && members.length > 0 && <LeaderboardPanel />}

        {/* W5 — Weekly heatmap (agents × days). Shows scheduled coverage and exceptions
            in one view; flags coverage gaps and low-coverage days. */}
        {!loading && members.length > 0 && <WeeklyHeatmap />}

        {/* W5b — Coverage by hour. Answers "is anyone working at 7pm Tuesday?".
            Hour-of-day × day grid with concurrent-agent counts so the head can
            spot intra-day gaps when planning shift patterns. */}
        {!loading && members.length > 0 && <CoverageHeatmap />}

        {/* Roster + Capacity Analytics */}
        {!loading && members.length > 0 && (() => {
          // W3 — team-wide capacity summary so heads can balance load at a glance.
          const activeMembers = members.filter((m) => m.rosterStatus === "ACTIVE");
          const totalLoad = members.reduce((sum, m) => sum + (m.currentLoad ?? 0), 0);
          const totalCapacity = activeMembers.reduce((sum, m) => sum + (m.maxConcurrentTasks ?? 5), 0);
          const utilization = totalCapacity > 0 ? Math.round((totalLoad / totalCapacity) * 100) : 0;
          const nearCapacity = members.filter((m) => {
            const cap = m.maxConcurrentTasks ?? 5;
            return cap > 0 && (m.currentLoad ?? 0) / cap >= 0.8;
          }).length;

          return (
            <div className="grid grid-cols-4 gap-2 mb-5">
              <div className="bg-green-600/20 border border-green-600/30 text-green-400 rounded-lg p-3 text-center">
                <div className="text-xl font-semibold">{activeMembers.length}</div>
                <div className="text-xs mt-1">Active now</div>
              </div>
              <div className="bg-zinc-600/20 border border-zinc-600/30 text-zinc-400 rounded-lg p-3 text-center">
                <div className="text-xl font-semibold">
                  {members.filter((m) => m.rosterStatus === "OFF").length}
                </div>
                <div className="text-xs mt-1">Off</div>
              </div>
              <div className={`${
                utilization >= 80 ? "bg-red-600/20 border-red-600/30 text-red-400" :
                utilization >= 60 ? "bg-amber-600/20 border-amber-600/30 text-amber-400" :
                "bg-blue-600/20 border-blue-600/30 text-blue-400"
              } border rounded-lg p-3 text-center`} title={`${totalLoad} open tasks across ${totalCapacity} active capacity`}>
                <div className="text-xl font-semibold">{utilization}%</div>
                <div className="text-xs mt-1">Team utilization</div>
                <div className="text-[10px] opacity-70 mt-0.5">{totalLoad} / {totalCapacity}</div>
              </div>
              <div className={`${
                nearCapacity > 0 ? "bg-amber-600/20 border-amber-600/30 text-amber-400" : "bg-zinc-600/20 border-zinc-600/30 text-zinc-400"
              } border rounded-lg p-3 text-center`} title="Members at ≥80% of their max-concurrent-tasks">
                <div className="text-xl font-semibold">{nearCapacity}</div>
                <div className="text-xs mt-1">Near capacity</div>
              </div>
            </div>
          );
        })()}

        {/* Add member form */}
        {showAddForm && (
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-5 mb-5">
            <h2 className="text-sm font-semibold text-white mb-4">Add Team Member</h2>
            <form onSubmit={handleAddMember} className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Full Name</label>
                <input
                  type="text" required value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="Rahul Sharma"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Email</label>
                <input
                  type="email" required value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="rahul@opsflow.local"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Temporary Password</label>
                <input
                  type="password" required value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="••••••••"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Role</label>
                <select
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="OPS_AGENT">Ops Agent</option>
                  <option value="STORE_ADMIN">Store Admin</option>
                </select>
              </div>
              {error && (
                <div className="col-span-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
                  {error}
                </div>
              )}
              <div className="col-span-2 flex justify-end gap-2">
                <button type="button" onClick={() => setShowAddForm(false)} className="px-4 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg disabled:opacity-50 transition-colors">
                  {saving ? "Creating..." : "Create Member"}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Members grid */}
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-5 h-5 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
          </div>
        ) : members.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-center">
            <p className="text-sm text-zinc-600">No team members yet</p>
            <p className="text-xs text-zinc-700 mt-1">Add your first agent or store admin</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {members.map((member) => {
              const rosterStatus = member.rosterStatus ?? "OFF";
              const openTasks = member.currentLoad;
              const maxTasks = member.maxConcurrentTasks ?? 5;
              const skills = member.teamMember?.skills ?? [];
              const storeCount = member.storeCount ?? 0;

              return (
                <div
                  key={member.id}
                  className={`bg-zinc-900 border rounded-xl p-4 transition-colors ${
                    member.isActive ? "border-zinc-800" : "border-zinc-800/50 opacity-60"
                  }`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-full bg-zinc-700 flex items-center justify-center text-sm font-semibold text-zinc-300">
                        {member.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="text-sm font-medium text-zinc-100">{member.name}</div>
                        <div className="text-[10px] text-zinc-500">{roleLabel[member.role] ?? member.role}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <div className={`w-2 h-2 rounded-full ${rosterStatusColor[rosterStatus] ?? "bg-zinc-600"}`} />
                        <span className="text-[10px] text-zinc-500">{rosterStatus}</span>
                      </div>
                      <button
                        onClick={() => setEditMember(member)}
                        className="p-1 rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                        title="Edit member"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {!member.isActive && (
                    <div className="mb-2 px-2 py-1 bg-red-500/10 border border-red-500/20 rounded text-[10px] text-red-400 text-center">
                      Account Inactive
                    </div>
                  )}

                  <div className="text-[10px] text-zinc-600 mb-1">Task Load</div>
                  <div className="flex items-center gap-2 mb-3">
                    <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          (openTasks / maxTasks) >= 0.8 ? "bg-red-500" :
                          (openTasks / maxTasks) >= 0.6 ? "bg-amber-500" : "bg-green-500"
                        }`}
                        style={{ width: `${Math.min(100, (openTasks / maxTasks) * 100)}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-zinc-400 shrink-0">{openTasks}/{maxTasks}</span>
                  </div>

                  <div className="flex items-center justify-between mb-3">
                    <div className="flex flex-wrap gap-1">
                      {skills.slice(0, 2).map((s) => (
                        <span key={s.skillTag.name} className="text-[10px] bg-zinc-800 border border-zinc-700 text-zinc-400 px-1.5 py-0.5 rounded">
                          {s.skillTag.label}
                        </span>
                      ))}
                      {skills.length > 2 && (
                        <span className="text-[10px] text-zinc-600">+{skills.length - 2}</span>
                      )}
                    </div>
                    {storeCount > 0 && (
                      <span className="text-[10px] text-zinc-600">{storeCount} store{storeCount > 1 ? "s" : ""}</span>
                    )}
                  </div>

                  {/* Status Override Buttons */}
                  <div className="flex gap-2 text-[11px]">
                    {member.hasException ? (
                      // Case 3: Exception exists → Show Revert button
                      <button
                        onClick={() => handleRemoveException(member)}
                        className="flex-1 px-2 py-1.5 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-600/30 rounded transition-colors"
                      >
                        Revert Exception
                      </button>
                    ) : rosterStatus === "OFF" ? (
                      // Case 1: Schedule says OFF → Show Mark Active
                      <button
                        onClick={() => handleMarkActive(member)}
                        className="flex-1 px-2 py-1.5 bg-green-600/20 hover:bg-green-600/30 text-green-400 border border-green-600/30 rounded transition-colors"
                      >
                        Mark Active
                      </button>
                    ) : (
                      // Case 2: Schedule says ACTIVE → Show Mark Off
                      <button
                        onClick={() => setSelectedForException({ member, action: "off" })}
                        className="flex-1 px-2 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 border border-zinc-600 rounded transition-colors"
                      >
                        Mark Off
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Exception Dialog */}
      {selectedForException && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg max-w-sm w-full mx-4 p-6">
            <h2 className="text-lg font-semibold text-white mb-2">
              Mark as Off
            </h2>
            <p className="text-sm text-zinc-400 mb-4">
              {selectedForException.member.name} - {selectedForException.member.email}
            </p>

            <div className="mb-4">
              <label className="block text-xs text-zinc-500 mb-2">Note (Optional)</label>
              <textarea
                value={exceptionNote}
                onChange={(e) => setExceptionNote(e.target.value)}
                placeholder="e.g., Doctor's appointment, Family emergency"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                rows={3}
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setSelectedForException(null);
                  setExceptionNote("");
                }}
                disabled={exceptionLoading}
                className="flex-1 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateException}
                disabled={exceptionLoading}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
              >
                {exceptionLoading ? "Saving..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit drawer */}
      {editMember && (
        <EditDrawer
          member={editMember}
          stores={stores}
          onClose={() => setEditMember(null)}
          onSaved={onSaved}
          onDeleted={() => { setEditMember(null); fetchAll(); }}
        />
      )}
    </div>
  );
}

// ── Leaderboard Panel (W4) ───────────────────────────────────────────────────
// Per-agent performance ranking surfaced INSIDE the Team page (not buried in
// Analytics). Collapsible — defaults closed so the team grid stays the
// primary content; opens when the head wants to compare/coach.
type LeaderboardEntry = {
  userId: number;
  name: string;
  role: string;
  totalAssigned: number;
  completed: number;
  cancelled: number;
  breached: number;
  active: number;
  slaCompliance: number | null;
  avgMinutesToComplete: number | null;
  currentLoad: number;
  maxConcurrentTasks: number;
  utilizationPct: number;
  rank: { byCompleted: number | null; bySlaCompliance: number | null; byVolume: number | null };
};

export function LeaderboardPanel() {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<"24h" | "7d" | "30d">("7d");
  const [sortBy, setSortBy] = useState<"completed" | "sla" | "load">("completed");
  const [data, setData] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError(null);
    fetch(`/api/team/leaderboard?range=${range}`)
      .then((r) => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then((d) => { if (!cancelled) setData(d.entries ?? []); })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, range]);

  const sorted = [...data].sort((a, b) => {
    if (sortBy === "completed") return b.completed - a.completed;
    if (sortBy === "load")      return b.utilizationPct - a.utilizationPct;
    // sla: nulls last
    const av = a.slaCompliance ?? -1;
    const bv = b.slaCompliance ?? -1;
    return bv - av;
  });

  return (
    <div className="mb-5 border border-zinc-800 rounded-lg bg-zinc-900/40">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-zinc-800/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white">Performance leaderboard</span>
          <span className="text-[10px] text-zinc-500">range, sort, and ranks per agent</span>
        </div>
        <svg className={`w-4 h-4 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-zinc-800 p-4 space-y-3">
          <div className="flex items-center justify-between gap-3 text-xs flex-wrap">
            <div className="flex gap-1">
              {(["24h","7d","30d"] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={`px-2 py-1 rounded text-[11px] transition-colors ${range===r ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}
                >{r}</button>
              ))}
            </div>
            <div className="flex gap-1">
              <span className="text-zinc-600 text-[10px] uppercase tracking-wider self-center mr-1">Sort</span>
              {([["completed","Completed"],["sla","SLA"],["load","Load %"]] as const).map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => setSortBy(k)}
                  className={`px-2 py-1 rounded text-[11px] transition-colors ${sortBy===k ? "bg-zinc-700 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}
                >{l}</button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="text-[11px] text-zinc-600 italic py-4 text-center">Loading…</div>
          ) : error ? (
            <div className="text-[11px] text-red-400 py-4 text-center">Failed: {error}</div>
          ) : sorted.length === 0 ? (
            <div className="text-[11px] text-zinc-600 py-4 text-center">No team activity in the last {range}.</div>
          ) : (
            <table className="w-full text-[11px]">
              <thead className="text-[9px] text-zinc-600 uppercase tracking-wider">
                <tr>
                  <th className="text-left px-2 py-1">Agent</th>
                  <th className="text-right px-2 py-1">Completed</th>
                  <th className="text-right px-2 py-1">Breached</th>
                  <th className="text-right px-2 py-1">Cancel</th>
                  <th className="text-right px-2 py-1">SLA %</th>
                  <th className="text-right px-2 py-1">Avg Time</th>
                  <th className="text-right px-2 py-1">Load</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((e) => {
                  const slaClass = e.slaCompliance == null ? "text-zinc-600" :
                    e.slaCompliance >= 90 ? "text-emerald-400" :
                    e.slaCompliance >= 70 ? "text-amber-400" : "text-red-400";
                  const loadClass = e.utilizationPct >= 80 ? "text-red-400" :
                                    e.utilizationPct >= 60 ? "text-amber-400" : "text-zinc-300";
                  return (
                    <tr key={e.userId} className="border-t border-zinc-800/60 hover:bg-zinc-800/40">
                      <td className="px-2 py-1.5">
                        <div className="text-zinc-200">{e.name}</div>
                        <div className="text-[9px] text-zinc-600">
                          rank: done #{e.rank.byCompleted ?? "—"} · sla #{e.rank.bySlaCompliance ?? "—"} · vol #{e.rank.byVolume ?? "—"}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-right text-emerald-300 font-semibold">{e.completed}</td>
                      <td className={`px-2 py-1.5 text-right ${e.breached>0 ? "text-red-400" : "text-zinc-500"}`}>{e.breached}</td>
                      <td className={`px-2 py-1.5 text-right ${e.cancelled>0 ? "text-amber-400" : "text-zinc-500"}`}>{e.cancelled}</td>
                      <td className={`px-2 py-1.5 text-right ${slaClass}`}>
                        {e.slaCompliance == null ? "—" : `${e.slaCompliance}%`}
                      </td>
                      <td className="px-2 py-1.5 text-right text-zinc-400">
                        {e.avgMinutesToComplete == null ? "—" : `${e.avgMinutesToComplete.toFixed(0)}m`}
                      </td>
                      <td className={`px-2 py-1.5 text-right ${loadClass}`}>
                        {e.currentLoad}/{e.maxConcurrentTasks} <span className="text-zinc-600">({e.utilizationPct}%)</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ── Weekly Heatmap (W5) ──────────────────────────────────────────────────────
// Agents × 7-day grid. Each cell tells you whether that agent is working,
// off, on exception, or unscheduled for that date — at a glance. Day-level
// conflict flags (low coverage / everyone off) light up the column header
// red so the head spots gaps without scanning every cell.
type HeatCell = {
  status: "WORKING" | "OFF" | "EXCEPTION" | "UNSCHEDULED";
  shift?: { start: string; end: string; breakStart: string | null; breakEnd: string | null };
  exception?: { kind: string; note?: string };
};

type HeatDay = {
  date: string;
  dayOfWeek: number;
  dayName: string;
  totals: { working: number; off: number; exception: number; unscheduled: number };
  lowCoverage: boolean;
  everyoneOff: boolean;
};

type HeatAgent = { userId: number; name: string; role: string; cells: HeatCell[] };

export function WeeklyHeatmap() {
  const [open, setOpen] = useState(false);
  // weekStart = the Monday of the displayed week. null = "this week".
  const [weekOffset, setWeekOffset] = useState(0); // -1 = last week, 0 = this, +1 = next, ...
  const [data, setData] = useState<{ weekStart: string; weekEnd: string; minCoverage: number; days: HeatDay[]; agents: HeatAgent[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Compute the displayed Monday from `weekOffset`
  const displayedWeekStart = (() => {
    const now = new Date();
    const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const dow = today.getUTCDay();
    const offsetToMon = (dow + 6) % 7;
    const monday = new Date(today);
    monday.setUTCDate(monday.getUTCDate() - offsetToMon + weekOffset * 7);
    return monday.toISOString().slice(0, 10);
  })();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError(null);
    fetch(`/api/team/heatmap?weekStart=${displayedWeekStart}`)
      .then((r) => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, displayedWeekStart]);

  return (
    <div className="mb-5 border border-zinc-800 rounded-lg bg-zinc-900/40">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-zinc-800/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white">Weekly heatmap</span>
          <span className="text-[10px] text-zinc-500">agents × days, with coverage warnings</span>
        </div>
        <svg className={`w-4 h-4 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-zinc-800 p-4 space-y-3">
          {/* Week navigator */}
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setWeekOffset((w) => w - 1)}
                className="px-2 py-1 rounded bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
                title="Previous week"
              >
                ‹
              </button>
              <span className="text-zinc-300 font-medium px-2">
                {data ? `${data.weekStart} → ${data.weekEnd}` : displayedWeekStart}
              </span>
              <button
                onClick={() => setWeekOffset((w) => w + 1)}
                className="px-2 py-1 rounded bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
                title="Next week"
              >
                ›
              </button>
              <button
                onClick={() => setWeekOffset(0)}
                className="px-2 py-1 rounded bg-zinc-800 text-zinc-400 hover:text-white transition-colors text-[10px]"
                title="This week"
              >
                Today
              </button>
            </div>
            {/* Legend */}
            <div className="flex items-center gap-3 text-[10px] text-zinc-500">
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-emerald-600" /> Working</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-zinc-700" /> Off</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-amber-600" /> Exception</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded border border-zinc-700" /> Unscheduled</span>
            </div>
          </div>

          {loading ? (
            <div className="text-[11px] text-zinc-600 italic py-4 text-center">Loading…</div>
          ) : error ? (
            <div className="text-[11px] text-red-400 py-4 text-center">Failed: {error}</div>
          ) : !data || data.agents.length === 0 ? (
            <div className="text-[11px] text-zinc-600 py-4 text-center">No agents to show.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px] border-separate" style={{ borderSpacing: "2px" }}>
                <thead>
                  <tr>
                    <th className="text-left text-[10px] text-zinc-600 uppercase tracking-wider px-2 py-1 sticky left-0 bg-zinc-900/40 z-10">Agent</th>
                    {data.days.map((day) => {
                      const flagged = day.everyoneOff || day.lowCoverage;
                      return (
                        <th
                          key={day.date}
                          className={`text-center text-[10px] px-2 py-1 ${flagged ? "text-red-400" : "text-zinc-500"}`}
                          title={
                            day.everyoneOff ? "Coverage gap — no agent working this day" :
                            day.lowCoverage ? `Low coverage — only ${day.totals.working} working` :
                            `${day.totals.working} working`
                          }
                        >
                          <div className="font-semibold">{day.dayName}</div>
                          <div className="text-[9px] font-normal">{day.date.slice(5)}</div>
                          <div className="text-[9px] font-mono mt-0.5">
                            {flagged && "⚠ "}
                            <span className={day.totals.working === 0 ? "text-red-400" : "text-emerald-400"}>{day.totals.working}</span>
                            <span className="text-zinc-700">/</span>
                            <span className="text-zinc-500">{data.agents.length}</span>
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {data.agents.map((a) => (
                    <tr key={a.userId}>
                      <td className="text-zinc-300 text-[11px] px-2 py-1.5 sticky left-0 bg-zinc-900/40 z-10 whitespace-nowrap">
                        {a.name}
                      </td>
                      {a.cells.map((cell, idx) => {
                        const cls =
                          cell.status === "WORKING"  ? "bg-emerald-600/40 text-emerald-200 border-emerald-700/40" :
                          cell.status === "OFF"      ? "bg-zinc-800 text-zinc-600 border-zinc-700/40" :
                          cell.status === "EXCEPTION" ? "bg-amber-600/40 text-amber-200 border-amber-700/40" :
                          "bg-transparent text-zinc-700 border-zinc-800 border-dashed";
                        const tooltip =
                          cell.status === "WORKING" && cell.shift ? `${cell.shift.start}–${cell.shift.end}${cell.shift.breakStart ? ` (break ${cell.shift.breakStart}–${cell.shift.breakEnd})` : ""}${cell.exception ? ` · exception: ${cell.exception.kind}` : ""}` :
                          cell.status === "EXCEPTION" && cell.exception ? `${cell.exception.kind}${cell.exception.note ? `: ${cell.exception.note}` : ""}` :
                          cell.status === "OFF" ? "Off" :
                          "Unscheduled — no shift defined";
                        return (
                          <td
                            key={idx}
                            className={`text-center text-[10px] px-2 py-1.5 border rounded ${cls}`}
                            title={tooltip}
                          >
                            {cell.status === "WORKING" && cell.shift ? (
                              <div className="leading-tight">
                                <div className="font-mono">{cell.shift.start.slice(0, 5)}</div>
                                <div className="font-mono opacity-70">{cell.shift.end.slice(0, 5)}</div>
                              </div>
                            ) : cell.status === "EXCEPTION" && cell.exception ? (
                              cell.exception.kind.slice(0, 4)
                            ) : cell.status === "OFF" ? (
                              "·"
                            ) : (
                              "—"
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Conflict summary */}
              {data.days.some((d) => d.everyoneOff || d.lowCoverage) && (
                <div className="mt-3 px-3 py-2 rounded bg-red-950/40 border border-red-900/40 text-[11px] text-red-300">
                  <strong>Coverage warnings:</strong>{" "}
                  {data.days.filter((d) => d.everyoneOff || d.lowCoverage).map((d, i, arr) => (
                    <span key={d.date}>
                      {d.dayName} {d.date.slice(5)} ({d.everyoneOff ? "no agents" : `only ${d.totals.working}`})
                      {i < arr.length - 1 && ", "}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Coverage Heatmap (W5b — hour × day) ─────────────────────────────────────
// Answers the question the agent×day heatmap can't: "is anyone working at
// 7pm Tuesday?". Rows = half-hour slots inside the operating window
// (default 06:00–22:30); columns = days of the week. Each cell shows the
// number of agents on-shift at that exact slot. Colour-coded so the head
// can spot gaps (red) and over-coverage (deep green) at a glance.
type CoverageSlot = { time: string; dayCounts: number[] };
type CoveragePayload = {
  weekStart: string;
  weekEnd: string;
  hourFrom: string;
  hourTo: string;
  intervalMinutes: number;
  lowCoverageThreshold: number;
  days: string[];
  dates: string[];
  slots: CoverageSlot[];
  summary: { totalSlots: number; gapSlots: number; lowCoverageSlots: number; peakConcurrent: number; agentsConsidered: number };
};

export function CoverageHeatmap() {
  const [open, setOpen] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);
  const [hourFrom, setHourFrom] = useState("06:00");
  const [hourTo, setHourTo] = useState("22:30");
  const [interval, setIntervalMin] = useState<15 | 30 | 60>(30);
  const [lowCoverage, setLowCoverage] = useState(1);
  const [data, setData] = useState<CoveragePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const displayedWeekStart = (() => {
    const now = new Date();
    const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const dow = today.getUTCDay();
    const offsetToMon = (dow + 6) % 7;
    const monday = new Date(today);
    monday.setUTCDate(monday.getUTCDate() - offsetToMon + weekOffset * 7);
    return monday.toISOString().slice(0, 10);
  })();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError(null);
    const qs = new URLSearchParams({
      weekStart: displayedWeekStart,
      hourFrom, hourTo,
      interval: String(interval),
      lowCoverage: String(lowCoverage),
    });
    fetch(`/api/team/coverage?${qs}`)
      .then((r) => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, displayedWeekStart, hourFrom, hourTo, interval, lowCoverage]);

  // Colour each cell by count vs the peak so the gradient adapts to the team size.
  const cellClass = (count: number, peak: number, threshold: number) => {
    if (count === 0) return "bg-red-900/60 text-red-200";
    if (count < threshold) return "bg-amber-700/40 text-amber-100";
    if (peak <= 0) return "bg-zinc-800 text-zinc-300";
    const ratio = count / peak;
    if (ratio >= 0.8) return "bg-emerald-600/70 text-emerald-50";
    if (ratio >= 0.5) return "bg-emerald-700/50 text-emerald-100";
    return "bg-emerald-800/40 text-emerald-200";
  };

  return (
    <div className="mb-5 border border-zinc-800 rounded-lg bg-zinc-900/40">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-zinc-800/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white">Coverage by hour</span>
          <span className="text-[10px] text-zinc-500">how many agents are on-shift each half-hour — find your gaps</span>
        </div>
        <svg className={`w-4 h-4 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-zinc-800 p-4 space-y-3">
          {/* Controls */}
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <div className="flex items-center gap-1">
              <button onClick={() => setWeekOffset((w) => w - 1)} className="px-2 py-1 rounded bg-zinc-800 text-zinc-400 hover:text-white transition-colors">‹</button>
              <span className="text-zinc-300 font-medium px-2">{data ? `${data.weekStart} → ${data.weekEnd}` : displayedWeekStart}</span>
              <button onClick={() => setWeekOffset((w) => w + 1)} className="px-2 py-1 rounded bg-zinc-800 text-zinc-400 hover:text-white transition-colors">›</button>
              <button onClick={() => setWeekOffset(0)} className="ml-1 px-2 py-1 rounded bg-zinc-800 text-zinc-400 hover:text-white transition-colors text-[10px]">Today</button>
            </div>

            <label className="flex items-center gap-2 text-zinc-500">
              From
              <input
                type="time"
                value={hourFrom}
                onChange={(e) => setHourFrom(e.target.value || "06:00")}
                step={1800}
                className="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-zinc-200 text-[11px] [color-scheme:dark]"
              />
            </label>

            <label className="flex items-center gap-2 text-zinc-500">
              To
              <input
                type="time"
                value={hourTo}
                onChange={(e) => setHourTo(e.target.value || "22:30")}
                step={1800}
                className="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-zinc-200 text-[11px] [color-scheme:dark]"
              />
            </label>

            <div className="flex items-center gap-1">
              <span className="text-zinc-600 text-[10px] uppercase tracking-wider">Slot</span>
              {([15, 30, 60] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setIntervalMin(m)}
                  className={`px-2 py-1 rounded text-[11px] transition-colors ${interval === m ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}
                >{m}m</button>
              ))}
            </div>

            <label className="flex items-center gap-2 text-zinc-500" title="Slots with fewer than this many agents are flagged as low-coverage.">
              Low cov &lt;
              <input
                type="number" min={1} max={20}
                value={lowCoverage}
                onChange={(e) => setLowCoverage(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                className="w-12 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-zinc-200 text-[11px] text-center"
              />
            </label>
          </div>

          {/* Body */}
          {loading ? (
            <div className="text-[11px] text-zinc-600 italic py-4 text-center">Loading…</div>
          ) : error ? (
            <div className="text-[11px] text-red-400 py-4 text-center">Failed: {error}</div>
          ) : !data || data.slots.length === 0 ? (
            <div className="text-[11px] text-zinc-600 py-4 text-center">No data.</div>
          ) : (
            <>
              {/* Summary chips */}
              <div className="flex flex-wrap gap-2 text-[11px]">
                <span className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300">
                  {data.summary.agentsConsidered} agents
                </span>
                <span className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300">
                  Peak: <strong className="text-emerald-400">{data.summary.peakConcurrent}</strong> concurrent
                </span>
                <span className={`px-2 py-1 rounded border ${data.summary.gapSlots > 0 ? "bg-red-900/30 border-red-900 text-red-300" : "bg-zinc-800 border-zinc-700 text-zinc-400"}`}>
                  Gaps: <strong>{data.summary.gapSlots}</strong> slots with <strong>0</strong> coverage
                </span>
                <span className={`px-2 py-1 rounded border ${data.summary.lowCoverageSlots > 0 ? "bg-amber-900/30 border-amber-900 text-amber-300" : "bg-zinc-800 border-zinc-700 text-zinc-400"}`}>
                  Low cov: <strong>{data.summary.lowCoverageSlots}</strong> slots &lt; {data.lowCoverageThreshold}
                </span>
              </div>

              {/* Heatmap table */}
              <div className="overflow-x-auto">
                <table className="text-[10px] border-separate" style={{ borderSpacing: "1px" }}>
                  <thead>
                    <tr>
                      <th className="text-left px-2 py-1 sticky left-0 bg-zinc-900/40 z-10 text-zinc-600 uppercase tracking-wider"></th>
                      {data.days.map((day, i) => (
                        <th key={i} className="text-center px-2 py-1 text-zinc-500 min-w-[3rem]">
                          <div className="font-semibold">{day}</div>
                          <div className="text-[9px] font-normal">{data.dates[i].slice(5)}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.slots.map((slot) => (
                      <tr key={slot.time}>
                        <td className="text-right pr-2 py-1 sticky left-0 bg-zinc-900/40 z-10 font-mono text-zinc-500 text-[10px]">
                          {slot.time}
                        </td>
                        {slot.dayCounts.map((count, dayIdx) => (
                          <td
                            key={dayIdx}
                            className={`text-center font-mono text-[11px] ${cellClass(count, data.summary.peakConcurrent, data.lowCoverageThreshold)}`}
                            title={`${data.days[dayIdx]} ${data.dates[dayIdx]} ${slot.time} — ${count} agent${count === 1 ? "" : "s"} on-shift`}
                            style={{ minWidth: "3rem" }}
                          >
                            {count}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
