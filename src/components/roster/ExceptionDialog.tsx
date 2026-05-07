"use client";

import React, { useState } from "react";
import styles from "./roster.module.css";

interface RosterMember {
  userId: number;
  name: string;
  scheduled: {
    isWorking: boolean;
    startTime?: string;
    endTime?: string;
  };
}

interface ExceptionDialogProps {
  member: RosterMember;
  date: string;
  action: "leave" | "sick" | "off";
  onClose: () => void;
  onSaved: () => void;
}

const ACTION_LABELS: Record<string, string> = {
  leave: "Leave",
  sick: "Sick",
  off: "Off",
};

const ACTION_STATUSES: Record<string, string> = {
  leave: "ON_LEAVE",
  sick: "SICK",
  off: "OFF",
};

export default function ExceptionDialog({ member, date, action, onClose, onSaved }: ExceptionDialogProps) {
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/roster/exception", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: member.userId,
          date,
          status: ACTION_STATUSES[action],
          note: note || null,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create exception");
      }

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error creating exception");
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    onClose();
  };

  return (
    <div className={styles.dialogOverlay} onClick={handleCancel}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.dialogHeader}>
          <h2>Mark as {ACTION_LABELS[action]}</h2>
          <button className={styles.closeBtn} onClick={handleCancel}>
            ✕
          </button>
        </div>

        <div className={styles.dialogContent}>
          <div className={styles.memberDetails}>
            <p className={styles.label}>Member: {member.name}</p>
            <p className={styles.label}>Date: {date}</p>
            {member.scheduled.isWorking && member.scheduled.startTime && member.scheduled.endTime && (
              <p className={styles.label}>
                Scheduled: {member.scheduled.startTime} - {member.scheduled.endTime}
              </p>
            )}
          </div>

          {error && <div className={styles.errorBanner}>{error}</div>}

          <div className={styles.formGroup}>
            <label htmlFor="note">Add note (optional):</label>
            <textarea
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g., Annual leave, Doctor's appointment, etc."
              rows={3}
              className={styles.textarea}
            />
          </div>
        </div>

        <div className={styles.dialogActions}>
          <button className={styles.cancelBtn} onClick={handleCancel} disabled={loading}>
            Cancel
          </button>
          <button
            className={styles.submitBtn}
            onClick={handleSubmit}
            disabled={loading}
            style={{ backgroundColor: action === "leave" ? "#FF9800" : action === "sick" ? "#F44336" : "#9E9E9E" }}
          >
            {loading ? "Saving..." : `Mark as ${ACTION_LABELS[action]}`}
          </button>
        </div>
      </div>
    </div>
  );
}
