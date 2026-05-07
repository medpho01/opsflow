interface PriorityBadgeProps {
  priority: string;
  size?: "sm" | "md";
}

const config: Record<string, { label: string; cls: string }> = {
  URGENT: { label: "Urgent", cls: "bg-red-500/15 text-red-400 border-red-500/30" },
  HIGH: { label: "High", cls: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  MEDIUM: { label: "Medium", cls: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" },
  LOW: { label: "Low", cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
};

export default function PriorityBadge({ priority, size = "sm" }: PriorityBadgeProps) {
  const c = config[priority] ?? config.LOW;
  const sz = size === "sm" ? "text-[10px] px-1.5 py-0.5" : "text-xs px-2 py-0.5";
  return (
    <span className={`inline-flex items-center rounded border font-medium ${c.cls} ${sz}`}>
      {c.label}
    </span>
  );
}
