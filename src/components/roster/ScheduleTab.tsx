"use client";

import React, { useState, useEffect } from "react";

interface ScheduleDay {
  dayOfWeek: number;
  isWorking: boolean;
  startTime?: string;
  endTime?: string;
  breakStart?: string;
  breakEnd?: string;
}

interface ScheduleTabProps {
  userId: number;
  onSaved?: () => void;
  onScheduleChange?: (schedule: ScheduleDay[]) => void;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const DEFAULT_SCHEDULE: ScheduleDay[] = Array.from({ length: 7 }, (_, i) => ({
  dayOfWeek: i,
  isWorking: i >= 1 && i <= 5, // Mon–Fri working by default
  startTime: "09:00",
  endTime: "18:00",
}));

function TimeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] font-medium text-zinc-500 uppercase tracking-wide">{label}</label>
      <input
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    </div>
  );
}

export default function ScheduleTab({ userId, onScheduleChange }: ScheduleTabProps) {
  const [schedule, setSchedule] = useState<ScheduleDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copyFromDay, setCopyFromDay] = useState<number | null>(null);

  useEffect(() => {
    const fetchSchedule = async () => {
      try {
        const res = await fetch(`/api/roster/schedule/${userId}`);
        if (!res.ok) throw new Error("Failed to load schedule");
        const data = await res.json();
        const loaded: ScheduleDay[] = data.schedule ?? [];
        // Ensure all 7 days exist
        const merged = Array.from({ length: 7 }, (_, i) => {
          const existing = loaded.find((d) => d.dayOfWeek === i);
          return existing ?? { dayOfWeek: i, isWorking: false };
        });
        setSchedule(merged);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error loading schedule");
        setSchedule(DEFAULT_SCHEDULE);
      } finally {
        setLoading(false);
      }
    };
    fetchSchedule();
  }, [userId]);

  // Propagate changes to parent (TeamPanel saves on "Save Changes")
  useEffect(() => {
    if (schedule.length > 0) onScheduleChange?.(schedule);
  }, [schedule, onScheduleChange]);

  const updateDay = (dayOfWeek: number, patch: Partial<ScheduleDay>) => {
    setSchedule((prev) =>
      prev.map((d) => (d.dayOfWeek === dayOfWeek ? { ...d, ...patch } : d))
    );
    setError(null);
  };

  const copyTo = (fromDow: number, toDow: number) => {
    const src = schedule.find((d) => d.dayOfWeek === fromDow);
    if (!src) return;
    updateDay(toDow, {
      isWorking: src.isWorking,
      startTime: src.startTime,
      endTime: src.endTime,
      breakStart: src.breakStart,
      breakEnd: src.breakEnd,
    });
    setCopyFromDay(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-zinc-500 text-sm">
        Loading schedule…
      </div>
    );
  }

  return (
    <div className="space-y-1 pb-2">
      <p className="text-xs text-zinc-500 pb-3">
        Configure working hours for each day. Click <span className="text-zinc-300">Save Changes</span> below to persist.
      </p>

      {error && (
        <div className="mb-3 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
          {error}
        </div>
      )}

      {schedule.map((day) => (
        <div
          key={day.dayOfWeek}
          className={`rounded-lg border transition-colors ${
            day.isWorking
              ? "border-zinc-700 bg-zinc-800/50"
              : "border-zinc-800 bg-zinc-900/30"
          }`}
        >
          {/* Day header */}
          <div className="flex items-center justify-between px-3 py-2.5">
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <div className="relative">
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={day.isWorking}
                  onChange={(e) => updateDay(day.dayOfWeek, { isWorking: e.target.checked })}
                />
                <div
                  className={`w-8 h-4 rounded-full transition-colors ${
                    day.isWorking ? "bg-blue-600" : "bg-zinc-700"
                  }`}
                />
                <div
                  className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                    day.isWorking ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </div>
              <span className={`text-xs font-medium ${day.isWorking ? "text-white" : "text-zinc-500"}`}>
                {DAYS[day.dayOfWeek]}
              </span>
            </label>

            {day.isWorking && (
              <div className="flex items-center gap-2">
                {day.startTime && day.endTime && (
                  <span className="text-[10px] text-zinc-500 font-mono">
                    {day.startTime}–{day.endTime}
                  </span>
                )}
                <button
                  onClick={() => setCopyFromDay(copyFromDay === day.dayOfWeek ? null : day.dayOfWeek)}
                  className="text-[10px] px-2 py-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
                >
                  Copy from…
                </button>
              </div>
            )}
          </div>

          {/* Copy-from picker */}
          {copyFromDay === day.dayOfWeek && (
            <div className="px-3 pb-2.5 flex flex-wrap gap-1.5">
              {schedule
                .filter((d) => d.isWorking && d.dayOfWeek !== day.dayOfWeek)
                .map((src) => (
                  <button
                    key={src.dayOfWeek}
                    onClick={() => copyTo(src.dayOfWeek, day.dayOfWeek)}
                    className="text-[10px] px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors"
                  >
                    {DAYS[src.dayOfWeek]}
                  </button>
                ))}
              {schedule.filter((d) => d.isWorking && d.dayOfWeek !== day.dayOfWeek).length === 0 && (
                <span className="text-[10px] text-zinc-600">No other working days to copy from</span>
              )}
            </div>
          )}

          {/* Time inputs */}
          {day.isWorking && (
            <div className="px-3 pb-3 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <TimeInput
                  label="Start"
                  value={day.startTime ?? ""}
                  onChange={(v) => updateDay(day.dayOfWeek, { startTime: v })}
                />
                <TimeInput
                  label="End"
                  value={day.endTime ?? ""}
                  onChange={(v) => updateDay(day.dayOfWeek, { endTime: v })}
                />
              </div>

              <div>
                <p className="text-[10px] font-medium text-zinc-600 uppercase tracking-wide mb-1.5">
                  Break <span className="normal-case text-zinc-700">(optional)</span>
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <TimeInput
                    label="Break start"
                    value={day.breakStart ?? ""}
                    onChange={(v) => updateDay(day.dayOfWeek, { breakStart: v || undefined })}
                  />
                  <TimeInput
                    label="Break end"
                    value={day.breakEnd ?? ""}
                    onChange={(v) => updateDay(day.dayOfWeek, { breakEnd: v || undefined })}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
