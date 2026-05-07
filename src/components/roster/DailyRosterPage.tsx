"use client";

import React, { useState, useEffect } from "react";
import { formatTimeRange, formatBreakTime, formatDate } from "@/lib/roster/utils";
import ExceptionDialog from "./ExceptionDialog";
import styles from "./roster.module.css";

interface ScheduledTime {
  isWorking: boolean;
  startTime?: string;
  endTime?: string;
  breakStart?: string;
  breakEnd?: string;
}

interface RosterMember {
  userId: number;
  teamMemberId: number;
  name: string;
  email: string;
  role: string;
  scheduled: ScheduledTime;
  exception: {
    status: string;
    note?: string;
    createdBy?: number;
    createdAt: string;
  } | null;
  status: string;
}

interface DailyRosterPageProps {
  initialDate?: string;
}

export default function DailyRosterPage({ initialDate }: DailyRosterPageProps) {
  const [date, setDate] = useState<string>(initialDate || formatDate(new Date()));
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedMember, setSelectedMember] = useState<RosterMember | null>(null);
  const [showExceptionDialog, setShowExceptionDialog] = useState(false);
  const [exceptionAction, setExceptionAction] = useState<"leave" | "sick" | "off" | null>(null);

  // Load roster when date changes
  useEffect(() => {
    const fetchRoster = async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/roster/daily/${date}`);
        if (!res.ok) throw new Error("Failed to load roster");
        const data = await res.json();
        setRoster(data.roster || []);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error loading roster");
        setRoster([]);
      } finally {
        setLoading(false);
      }
    };

    fetchRoster();
  }, [date]);

  const handlePreviousDay = () => {
    const d = new Date(date);
    d.setDate(d.getDate() - 1);
    setDate(formatDate(d));
  };

  const handleNextDay = () => {
    const d = new Date(date);
    d.setDate(d.getDate() + 1);
    setDate(formatDate(d));
  };

  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDate(e.target.value);
  };

  const handleOpenException = (member: RosterMember, action: "leave" | "sick" | "off") => {
    setSelectedMember(member);
    setExceptionAction(action);
    setShowExceptionDialog(true);
  };

  const handleRemoveException = async (member: RosterMember) => {
    if (!confirm(`Remove exception for ${member.name}?`)) return;

    try {
      const res = await fetch(`/api/roster/exception/${member.userId}/${date}`, {
        method: "DELETE",
      });

      if (!res.ok) throw new Error("Failed to remove exception");

      // Refresh roster
      const rosterRes = await fetch(`/api/roster/daily/${date}`);
      const data = await rosterRes.json();
      setRoster(data.roster || []);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error removing exception");
    }
  };

  const getStatusColor = (status: string): string => {
    switch (status) {
      case "ACTIVE":
        return "#4CAF50";
      case "ON_LEAVE":
        return "#FF9800";
      case "SICK":
        return "#F44336";
      case "OFF":
        return "#9E9E9E";
      default:
        return "#2196F3";
    }
  };

  const getDayName = (dateStr: string): string => {
    const d = new Date(dateStr + "T00:00:00Z");
    return d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  };

  return (
    <div className={styles.dailyRosterPage}>
      <div className={styles.header}>
        <h1>Daily Roster</h1>
        <p>Set who's available for task assignment each day.</p>
      </div>

      {error && <div className={styles.errorBanner}>{error}</div>}

      <div className={styles.dateSelector}>
        <button onClick={handlePreviousDay}>←</button>
        <div className={styles.dateDisplay}>
          <input type="date" value={date} onChange={handleDateChange} className={styles.dateInput} />
          <span className={styles.dateName}>{getDayName(date)}</span>
        </div>
        <button onClick={handleNextDay}>→</button>
      </div>

      {loading ? (
        <div className={styles.loading}>Loading roster...</div>
      ) : (
        <div className={styles.rosterList}>
          {roster.length === 0 ? (
            <div className={styles.emptyState}>No team members found</div>
          ) : (
            roster.map((member) => (
              <div key={member.userId} className={styles.rosterCard}>
                <div className={styles.cardHeader}>
                  <div className={styles.memberInfo}>
                    <h3>{member.name}</h3>
                    <span className={styles.role}>{member.role}</span>
                    <span className={styles.email}>{member.email}</span>
                  </div>
                  <div
                    className={styles.statusBadge}
                    style={{ backgroundColor: getStatusColor(member.status) }}
                  >
                    {member.status}
                  </div>
                </div>

                <div className={styles.cardContent}>
                  {member.exception ? (
                    <div className={styles.exceptionInfo}>
                      <p className={styles.label}>Current Status: {member.exception.status}</p>
                      {member.exception.note && <p className={styles.note}>Note: {member.exception.note}</p>}
                    </div>
                  ) : (
                    <div className={styles.scheduleInfo}>
                      {member.scheduled.isWorking ? (
                        <>
                          <p className={styles.label}>
                            Scheduled: {formatTimeRange(member.scheduled.startTime!, member.scheduled.endTime!)}
                          </p>
                          {member.scheduled.breakStart && (
                            <p className={styles.label}>
                              Break: {formatBreakTime(member.scheduled.breakStart, member.scheduled.breakEnd)}
                            </p>
                          )}
                        </>
                      ) : (
                        <p className={styles.label}>Scheduled: OFF</p>
                      )}
                    </div>
                  )}
                </div>

                <div className={styles.cardActions}>
                  {member.exception ? (
                    <>
                      <button
                        className={styles.actionBtn}
                        onClick={() => handleRemoveException(member)}
                        style={{ backgroundColor: "#FF6B6B" }}
                      >
                        Remove {member.exception.status}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className={styles.actionBtn}
                        onClick={() => handleOpenException(member, "leave")}
                        style={{ backgroundColor: "#FF9800" }}
                      >
                        Mark as Leave
                      </button>
                      <button
                        className={styles.actionBtn}
                        onClick={() => handleOpenException(member, "sick")}
                        style={{ backgroundColor: "#F44336" }}
                      >
                        Mark as Sick
                      </button>
                      <button
                        className={styles.actionBtn}
                        onClick={() => handleOpenException(member, "off")}
                        style={{ backgroundColor: "#9E9E9E" }}
                      >
                        Mark as Off
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {showExceptionDialog && selectedMember && exceptionAction && (
        <ExceptionDialog
          member={selectedMember}
          date={date}
          action={exceptionAction}
          onClose={() => {
            setShowExceptionDialog(false);
            setSelectedMember(null);
            setExceptionAction(null);
          }}
          onSaved={() => {
            // Refresh roster
            fetch(`/api/roster/daily/${date}`)
              .then((r) => r.json())
              .then((d) => setRoster(d.roster || []))
              .catch(console.error);
            setShowExceptionDialog(false);
            setSelectedMember(null);
            setExceptionAction(null);
          }}
        />
      )}
    </div>
  );
}
