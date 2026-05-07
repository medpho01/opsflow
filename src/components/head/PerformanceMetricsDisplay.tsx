"use client";

import { useState, useEffect } from "react";
import { MemberPerformanceStats } from "@/types";

interface PerformanceMetricsDisplayProps {
  memberId: number;
  period?: "week" | "month";
}

export function PerformanceMetricsDisplay({
  memberId,
  period = "month",
}: PerformanceMetricsDisplayProps) {
  const [stats, setStats] = useState<MemberPerformanceStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<"week" | "month">(period);

  useEffect(() => {
    async function loadStats() {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch(
          `/api/team/${memberId}/performance?period=${selectedPeriod}`
        );
        if (!res.ok) {
          throw new Error("Failed to load performance stats");
        }
        const data = await res.json();
        setStats(data.stats ? { ...data.stats, teamMemberId: data.teamMemberId, memberName: data.memberName, period: data.period } : null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    }

    loadStats();
  }, [memberId, selectedPeriod]);

  if (loading) {
    return (
      <div className="p-3 bg-gray-50 rounded text-center text-sm text-gray-500">
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
        {error}
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="p-3 text-gray-500 text-sm">No data available</div>
    );
  }

  const getComplianceColor = (compliance: number): string => {
    if (compliance >= 95) return "text-green-600";
    if (compliance >= 80) return "text-amber-600";
    return "text-red-600";
  };

  return (
    <div className="space-y-3">
      {/* Period selector */}
      <div className="flex gap-2">
        <button
          onClick={() => setSelectedPeriod("week")}
          className={`px-3 py-1 text-sm rounded ${
            selectedPeriod === "week"
              ? "bg-blue-100 text-blue-700"
              : "bg-gray-100 text-gray-700 hover:bg-gray-200"
          }`}
        >
          Week
        </button>
        <button
          onClick={() => setSelectedPeriod("month")}
          className={`px-3 py-1 text-sm rounded ${
            selectedPeriod === "month"
              ? "bg-blue-100 text-blue-700"
              : "bg-gray-100 text-gray-700 hover:bg-gray-200"
          }`}
        >
          Month
        </button>
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-2">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-xs text-gray-600">Assigned</div>
          <div className="text-lg font-semibold">{stats.tasksAssigned}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-xs text-gray-600">Completed</div>
          <div className="text-lg font-semibold">{stats.tasksCompleted}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-xs text-gray-600">SLA Compliance</div>
          <div className={`text-lg font-semibold ${getComplianceColor(stats.slaCompliancePercent)}`}>
            {stats.slaCompliancePercent}%
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-xs text-gray-600">Avg Time</div>
          <div className="text-lg font-semibold">{stats.avgCompletionTimeHours || "—"}</div>
        </div>
      </div>

      {/* Breakdown */}
      <div className="text-xs text-gray-500 space-y-1">
        <div>Cancelled: {stats.tasksCancelled}</div>
        <div>SLA Breaches: {stats.slaBreaches}</div>
        <div>Completion Rate: {stats.completionRate}%</div>
      </div>
    </div>
  );
}
