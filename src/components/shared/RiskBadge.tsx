/**
 * Pickup-delay risk band badge.
 *
 * Presentation only. The band is computed by the domain layer
 * (src/lib/priority/riskScorer.ts) and frozen onto the stored snapshot at
 * write time — this component never derives a band from a score.
 *
 * Mirrors the markup and palette of PriorityBadge/StatusBadge so shadow rows
 * read as part of the same system.
 */
interface RiskBadgeProps {
  band: string;
  score?: number;
  size?: "sm" | "md";
}

const config: Record<string, { label: string; cls: string }> = {
  LOW: { label: "Low", cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
  MEDIUM: { label: "Medium", cls: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" },
  HIGH: { label: "High", cls: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  CRITICAL: { label: "Critical", cls: "bg-red-500/15 text-red-400 border-red-500/30" },
};

export default function RiskBadge({ band, score, size = "sm" }: RiskBadgeProps) {
  const c = config[band] ?? config.LOW;
  const sz = size === "sm" ? "text-[10px] px-1.5 py-0.5" : "text-xs px-2 py-0.5";
  return (
    <span className={`inline-flex items-center gap-1 rounded border font-medium ${c.cls} ${sz}`}>
      {c.label}
      {score !== undefined && <span className="opacity-70 tabular-nums">{score}</span>}
    </span>
  );
}
