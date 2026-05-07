interface StatusBadgeProps {
  status: string;
}

const config: Record<string, { label: string; cls: string }> = {
  CREATED: { label: "Unassigned", cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
  ASSIGNED: { label: "Assigned", cls: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  IN_PROGRESS: { label: "In Progress", cls: "bg-indigo-500/15 text-indigo-400 border-indigo-500/30" },
  COMPLETED: { label: "Completed", cls: "bg-green-500/15 text-green-400 border-green-500/30" },
  BLOCKED: { label: "Blocked", cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  BREACHED: { label: "Breached", cls: "bg-red-500/15 text-red-400 border-red-500/30" },
  CANCELLED: { label: "Cancelled", cls: "bg-zinc-600/15 text-zinc-500 border-zinc-600/30" },
};

export default function StatusBadge({ status }: StatusBadgeProps) {
  const c = config[status] ?? { label: status, cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" };
  return (
    <span className={`inline-flex items-center rounded border text-[10px] px-1.5 py-0.5 font-medium ${c.cls}`}>
      {c.label}
    </span>
  );
}
