"use client";

import { useEffect, useState, useCallback } from "react";

interface EscalationLevel {
  id: number;
  levelNumber: number;
  delayMinutes: number;
  channelType: string;
  notifyUser: { id: number; name: string; role: string } | null;
}

interface EscalationChain {
  id: number;
  name: string;
  isActive: boolean;
  createdAt: string;
  levels: EscalationLevel[];
  _count: { rules: number };
}

interface TeamMember {
  id: number;
  name: string;
  email: string;
  role: string;
}

const CHANNEL_LABELS: Record<string, string> = {
  IN_APP: "In-App",
  WHATSAPP: "WhatsApp",
  SMS: "SMS",
  EMAIL: "Email",
};

const CHANNEL_COLORS: Record<string, string> = {
  IN_APP: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  WHATSAPP: "bg-green-500/15 text-green-300 border-green-500/30",
  SMS: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  EMAIL: "bg-purple-500/15 text-purple-300 border-purple-500/30",
};

function formatDelay(minutes: number): string {
  if (minutes === 0) return "Immediately";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ─── Add Level Row ─────────────────────────────────────────────────────────
function AddLevelRow({
  chainId,
  teamMembers,
  onAdded,
}: {
  chainId: number;
  teamMembers: TeamMember[];
  onAdded: () => void;
}) {
  const [show, setShow] = useState(false);
  const [delayMinutes, setDelayMinutes] = useState(30);
  const [channelType, setChannelType] = useState("IN_APP");
  const [notifyUserId, setNotifyUserId] = useState<number | "">("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (notifyUserId === "") { setErr("Select a user to notify"); return; }
    setSaving(true); setErr("");
    try {
      const res = await fetch(`/api/escalations/${chainId}/levels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delayMinutes: Number(delayMinutes), channelType, notifyUserId: Number(notifyUserId) }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? "Failed"); return; }
      setShow(false);
      setDelayMinutes(30); setChannelType("IN_APP"); setNotifyUserId("");
      onAdded();
    } finally {
      setSaving(false);
    }
  }

  if (!show) {
    return (
      <button
        onClick={() => setShow(true)}
        className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 mt-2 transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
        Add Escalation Level
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 p-3 bg-zinc-800 rounded-lg border border-zinc-700">
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div>
          <label className="block text-[10px] text-zinc-500 mb-1">Delay (minutes)</label>
          <input
            type="number" min={0} value={delayMinutes}
            onChange={(e) => setDelayMinutes(parseInt(e.target.value) || 0)}
            className="w-full px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-[10px] text-zinc-500 mb-1">Channel</label>
          <select
            value={channelType}
            onChange={(e) => setChannelType(e.target.value)}
            className="w-full px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {Object.entries(CHANNEL_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-zinc-500 mb-1">Notify User</label>
          <select
            value={notifyUserId}
            onChange={(e) => setNotifyUserId(e.target.value === "" ? "" : parseInt(e.target.value))}
            className="w-full px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">Select user</option>
            {teamMembers.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
      </div>
      {err && <p className="text-xs text-red-400 mb-2">{err}</p>}
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={() => setShow(false)} className="px-3 py-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Cancel</button>
        <button type="submit" disabled={saving} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg disabled:opacity-50 transition-colors">
          {saving ? "Adding..." : "Add Level"}
        </button>
      </div>
    </form>
  );
}

// ─── Chain Card ───────────────────────────────────────────────────────────────
function ChainCard({
  chain,
  teamMembers,
  onRefresh,
}: {
  chain: EscalationChain;
  teamMembers: TeamMember[];
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editName, setEditName] = useState(false);
  const [name, setName] = useState(chain.name);
  const [savingToggle, setSavingToggle] = useState(false);
  const [deletingLevel, setDeletingLevel] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function toggleActive() {
    setSavingToggle(true);
    try {
      await fetch(`/api/escalations/${chain.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !chain.isActive }),
      });
      onRefresh();
    } finally {
      setSavingToggle(false);
    }
  }

  async function saveName() {
    if (!name.trim() || name.trim() === chain.name) { setEditName(false); return; }
    await fetch(`/api/escalations/${chain.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    setEditName(false);
    onRefresh();
  }

  async function deleteLevel(levelId: number) {
    setDeletingLevel(levelId);
    try {
      await fetch(`/api/escalations/${chain.id}/levels`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ levelId }),
      });
      onRefresh();
    } finally {
      setDeletingLevel(null);
    }
  }

  async function deleteChain() {
    const res = await fetch(`/api/escalations/${chain.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json();
      alert(data.error ?? "Cannot delete");
      return;
    }
    onRefresh();
  }

  return (
    <div className={`bg-zinc-900 border rounded-xl overflow-hidden transition-colors ${
      chain.isActive ? "border-zinc-800" : "border-zinc-800/50 opacity-70"
    }`}>
      {/* Chain header */}
      <div className="px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex-1 text-left flex items-center gap-3 min-w-0"
        >
          <svg
            className={`w-3.5 h-3.5 text-zinc-500 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>

          {editName ? (
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => { if (e.key === "Enter") saveName(); if (e.key === "Escape") { setName(chain.name); setEditName(false); } }}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          ) : (
            <span className="text-sm font-medium text-zinc-100 truncate">{chain.name}</span>
          )}
        </button>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-zinc-500">{chain.levels.length} level{chain.levels.length !== 1 ? "s" : ""}</span>

          {chain._count.rules > 0 && (
            <span className="text-[10px] bg-blue-500/15 text-blue-300 border border-blue-500/30 px-1.5 py-0.5 rounded-full">
              {chain._count.rules} rule{chain._count.rules !== 1 ? "s" : ""}
            </span>
          )}

          {/* Rename */}
          <button
            onClick={(e) => { e.stopPropagation(); setEditName(true); setExpanded(true); }}
            className="p-1 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
            title="Rename"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>

          {/* Active toggle */}
          <button
            onClick={toggleActive}
            disabled={savingToggle}
            className={`relative w-8 h-4.5 rounded-full transition-colors disabled:opacity-50 ${chain.isActive ? "bg-blue-600" : "bg-zinc-700"}`}
            title={chain.isActive ? "Deactivate" : "Activate"}
          >
            <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${chain.isActive ? "left-4" : "left-0.5"}`} />
          </button>

          {/* Delete */}
          {!confirmDelete ? (
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
              className="p-1 rounded text-zinc-600 hover:text-red-400 hover:bg-zinc-800 transition-colors"
              title="Delete chain"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          ) : (
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <button onClick={deleteChain} className="text-[10px] text-red-400 hover:text-red-300 font-medium px-1.5 py-0.5 bg-red-500/10 rounded border border-red-500/20 transition-colors">
                Confirm
              </button>
              <button onClick={() => setConfirmDelete(false)} className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors px-1">
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Expanded levels */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-zinc-800">
          {chain.levels.length === 0 ? (
            <p className="text-xs text-zinc-600 py-3 text-center">No escalation levels yet. Add one below.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {chain.levels.map((level) => (
                <div key={level.id} className="flex items-center gap-3 p-2.5 bg-zinc-800/60 rounded-lg group">
                  {/* Level number badge */}
                  <div className="w-6 h-6 rounded-full bg-zinc-700 flex items-center justify-center text-[10px] font-bold text-zinc-400 shrink-0">
                    {level.levelNumber}
                  </div>

                  <div className="flex-1 min-w-0 flex items-center gap-3 flex-wrap">
                    <span className="text-xs text-zinc-500">
                      {formatDelay(level.delayMinutes)} after SLA breach
                    </span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${CHANNEL_COLORS[level.channelType] ?? "bg-zinc-700 text-zinc-400 border-zinc-600"}`}>
                      {CHANNEL_LABELS[level.channelType] ?? level.channelType}
                    </span>
                    {level.notifyUser && (
                      <span className="text-xs text-zinc-300 font-medium truncate">
                        → {level.notifyUser.name}
                      </span>
                    )}
                  </div>

                  <button
                    onClick={() => deleteLevel(level.id)}
                    disabled={deletingLevel === level.id}
                    className="shrink-0 p-1 rounded text-zinc-700 hover:text-red-400 group-hover:text-zinc-600 transition-colors disabled:opacity-50"
                    title="Remove level"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          <AddLevelRow chainId={chain.id} teamMembers={teamMembers} onAdded={onRefresh} />
        </div>
      )}
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────
export default function EscalationChainsPanel() {
  const [chains, setChains] = useState<EscalationChain[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState("");

  const fetchAll = useCallback(async () => {
    try {
      const [chainRes, teamRes] = await Promise.all([
        fetch("/api/escalations"),
        fetch("/api/team"),
      ]);
      const [chainData, teamData] = await Promise.all([chainRes.json(), teamRes.json()]);
      setChains(chainData.chains ?? []);
      setTeamMembers(teamData.members ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  async function createChain(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true); setCreateErr("");
    try {
      const res = await fetch("/api/escalations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setCreateErr(data.error ?? "Failed"); return; }
      setNewName("");
      fetchAll();
    } finally {
      setCreating(false);
    }
  }

  const activeCount = chains.filter((c) => c.isActive).length;

  return (
    <div className="h-full flex flex-col bg-zinc-950">
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-zinc-800">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-base font-semibold text-white">Escalation Chains</h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              {chains.length} chain{chains.length !== 1 ? "s" : ""} · {activeCount} active
            </p>
          </div>
        </div>

        {/* Create new chain */}
        <form onSubmit={createChain} className="flex items-center gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New chain name (e.g. Phlebo Delay Chain)"
            className="flex-1 px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
          />
          <button
            type="submit"
            disabled={creating || !newName.trim()}
            className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg disabled:opacity-50 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            {creating ? "Creating..." : "Create Chain"}
          </button>
        </form>
        {createErr && <p className="text-xs text-red-400 mt-2">{createErr}</p>}
      </div>

      <div className="flex-1 overflow-auto px-6 py-5">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-5 h-5 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
          </div>
        ) : chains.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-center">
            <svg className="w-10 h-10 text-zinc-800 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <p className="text-sm text-zinc-600 font-medium">No escalation chains</p>
            <p className="text-xs text-zinc-700 mt-1">Create a chain above, then add escalation levels to it</p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* How it works hint */}
            <div className="flex items-start gap-2 px-3 py-2.5 bg-blue-500/5 border border-blue-500/15 rounded-lg">
              <svg className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                Levels fire sequentially after a task breaches SLA. Each level notifies a user via the chosen channel after the specified delay. Chains are linked to task rules.
              </p>
            </div>

            {chains.map((chain) => (
              <ChainCard
                key={chain.id}
                chain={chain}
                teamMembers={teamMembers}
                onRefresh={fetchAll}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
