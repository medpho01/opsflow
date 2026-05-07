"use client";

import { useEffect, useState } from "react";

interface SlaCountdownProps {
  deadline: string; // ISO string
  compact?: boolean;
  completedAt?: string; // ISO string - if provided, SLA is frozen at completion time
}

export default function SlaCountdown({ deadline, compact = false, completedAt }: SlaCountdownProps) {
  const [msLeft, setMsLeft] = useState(() => {
    const deadlineTime = new Date(deadline).getTime();
    const referenceTime = completedAt ? new Date(completedAt).getTime() : Date.now();
    return deadlineTime - referenceTime;
  });

  useEffect(() => {
    // If task is completed, don't update - freeze at completion time
    if (completedAt) {
      const deadlineTime = new Date(deadline).getTime();
      const completionTime = new Date(completedAt).getTime();
      setMsLeft(deadlineTime - completionTime);
      return;
    }

    const tick = () => setMsLeft(new Date(deadline).getTime() - Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline, completedAt]);

  const isBreached = msLeft <= 0;
  const isWarning = msLeft > 0 && msLeft <= 10 * 60_000;

  const absMs = Math.abs(msLeft);
  const h = Math.floor(absMs / 3_600_000);
  const m = Math.floor((absMs % 3_600_000) / 60_000);
  const s = Math.floor((absMs % 60_000) / 1_000);

  const fmt = compact
    ? h > 0
      ? `${h}h ${m}m`
      : `${m}m ${s}s`
    : h > 0
    ? `${h}h ${m}m ${s}s`
    : `${m}m ${s}s`;

  const label = isBreached ? `+${fmt} overdue` : fmt;

  const cls = isBreached
    ? "text-red-400 font-semibold"
    : isWarning
    ? "text-amber-400 font-semibold"
    : "text-zinc-300";

  return <span className={cls}>{label}</span>;
}
