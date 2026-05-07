"use client";

interface AgingInfo {
  minutesInStatus: number;
  isStuck: boolean;
  stuckThreshold: number;
  ageColor: string;
  displayText: string;
}

interface TaskAgingIndicatorProps {
  aging: AgingInfo | undefined;
  compact?: boolean;
}

export default function TaskAgingIndicator({
  aging,
  compact = false,
}: TaskAgingIndicatorProps) {
  if (!aging) {
    return <span className="text-zinc-500">—</span>;
  }

  const getBGColor = () => {
    switch (aging.ageColor) {
      case "red":
        return "bg-red-500/10 border border-red-500/20 text-red-400";
      case "yellow":
        return "bg-yellow-500/10 border border-yellow-500/20 text-yellow-400";
      case "green":
      default:
        return "bg-green-500/10 border border-green-500/20 text-green-400";
    }
  };

  const getIcon = () => {
    switch (aging.ageColor) {
      case "red":
        return "🔴";
      case "yellow":
        return "🟡";
      case "green":
      default:
        return "🟢";
    }
  };

  if (compact) {
    return (
      <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium ${getBGColor()}`}>
        <span>{getIcon()}</span>
        <span>{aging.minutesInStatus}m</span>
      </span>
    );
  }

  return (
    <div className={`px-3 py-2 rounded ${getBGColor()}`}>
      <div className="text-xs font-medium">{aging.displayText}</div>
      <div className="text-xs opacity-75 mt-1">
        {aging.isStuck && "⚠️ Task stuck in current status"}
        {!aging.isStuck && aging.ageColor === "yellow" && "⚡ Task approaching aging threshold"}
        {!aging.isStuck && aging.ageColor === "green" && "✓ Normal duration in current status"}
      </div>
    </div>
  );
}
