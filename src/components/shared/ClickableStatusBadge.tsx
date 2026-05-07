"use client";

import { useState } from "react";
import StatusBadge from "./StatusBadge";

interface ClickableStatusBadgeProps {
  status: string;
  onStatusChange: (newStatus: string) => Promise<void>;
  disabled?: boolean;
}

const STATUS_TRANSITIONS: Record<string, string[]> = {
  CREATED: ["ASSIGNED", "IN_PROGRESS"],
  ASSIGNED: ["IN_PROGRESS", "BLOCKED"],
  IN_PROGRESS: ["COMPLETED", "BLOCKED"],
  BLOCKED: ["IN_PROGRESS", "COMPLETED"],
  BREACHED: ["IN_PROGRESS", "COMPLETED", "BLOCKED"],
  COMPLETED: [],
  CANCELLED: [],
};

export default function ClickableStatusBadge({
  status,
  onStatusChange,
  disabled,
}: ClickableStatusBadgeProps) {
  const [open, setOpen] = useState(false);
  const [updating, setUpdating] = useState(false);

  const nextStatuses = STATUS_TRANSITIONS[status] || [];
  const isTerminal = !nextStatuses || nextStatuses.length === 0;

  const handleStatusClick = async (newStatus: string) => {
    setUpdating(true);
    try {
      await onStatusChange(newStatus);
      setOpen(false);
    } finally {
      setUpdating(false);
    }
  };

  if (isTerminal || disabled) {
    return <StatusBadge status={status} />;
  }

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen(!open)}
        className="hover:opacity-80 transition-opacity"
        title="Click to change status"
        disabled={updating}
      >
        <StatusBadge status={status} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-20 bg-zinc-800 border border-zinc-700 rounded-lg shadow-lg py-1 min-w-max">
          {nextStatuses.map((nextStatus) => (
            <button
              key={nextStatus}
              onClick={() => handleStatusClick(nextStatus)}
              disabled={updating}
              className="w-full text-left px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-700 transition-colors disabled:opacity-50"
            >
              {updating ? "..." : nextStatus}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
