"use client";

import { useState } from "react";
import PriorityBadge from "@/components/shared/PriorityBadge";
import TaskAgingIndicator from "@/components/shared/TaskAgingIndicator";

interface Task {
  id: number;
  title: string;
  status: string;
  priority: string;
  slaStatus?: string;
  aging?: {
    minutesInStatus: number;
    ageColor: string;
  };
}

interface KanbanBoardProps {
  tasks: Task[];
  onStatusChange: (taskId: number, newStatus: string) => Promise<void>;
  onTaskClick?: (taskId: number) => void;
}

const STATUS_COLUMNS = ["CREATED", "ASSIGNED", "IN_PROGRESS", "BLOCKED", "COMPLETED", "CANCELLED"];

const getStatusColor = (status: string): string => {
  switch (status) {
    case "CREATED":
      return "bg-gray-500/10";
    case "ASSIGNED":
      return "bg-blue-500/10";
    case "IN_PROGRESS":
      return "bg-purple-500/10";
    case "BLOCKED":
      return "bg-orange-500/10";
    case "COMPLETED":
      return "bg-green-500/10";
    case "CANCELLED":
      return "bg-red-500/10";
    default:
      return "bg-zinc-500/10";
  }
};

const getCardBGColor = (slaStatus?: string): string => {
  switch (slaStatus) {
    case "safe":
      return "border-l-4 border-l-green-500 hover:bg-green-500/5";
    case "warning":
      return "border-l-4 border-l-yellow-500 hover:bg-yellow-500/5";
    case "critical":
      return "border-l-4 border-l-orange-500 hover:bg-orange-500/5";
    case "breached":
      return "border-l-4 border-l-red-500 hover:bg-red-500/5";
    default:
      return "hover:bg-zinc-800/50";
  }
};

export default function KanbanBoard({
  tasks,
  onStatusChange,
  onTaskClick,
}: KanbanBoardProps) {
  const [draggedTask, setDraggedTask] = useState<number | null>(null);
  const [isUpdating, setIsUpdating] = useState<number | null>(null);

  const tasksByStatus = STATUS_COLUMNS.reduce(
    (acc, status) => {
      acc[status] = tasks.filter((task) => task.status === status);
      return acc;
    },
    {} as Record<string, Task[]>
  );

  const handleDragStart = (taskId: number) => {
    setDraggedTask(taskId);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDrop = async (e: React.DragEvent, targetStatus: string) => {
    e.preventDefault();
    if (!draggedTask) return;

    const task = tasks.find((t) => t.id === draggedTask);
    if (!task || task.status === targetStatus) {
      setDraggedTask(null);
      return;
    }

    setIsUpdating(draggedTask);
    try {
      await onStatusChange(draggedTask, targetStatus);
    } finally {
      setIsUpdating(null);
      setDraggedTask(null);
    }
  };

  return (
    <div className="flex gap-4 h-full overflow-x-auto bg-zinc-950 p-4">
      {STATUS_COLUMNS.map((status) => {
        const columnTasks = tasksByStatus[status] || [];
        return (
          <div
            key={status}
            className="flex flex-col w-80 bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden flex-shrink-0"
          >
            {/* Column Header */}
            <div className={`px-4 py-3 border-b border-zinc-800 ${getStatusColor(status)}`}>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-sm text-zinc-200">{status}</h3>
                <span className="px-2 py-1 bg-zinc-800 rounded text-xs text-zinc-400">
                  {columnTasks.length}
                </span>
              </div>
            </div>

            {/* Tasks Container */}
            <div
              className="flex-1 overflow-y-auto p-3 space-y-2"
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, status)}
            >
              {columnTasks.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-zinc-600 text-xs">
                  Drop tasks here
                </div>
              ) : (
                columnTasks.map((task) => (
                  <div
                    key={task.id}
                    draggable
                    onDragStart={() => handleDragStart(task.id)}
                    onClick={() => onTaskClick?.(task.id)}
                    className={`p-3 bg-zinc-800 rounded border border-zinc-700 cursor-move transition-all ${getCardBGColor(task.slaStatus)} ${
                      isUpdating === task.id ? "opacity-50" : ""
                    }`}
                  >
                    {/* Task Title */}
                    <h4 className="text-sm font-medium text-zinc-100 mb-2 line-clamp-2">
                      {task.title}
                    </h4>

                    {/* Task Metadata */}
                    <div className="space-y-2 text-xs">
                      {/* Priority Badge */}
                      <div>
                        <PriorityBadge priority={task.priority} size="sm" />
                      </div>

                      {/* Aging Indicator */}
                      {task.aging && (
                        <TaskAgingIndicator aging={task.aging as any} compact={true} />
                      )}

                      {/* Task ID */}
                      <div className="text-zinc-500">#{task.id}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
