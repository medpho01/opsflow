"use client";

import { useState, useEffect, useCallback } from "react";

type RosterStatus = "ACTIVE" | "ON_FIELD" | "ON_LEAVE" | "OFF";

interface RosterMember {
  userId: number;
  name: string;
  email: string;
  role: string;
  teamMemberId: number | null;
  maxConcurrentTasks: number;
  storeIds: number[];
  skills: string[];
  openTaskCount: number;
  rosterEntry: {
    id: number;
    status: RosterStatus;
    note: string | null;
  } | null;
}

const STATUS_CONFIG: Record<RosterStatus, { label: string; color: string; bg: string; dot: string }> = {
  ACTIVE: {
    label: "Active",
    color: "text-emerald-400",
    bg: "bg-emerald-500/10 border-emerald-500/20",
    dot: "bg-emerald-400",
  },
  ON_FIELD: {
    label: "On Field",
    color: "text-blue-400",
    bg: "bg-blue-500/10 border-blue-500/20",
    dot: "bg-blue-400",
  },
  ON_LEAVE: {
    label: "On Leave",
    color: "text-amber-400",
    bg: "bg-amber-500/10 border-amber-500/20",
    dot: "bg-amber-400",
  },
  OFF: {
    label: "Off",
    color: "text-zinc-500",
    bg: "bg-zinc-800/50 border-zinc-700/30",
    dot: "bg-zinc-600",
  },
};

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function displayDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short", year: "numeric" });
}

export default function RosterPanel() {
  const [selectedDate, setSelectedDate] = useState(formatDate(new Date()));
  const [members, setMembers] = useState<RosterMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<number | null>(null); // teamMemberId being saved
  const [error, setError] = useState<string | null>(null);

  const fetchRoster = useCallback(async (date: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/roster?date=${date}`);
      if (!res.ok) throw new Error("Failed to load roster");
      const data = await res.json();
      setMembers(data.members ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load roster");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRoster(selectedDate);
  }, [selectedDate, fetchRoster]);

  async function updateStatus(member: RosterMember, status: RosterStatus) {
    if (!member.teamMemberId) return;
    setSaving(member.teamMemberId);
    try {
      const res = await fetch("/api/roster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamMemberId: member.teamMemberId,
          date: selectedDate,
          status,
          note: member.rosterEntry?.note ?? null,
        }),
      });
      if (!res.ok) throw new Error("Failed to update");
      const data = await res.json();
      setMembers((prev) =>
        prev.map((m) =>
          m.teamMemberId === member.teamMemberId
            ? { ...m, rosterEntry: data.entry }
            : m
        )
      );
    } catch {
      setError("Failed to update roster");
    } finally {
      setSaving(null);
    }
  }

  async function setAllStatus(status: RosterStatus) {
    const eligible = members.filter((m) => m.teamMemberId !== null);
    for (const m of eligible) {
      await updateStatus(m, status);
    }
  }

  const counts = members.reduce(
    (acc, m) => {
      const s = (m.rosterEntry?.status as RosterStatus) ?? "OFF";
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-white">Daily Roster</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            Set who&apos;s available for task assignment each day.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="px-3 py-1.5 text-sm bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* Date display */}
      <p className="text-xs text-zinc-500">{displayDate(selectedDate)}</p>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(["ACTIVE", "ON_FIELD", "ON_LEAVE", "OFF"] as RosterStatus[]).map((s) => {
          const cfg = STATUS_CONFIG[s];
          return (
            <div key={s} className={`rounded-lg border px-4 py-3 ${cfg.bg}`}>
              <div className={`text-lg font-bold ${cfg.color}`}>{counts[s] ?? 0}</div>
              <div className={`text-xs mt-0.5 ${cfg.color} opacity-80`}>{cfg.label}</div>
            </div>
          );
        })}
      </div>

      {/* Quick actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-zinc-500 mr-1">Set all:</span>
        {(["ACTIVE", "ON_FIELD", "ON_LEAVE", "OFF"] as RosterStatus[]).map((s) => {
          const cfg = STATUS_CONFIG[s];
          return (
            <button
              key={s}
              onClick={() => setAllStatus(s)}
              disabled={saving !== null}
              className={`px-3 py-1 rounded-lg text-xs font-medium border transition-colors disabled:opacity-40 ${cfg.bg} ${cfg.color}`}
            >
              {cfg.label}
            </button>
          );
        })}
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Member grid */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
        </div>
      ) : members.length === 0 ? (
        <div className="text-center py-16 text-zinc-600 text-sm">No team members found</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {members.map((member) => {
            const currentStatus = (member.rosterEntry?.status as RosterStatus) ?? "OFF";
            const cfg = STATUS_CONFIG[currentStatus];
            const isSaving = saving === member.teamMemberId;

            return (
              <div
                key={member.userId}
                className={`relative rounded-xl border bg-zinc-900/60 p-4 transition-all ${
                  isSaving ? "opacity-60" : ""
                }`}
              >
                {isSaving && (
                  <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-zinc-900/60 z-10">
                    <div className="w-4 h-4 border-2 border-zinc-600 border-t-blue-400 rounded-full animate-spin" />
                  </div>
                )}

                {/* Member header */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-semibold text-zinc-300 shrink-0">
                      {member.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-zinc-200 truncate">{member.name}</div>
                      <div className="text-[10px] text-zinc-500">
                        {member.role === "STORE_ADMIN" ? "Store Admin" : "Ops Agent"}
                        {member.storeIds.length > 0 && ` · ${member.storeIds.length} store${member.storeIds.length > 1 ? "s" : ""}`}
                      </div>
                    </div>
                  </div>
                  {/* Status badge */}
                  <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-semibold ${cfg.bg} ${cfg.color}`}>
                    <div className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                    {cfg.label}
                  </div>
                </div>

                {/* Stats */}
                <div className="flex items-center gap-3 mb-3 text-xs text-zinc-500">
                  <span>{member.openTaskCount} / {member.maxConcurrentTasks} tasks</span>
                  {member.skills.length > 0 && (
                    <span className="truncate">{member.skills.slice(0, 2).join(", ")}{member.skills.length > 2 ? "…" : ""}</span>
                  )}
                </div>

                {/* Status buttons */}
                <div className="grid grid-cols-4 gap-1">
                  {(["ACTIVE", "ON_FIELD", "ON_LEAVE", "OFF"] as RosterStatus[]).map((s) => {
                    const sCfg = STATUS_CONFIG[s];
                    const isSelected = currentStatus === s;
                    return (
                      <button
                        key={s}
                        onClick={() => updateStatus(member, s)}
                        disabled={isSaving || !member.teamMemberId}
                        className={`py-1.5 px-1 rounded-lg text-[10px] font-medium border transition-all disabled:cursor-not-allowed ${
                          isSelected
                            ? `${sCfg.bg} ${sCfg.color} border-current`
                            : "bg-zinc-800/50 border-zinc-700 text-zinc-500 hover:border-zinc-600 hover:text-zinc-400"
                        }`}
                      >
                        {sCfg.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
