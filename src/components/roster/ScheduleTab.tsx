"use client";

import React, { useState, useEffect } from "react";
import { validateSchedule } from "@/lib/roster/utils";
import styles from "./roster.module.css";

interface ScheduleDay {
  dayOfWeek: number;
  isWorking: boolean;
  startTime?: string;
  endTime?: string;
  breakStart?: string;
  breakEnd?: string;
}

interface CopyDialogState {
  isOpen: boolean;
  targetDay: number | null;
}

interface ScheduleTabProps {
  userId: number;
  onSaved?: () => void;
  onScheduleChange?: (schedule: ScheduleDay[]) => void;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function ScheduleTab({ userId, onSaved, onScheduleChange }: ScheduleTabProps) {
  const [schedule, setSchedule] = useState<ScheduleDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [copyDialog, setCopyDialog] = useState<CopyDialogState>({ isOpen: false, targetDay: null });

  // Load existing schedule on mount
  useEffect(() => {
    const fetchSchedule = async () => {
      try {
        console.log("Fetching schedule for userId:", userId);
        const res = await fetch(`/api/roster/schedule/${userId}`);
        console.log("GET response status:", res.status);
        if (!res.ok) throw new Error("Failed to load schedule");
        const data = await res.json();
        console.log("Schedule data loaded:", data);
        setSchedule(data.schedule || []);
      } catch (err) {
        console.error("Schedule load error:", err);
        setError(err instanceof Error ? err.message : "Error loading schedule");
      } finally {
        setLoading(false);
      }
    };

    fetchSchedule();
  }, [userId]);

  // Notify parent of schedule changes
  useEffect(() => {
    if (schedule.length > 0) {
      onScheduleChange?.(schedule);
    }
  }, [schedule, onScheduleChange]);

  const handleDayChange = (dayOfWeek: number, field: keyof ScheduleDay, value: any) => {
    setSchedule((prev) => {
      const updated = [...prev];
      const dayIndex = updated.findIndex((d) => d.dayOfWeek === dayOfWeek);
      if (dayIndex >= 0) {
        updated[dayIndex] = { ...updated[dayIndex], [field]: value };
      }
      return updated;
    });
    setError(null);
    setSuccess(false);
  };

  // Copy schedule from one day to another
  const handleCopySchedule = (fromDayOfWeek: number, toDayOfWeek: number) => {
    setSchedule((prev) => {
      const fromDay = prev.find((d) => d.dayOfWeek === fromDayOfWeek);
      const toDay = prev.find((d) => d.dayOfWeek === toDayOfWeek);

      if (!fromDay || !toDay) return prev;

      const updated = [...prev];
      const toIndex = updated.findIndex((d) => d.dayOfWeek === toDayOfWeek);

      if (toIndex >= 0) {
        updated[toIndex] = {
          dayOfWeek: toDayOfWeek,
          isWorking: fromDay.isWorking,
          startTime: fromDay.startTime,
          endTime: fromDay.endTime,
          breakStart: fromDay.breakStart,
          breakEnd: fromDay.breakEnd,
        };
      }

      return updated;
    });

    setCopyDialog({ isOpen: false, targetDay: null });
    setSuccess(false);
  };

  // Saving is now handled by parent component (TeamPanel)

  if (loading) return <div className={styles.loading}>Loading schedule...</div>;

  console.log("ScheduleTab render - schedule:", schedule);

  return (
    <div className={styles.scheduleTab}>
      <h3>Weekly Schedule</h3>
      <p style={{ fontSize: "12px", color: "#A1A1AA", margin: "0 0 16px 0" }}>
        Configure working hours and breaks. Changes will be saved when you click "Save Changes" at the bottom of this form.
      </p>

      {error && <div className={styles.errorBanner}>{error}</div>}
      {success && <div className={styles.successBanner}>✓ Schedule saved successfully</div>}

      <div className={styles.scheduleDays}>
        {schedule.length === 0 ? (
          <div className={styles.errorBanner}>No schedule data loaded</div>
        ) : (
          schedule.map((day) => (
          <div key={day.dayOfWeek} className={styles.daySection}>
            <div className={styles.dayHeader}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <label className={styles.dayToggle}>
                  <input
                    type="checkbox"
                    checked={day.isWorking}
                    onChange={(e) => handleDayChange(day.dayOfWeek, "isWorking", e.target.checked)}
                  />
                  <span>{DAYS[day.dayOfWeek]}</span>
                </label>
                {day.isWorking && (
                  <button
                    onClick={() => setCopyDialog({ isOpen: true, targetDay: day.dayOfWeek })}
                    style={{
                      fontSize: "12px",
                      padding: "4px 8px",
                      background: "#2563EB",
                      color: "#FAFAFA",
                      border: "none",
                      borderRadius: "4px",
                      cursor: "pointer",
                    }}
                  >
                    Copy From
                  </button>
                )}
              </div>
            </div>

            {day.isWorking && (
              <div className={styles.dayContent}>
                <div className={styles.timeGroup}>
                  <div className={styles.timeInput}>
                    <label>Start Time</label>
                    <input
                      type="time"
                      value={day.startTime || ""}
                      onChange={(e) => handleDayChange(day.dayOfWeek, "startTime", e.target.value)}
                      placeholder="HH:MM"
                    />
                  </div>
                  <div className={styles.timeInput}>
                    <label>End Time</label>
                    <input
                      type="time"
                      value={day.endTime || ""}
                      onChange={(e) => handleDayChange(day.dayOfWeek, "endTime", e.target.value)}
                      placeholder="HH:MM"
                    />
                  </div>
                </div>

                <div className={styles.breakGroup}>
                  <label>Break (Optional)</label>
                  <div className={styles.timeGroup}>
                    <div className={styles.timeInput}>
                      <label>Break Start</label>
                      <input
                        type="time"
                        value={day.breakStart || ""}
                        onChange={(e) => handleDayChange(day.dayOfWeek, "breakStart", e.target.value)}
                        placeholder="HH:MM"
                      />
                    </div>
                    <div className={styles.timeInput}>
                      <label>Break End</label>
                      <input
                        type="time"
                        value={day.breakEnd || ""}
                        onChange={(e) => handleDayChange(day.dayOfWeek, "breakEnd", e.target.value)}
                        placeholder="HH:MM"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
          ))
        )}
      </div>

      <p style={{ fontSize: "12px", color: "#71717A", marginTop: "16px", fontStyle: "italic" }}>
        Changes will be saved when you click the "Save Changes" button at the bottom of the form.
      </p>

      {/* Copy Dialog */}
      {copyDialog.isOpen && copyDialog.targetDay !== null && (
        <div style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000,
        }}>
          <div style={{
            background: "#27272A",
            borderRadius: "8px",
            padding: "24px",
            maxWidth: "400px",
            width: "90%",
            border: "1px solid #3F3F46",
          }}>
            <h3 style={{ margin: "0 0 16px 0", color: "#E5E7EB", fontSize: "18px" }}>
              Copy from which day?
            </h3>
            <p style={{ margin: "0 0 16px 0", color: "#A1A1AA", fontSize: "13px" }}>
              Select a day to copy the schedule to {DAYS[copyDialog.targetDay]}:
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "20px" }}>
              {schedule
                .filter((d) => d.isWorking && d.dayOfWeek !== copyDialog.targetDay)
                .map((day) => (
                  <button
                    key={day.dayOfWeek}
                    onClick={() => handleCopySchedule(day.dayOfWeek, copyDialog.targetDay!)}
                    style={{
                      padding: "10px 12px",
                      background: "#3F3F46",
                      color: "#E5E7EB",
                      border: "1px solid #52525B",
                      borderRadius: "4px",
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: "13px",
                      transition: "background-color 0.2s",
                    }}
                    onMouseEnter={(e) => {
                      (e.target as HTMLButtonElement).style.background = "#52525B";
                    }}
                    onMouseLeave={(e) => {
                      (e.target as HTMLButtonElement).style.background = "#3F3F46";
                    }}
                  >
                    {DAYS[day.dayOfWeek]} ({day.startTime} - {day.endTime})
                  </button>
                ))}
            </div>
            <button
              onClick={() => setCopyDialog({ isOpen: false, targetDay: null })}
              style={{
                width: "100%",
                padding: "10px 12px",
                background: "#52525B",
                color: "#E5E7EB",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "13px",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
