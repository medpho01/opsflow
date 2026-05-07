"use client";

import { useState } from "react";

interface SLATimeline {
  label: string;
  time: string;
  relativeTime: string;
}

interface SLAContext {
  createdAt: string;
  slaMinutes: number;
  minutesRemaining: number;
  breachedAt: string | null;
  breachedSince: number | null;
  timeline: {
    created: SLATimeline;
    deadline: SLATimeline;
    breached?: SLATimeline;
  };
}

interface SLADisplayProps {
  slaContext: SLAContext | undefined;
  slaStatus: "safe" | "warning" | "critical" | "breached" | undefined;
  mode?: "compact" | "expanded";
}

export default function SLADisplay({
  slaContext,
  slaStatus = "safe",
  mode = "compact",
}: SLADisplayProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  if (!slaContext) {
    return <span className="text-zinc-500">—</span>;
  }

  const getSLAColor = (): string => {
    switch (slaStatus) {
      case "safe":
        return "text-green-400";
      case "warning":
        return "text-yellow-400";
      case "critical":
        return "text-orange-400";
      case "breached":
        return "text-red-400";
      default:
        return "text-zinc-400";
    }
  };

  const getBGColor = (): string => {
    switch (slaStatus) {
      case "safe":
        return "bg-green-500/10 hover:bg-green-500/15 border-green-500/20";
      case "warning":
        return "bg-yellow-500/10 hover:bg-yellow-500/15 border-yellow-500/20";
      case "critical":
        return "bg-orange-500/10 hover:bg-orange-500/15 border-orange-500/20";
      case "breached":
        return "bg-red-500/10 hover:bg-red-500/15 border-red-500/20";
      default:
        return "bg-zinc-900 hover:bg-zinc-800 border-zinc-700";
    }
  };

  const compactDisplay = () => {
    if (slaContext.breachedAt && slaContext.breachedSince !== null) {
      return (
        <span className={getSLAColor()}>
          {slaContext.breachedSince > 0
            ? `Breached ${slaContext.breachedSince}m ago`
            : "Breached"}
        </span>
      );
    }

    if (slaContext.minutesRemaining < 0) {
      return <span className={getSLAColor()}>Overdue</span>;
    }

    const mins = Math.round(slaContext.minutesRemaining);
    if (mins < 60) {
      return <span className={getSLAColor()}>{mins}m remaining</span>;
    }

    const hours = Math.round(mins / 60);
    if (hours < 24) {
      return <span className={getSLAColor()}>{hours}h remaining</span>;
    }

    const days = Math.round(hours / 24);
    return <span className={getSLAColor()}>{days}d remaining</span>;
  };

  const expandedDisplay = () => {
    return (
      <div className="space-y-3">
        {/* Timeline visualization */}
        <div className="space-y-2">
          <div className="text-xs font-semibold text-zinc-400 uppercase">SLA Timeline</div>

          {/* Timeline line */}
          <div className="relative pl-6">
            {/* Vertical line */}
            <div className="absolute left-2 top-0 bottom-0 w-0.5 bg-zinc-700" />

            {/* Created point */}
            <div className="flex items-start gap-2 mb-3">
              <div className={`w-5 h-5 rounded-full border-2 border-blue-500 bg-blue-500/20 flex-shrink-0 mt-0.5`} />
              <div className="min-w-0">
                <div className="text-xs font-medium text-zinc-300">
                  {slaContext.timeline.created.label}
                </div>
                <div className="text-xs text-zinc-500">{slaContext.timeline.created.time}</div>
                <div className="text-xs text-zinc-600">{slaContext.timeline.created.relativeTime}</div>
              </div>
            </div>

            {/* Deadline point */}
            <div className="flex items-start gap-2 mb-3">
              <div
                className={`w-5 h-5 rounded-full border-2 flex-shrink-0 mt-0.5 ${
                  slaStatus === "safe"
                    ? "border-green-500 bg-green-500/20"
                    : slaStatus === "warning"
                      ? "border-yellow-500 bg-yellow-500/20"
                      : slaStatus === "critical"
                        ? "border-orange-500 bg-orange-500/20"
                        : "border-red-500 bg-red-500/20"
                }`}
              />
              <div className="min-w-0">
                <div className="text-xs font-medium text-zinc-300">
                  {slaContext.timeline.deadline.label}
                </div>
                <div className="text-xs text-zinc-500">{slaContext.timeline.deadline.time}</div>
                <div className="text-xs text-zinc-600">{slaContext.timeline.deadline.relativeTime}</div>
              </div>
            </div>

            {/* Breach point (if applicable) */}
            {slaContext.timeline.breached && (
              <div className="flex items-start gap-2">
                <div className={`w-5 h-5 rounded-full border-2 border-red-500 bg-red-500/20 flex-shrink-0 mt-0.5`} />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-red-400">
                    {slaContext.timeline.breached.label}
                  </div>
                  <div className="text-xs text-zinc-500">{slaContext.timeline.breached.time}</div>
                  <div className="text-xs text-zinc-600">{slaContext.timeline.breached.relativeTime}</div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* SLA Details */}
        <div className="space-y-2 text-xs">
          <div className="flex justify-between text-zinc-400">
            <span>SLA Window:</span>
            <span className="text-zinc-300 font-medium">{slaContext.slaMinutes} minutes</span>
          </div>

          <div className="flex justify-between text-zinc-400">
            <span>Status:</span>
            <span className={`font-medium ${getSLAColor()}`}>
              {slaStatus?.toUpperCase() ?? "UNKNOWN"}
            </span>
          </div>

          {slaContext.minutesRemaining >= 0 ? (
            <div className="flex justify-between text-zinc-400">
              <span>Time Remaining:</span>
              <span className={`font-medium ${getSLAColor()}`}>
                {Math.round(slaContext.minutesRemaining)} minutes
              </span>
            </div>
          ) : (
            <div className="flex justify-between text-zinc-400">
              <span>Overdue By:</span>
              <span className="font-medium text-red-400">
                {Math.round(Math.abs(slaContext.minutesRemaining))} minutes
              </span>
            </div>
          )}

          {slaContext.breachedSince !== null && (
            <div className="flex justify-between text-zinc-400">
              <span>Breached For:</span>
              <span className="font-medium text-red-400">
                {slaContext.breachedSince} minutes
              </span>
            </div>
          )}
        </div>
      </div>
    );
  };

  if (mode === "expanded") {
    return (
      <div className="bg-zinc-900/50 rounded-lg border border-zinc-800 p-3">
        {expandedDisplay()}
      </div>
    );
  }

  // Compact mode with hover tooltip
  return (
    <div className="relative inline-block">
      <button
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className={`px-2.5 py-1 rounded border transition-colors cursor-help ${getBGColor()}`}
      >
        {compactDisplay()}
      </button>

      {/* Hover tooltip */}
      {showTooltip && (
        <div className="absolute bottom-full left-0 mb-2 z-50 bg-zinc-800 border border-zinc-700 rounded-lg shadow-lg p-3 w-64">
          {expandedDisplay()}
        </div>
      )}
    </div>
  );
}
