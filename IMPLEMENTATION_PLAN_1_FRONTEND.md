# OpsFlow "All Tasks" Feature — FRONTEND IMPLEMENTATION PLAN

**Date:** May 1, 2026  
**Target Release:** 7-9 weeks (3 phases)  
**Team:** 1-2 Frontend Engineers + 1 Product Manager  
**Tech Stack:** React, TypeScript, Next.js, TailwindCSS

---

## EXECUTIVE SUMMARY

This frontend implementation plan covers building a world-class task management interface across three phases:
- **Phase 1 (Foundation):** Quick-win features establishing real-time data freshness and visual urgency signals (2 weeks, 5 features)
- **Phase 2 (Usability):** Core improvements enabling deep inspection and powerful filtering (3 weeks, 5 features)
- **Phase 3 (Intelligence):** Advanced capabilities including Kanban view, real-time alerts, and task aging (4 weeks, 4 features)

The design prioritizes **speed** (ops managers making decisions in <10 seconds) and **context** (understanding why tasks exist and their urgency without jumping between screens).

**Estimated Effort:** 25-35 days of development  
**Dependencies:** Backend API changes and WebSocket support (see Backend Plan)  
**Success Criteria:** Ops can identify SLA-at-risk tasks in <3 seconds, verify auto-assignments in <5 minutes, manually reassign task in <30 seconds

---

# PHASE 1: FOUNDATION (Weeks 1-2)

## Overview
Five quick-win features establishing real-time data visibility, visual urgency cues, and status distribution at a glance. These are load-bearing features all subsequent work depends on.

---

## FEATURE F1.1: Manual Refresh Button + Last Updated Timestamp

### Problem Solved
Users don't know if data is stale (1 minute old or 30 minutes old?). Must manually refresh (F5) page to trust what they're seeing.

### Component Architecture

**File:** `/Users/maverick/Documents/TaskOs/src/components/head/AllTasksBoard.tsx` (new section in header)

**New Component: `<LastUpdatedWidget />`**
```typescript
interface LastUpdatedWidgetProps {
  lastUpdatedAt: Date | null;
  isLoading: boolean;
  onRefresh: () => void;
}

export const LastUpdatedWidget: React.FC<LastUpdatedWidgetProps> = ({
  lastUpdatedAt,
  isLoading,
  onRefresh,
}) => {
  const [now, setNow] = useState<Date>(new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const minutesAgo = lastUpdatedAt 
    ? Math.floor((now.getTime() - lastUpdatedAt.getTime()) / 60000)
    : null;

  const displayText = minutesAgo === null
    ? "Never"
    : minutesAgo === 0
    ? "Just now"
    : `${minutesAgo} min${minutesAgo > 1 ? "s" : ""} ago`;

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900 rounded border border-zinc-800">
      <button
        onClick={onRefresh}
        disabled={isLoading}
        className="flex items-center gap-1 px-2 py-1 hover:bg-zinc-800 rounded transition-colors disabled:opacity-50"
        title="Refresh task data"
      >
        <span className={isLoading ? "animate-spin" : ""}>🔄</span>
        <span className="text-xs text-zinc-300">Refresh</span>
      </button>
      <span className="text-xs text-zinc-500">Last updated: {displayText}</span>
    </div>
  );
};
```

**Integration in AllTasksBoard.tsx:**
```typescript
const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

const fetchTasks = useCallback(async () => {
  setLoading(true);
  try {
    const res = await fetch(`/api/tasks?${params}`);
    if (!res.ok) {
      setFetchError("Failed to load tasks. Please try again.");
      setTasks([]);
      setTotalPages(1);
      setTotal(0);
      return;
    }
    const data = await res.json();
    setTasks(data.tasks ?? []);
    setTotalPages(data.totalPages ?? 1);
    setTotal(data.total ?? 0);
    setLastUpdatedAt(new Date());  // ← NEW
    setFetchError(null);
  } catch (err) {
    setFetchError("Network error. Please try again.");
    setTasks([]);
    setTotalPages(1);
    setTotal(0);
  } finally {
    setLoading(false);
  }
}, [statusFilter, priorityFilter, sortBy, sortOrder, page]);

// In render header:
<LastUpdatedWidget
  lastUpdatedAt={lastUpdatedAt}
  isLoading={loading}
  onRefresh={() => fetchTasks()}
/>
```

### UI/UX Design
- **Position:** Header, right side, next to filters
- **Style:** Subtle gray badge with refresh icon (SVG or emoji 🔄)
- **Color Scheme:** 
  - Normal: `text-zinc-500` (gray)
  - Refreshing: `text-zinc-400` with spinner animation
  - Error: `text-red-500` if data is >5 minutes old
- **Behavior:** Click button → immediately calls fetchTasks() → updates timestamp

### State Changes
- **New State:** `lastUpdatedAt: Date | null` 
- **Update on:** Every successful `fetchTasks()` call
- **Display:** Auto-updates every 1 second via useEffect interval

### API Contract
- No API changes required
- Uses existing `/api/tasks` endpoint
- Add response header (optional): `X-Fetched-At: 2026-05-01T10:30:00Z` for server timestamp verification

### Estimated Effort: 3-4 hours
- Component creation: 1.5 hours
- Integration with AllTasksBoard: 1 hour
- Testing (manual + unit): 1-1.5 hours
- CSS refinement: 0.5 hours

### Testing Strategy
- **Unit Test:** LastUpdatedWidget renders correctly, timer updates every 1s, click refresh calls onRefresh
- **Integration Test:** Fetch tasks → lastUpdatedAt updates → timestamp displays correctly
- **E2E Test:** User opens app → sees "Just now" → waits 2 mins → sees "2 mins ago" → clicks refresh → sees "Just now" again

### Dependencies
- Completes standalone
- Unblocks F1.3 and F1.2 (both show real-time updates)

---

## FEATURE F1.2: Auto-Refresh on New Task Creation (WebSocket)

### Problem Solved
New tasks created in backend don't appear on user's screen until manual refresh (lag: 5-30+ minutes). Ops miss new work.

### Component Architecture

**New File:** `/Users/maverick/Documents/TaskOs/src/lib/websocket/taskEvents.ts`

```typescript
export enum TaskEventType {
  TASK_CREATED = "task_created",
  TASK_UPDATED = "task_updated",
  TASK_ARCHIVED = "task_archived",
}

export interface TaskEvent {
  type: TaskEventType;
  task: Task;
  timestamp: Date;
}

export class TaskEventEmitter {
  private ws: WebSocket | null = null;
  private listeners: Map<TaskEventType, ((event: TaskEvent) => void)[]> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);
        
        this.ws.onopen = () => {
          console.log("[TaskEvents] Connected");
          this.reconnectAttempts = 0;
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            this.emit(data.type, { ...data, timestamp: new Date() });
          } catch (e) {
            console.error("[TaskEvents] Parse error:", e);
          }
        };

        this.ws.onerror = () => {
          reject(new Error("WebSocket connection failed"));
        };

        this.ws.onclose = () => {
          console.log("[TaskEvents] Disconnected, attempting reconnect...");
          this.attemptReconnect(url);
        };
      } catch (e) {
        reject(e);
      }
    });
  }

  private attemptReconnect(url: string) {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
      setTimeout(() => {
        this.connect(url).catch(() => {
          console.error("[TaskEvents] Reconnect failed");
        });
      }, delay);
    }
  }

  on(type: TaskEventType, callback: (event: TaskEvent) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(callback);

    // Return unsubscribe function
    return () => {
      const callbacks = this.listeners.get(type);
      if (callbacks) {
        const index = callbacks.indexOf(callback);
        if (index > -1) callbacks.splice(index, 1);
      }
    };
  }

  private emit(type: TaskEventType, event: TaskEvent) {
    const callbacks = this.listeners.get(type);
    if (callbacks) {
      callbacks.forEach(cb => cb(event));
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export const taskEventEmitter = new TaskEventEmitter();
```

**Integration in AllTasksBoard.tsx:**

```typescript
useEffect(() => {
  // Initialize WebSocket connection
  const wsUrl = `${process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3000"}/api/tasks/events`;
  
  taskEventEmitter.connect(wsUrl)
    .then(() => console.log("[AllTasksBoard] WebSocket connected"))
    .catch(e => console.error("[AllTasksBoard] WebSocket failed:", e));

  // Listen for new tasks
  const unsubscribeCreated = taskEventEmitter.on(TaskEventType.TASK_CREATED, (event) => {
    // Only add if it matches current filters
    if (shouldIncludeTask(event.task, { statusFilter, priorityFilter })) {
      setTasks(prev => [event.task, ...prev]);
      setTotal(prev => prev + 1);
      showToast({
        type: "info",
        message: `New task created: ${event.task.title}`,
        duration: 5000,
      });
    }
  });

  const unsubscribeUpdated = taskEventEmitter.on(TaskEventType.TASK_UPDATED, (event) => {
    setTasks(prev =>
      prev.map(t => t.id === event.task.id ? event.task : t)
    );
  });

  return () => {
    unsubscribeCreated();
    unsubscribeUpdated();
    taskEventEmitter.disconnect();
  };
}, [statusFilter, priorityFilter]);
```

**Helper Function:**

```typescript
function shouldIncludeTask(task: Task, filters: { statusFilter: string; priorityFilter: string }): boolean {
  if (filters.statusFilter && task.status !== filters.statusFilter) return false;
  if (filters.priorityFilter && task.priority !== filters.priorityFilter) return false;
  if (task.isArchived) return false;
  return true;
}
```

**Toast Component:** (if not already existing)
```typescript
interface Toast {
  id: string;
  type: "info" | "success" | "error" | "warning";
  message: string;
  duration?: number;
}

const [toasts, setToasts] = useState<Toast[]>([]);

function showToast(options: Omit<Toast, "id">) {
  const id = Date.now().toString();
  setToasts(prev => [...prev, { ...options, id }]);
  
  if (options.duration) {
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, options.duration);
  }
}

// Render toasts in bottom-right corner
<div className="fixed bottom-4 right-4 space-y-2 z-50">
  {toasts.map(toast => (
    <div
      key={toast.id}
      className={`px-4 py-2 rounded shadow-lg text-white ${
        toast.type === "info" ? "bg-blue-600" : 
        toast.type === "success" ? "bg-green-600" :
        toast.type === "error" ? "bg-red-600" :
        "bg-yellow-600"
      }`}
    >
      {toast.message}
    </div>
  ))}
</div>
```

### UI/UX Design
- **Toast Position:** Bottom-right corner, above any other UI
- **Toast Style:** 
  - Blue badge: "New task created: T-5123"
  - Auto-dismiss after 5 seconds
  - User can click toast to jump to task (optional, future enhancement)
- **No Disruption:** Toast appears, doesn't block user's current scroll position or work
- **Animation:** Fade in/out (0.3s transitions)

### State Changes
- **On task created:** Add task to top of list if it matches current filters
- **On task updated:** Update existing task in list
- **Update total count:** Increment `total` when new task added

### API Contract
- **WebSocket Endpoint:** `/api/tasks/events` (new)
- **Message Format:**
```json
{
  "type": "task_created",
  "task": {
    "id": 1,
    "title": "...",
    "status": "CREATED",
    "priority": "URGENT",
    "slaDeadline": "2026-05-01T11:00:00Z",
    "assignedToId": null,
    "entityId": 12345,
    "createdAt": "2026-05-01T10:00:00Z",
    ...
  },
  "timestamp": "2026-05-01T10:00:05Z"
}
```

### Estimated Effort: 4-5 days
- WebSocket client implementation: 2 days
- Integration with AllTasksBoard: 1 day
- Toast notification component: 1 day
- Testing (unit, integration, E2E): 1-2 days

### Testing Strategy
- **Unit Test:** TaskEventEmitter connects, emits events, unsubscribes correctly
- **Integration Test:** WebSocket message → task added to list → toast shown
- **E2E Test:** Create task via backend → verify appears on frontend <5s → toast dismisses
- **Edge Cases:** Network disconnect → reconnect → catches up with events

### Dependencies
- **Depends on:** Backend WebSocket support (Backend Plan, F-B1.1)
- **Unblocks:** F1.3 (status distribution relies on real-time updates)

---

## FEATURE F1.3: Color-Coded Urgency Zones (Green/Yellow/Red)

### Problem Solved
Ops must read every SLA countdown to assess urgency. No visual urgency signal at a glance.

### Component Architecture

**File:** `src/components/head/AllTasksBoard.tsx` (task row styling)

**New Hook: `useSLAColor()`**

```typescript
type SLAColorZone = "green" | "yellow" | "red";

interface SLAStatus {
  zone: SLAColorZone;
  message: string;
  percentageRemaining: number;
}

function useSLAColor(task: Task): SLAStatus {
  const now = new Date();
  const deadline = new Date(task.slaDeadline);
  const created = new Date(task.createdAt);
  
  // Total SLA duration in milliseconds
  const totalSLAMs = deadline.getTime() - created.getTime();
  
  // Time remaining in milliseconds
  const remainingMs = deadline.getTime() - now.getTime();
  
  // If task is BREACHED
  if (task.status === "BREACHED" || remainingMs < 0) {
    const overdueMs = Math.abs(remainingMs);
    const overdueMins = Math.floor(overdueMs / 60000);
    return {
      zone: "red",
      message: `+${overdueMins}m overdue`,
      percentageRemaining: 0,
    };
  }
  
  const remainingMins = remainingMs / 60000;
  const percentageRemaining = (remainingMs / totalSLAMs) * 100;
  
  // Red: < 10 minutes remaining
  if (remainingMins < 10) {
    return {
      zone: "red",
      message: `${Math.ceil(remainingMins)}m remaining`,
      percentageRemaining,
    };
  }
  
  // Yellow: 10-30 minutes remaining
  if (remainingMins < 30) {
    return {
      zone: "yellow",
      message: `${Math.ceil(remainingMins)}m remaining`,
      percentageRemaining,
    };
  }
  
  // Green: > 30 minutes remaining
  return {
    zone: "green",
    message: `${Math.ceil(remainingMins)}m remaining`,
    percentageRemaining,
  };
}
```

**Updated Task Row Component:**

```typescript
interface TaskRowProps {
  task: Task;
  isSelected: boolean;
  onSelectChange: (selected: boolean) => void;
  onTaskClick: (task: Task) => void;
}

const TaskRow: React.FC<TaskRowProps> = ({ task, isSelected, onSelectChange, onTaskClick }) => {
  const slaStatus = useSLAColor(task);
  
  // Determine row background color based on SLA zone
  const rowColorClass = {
    green: "bg-green-950 hover:bg-green-900",
    yellow: "bg-yellow-950 hover:bg-yellow-900",
    red: "bg-red-950 hover:bg-red-900",
  }[slaStatus.zone];
  
  // Left border accent (thicker for urgency)
  const borderClass = {
    green: "border-l-4 border-l-green-600",
    yellow: "border-l-4 border-l-yellow-500",
    red: "border-l-4 border-l-red-600",
  }[slaStatus.zone];
  
  return (
    <tr
      className={`${rowColorClass} ${borderClass} transition-colors cursor-pointer`}
      onClick={() => onTaskClick(task)}
    >
      {/* Checkbox Column */}
      <td className="px-4 py-3 w-10">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(e) => onSelectChange(e.target.checked)}
          onClick={(e) => e.stopPropagation()}
          className="rounded"
        />
      </td>
      
      {/* Status Column */}
      <td className="px-4 py-3 text-sm">
        <span className={`px-2 py-1 rounded text-xs font-medium ${getStatusColor(task.status)}`}>
          {task.status}
        </span>
      </td>
      
      {/* Title Column */}
      <td className="px-4 py-3 text-sm font-medium max-w-xs truncate">
        {task.title}
      </td>
      
      {/* Priority Column */}
      <td className="px-4 py-3 text-sm">
        <span className={getPriorityBadgeClass(task.priority)}>
          {task.priority}
        </span>
      </td>
      
      {/* SLA Column (Color-Coded) */}
      <td className={`px-4 py-3 text-sm font-medium ${
        slaStatus.zone === "red" ? "text-red-400" :
        slaStatus.zone === "yellow" ? "text-yellow-400" :
        "text-green-400"
      }`}>
        {slaStatus.message}
      </td>
      
      {/* Appointment Time Column */}
      <td className="px-4 py-3 text-sm text-zinc-400">
        {task.appointmentTime ? new Date(task.appointmentTime).toLocaleTimeString() : "—"}
      </td>
      
      {/* Assigned To Column */}
      <td className="px-4 py-3 text-sm">
        {task.assignedToId ? (
          <span className="px-2 py-1 bg-blue-900 rounded text-xs">{task.assignedToName}</span>
        ) : (
          <span className="text-zinc-500">Unassigned</span>
        )}
      </td>
    </tr>
  );
};

function getStatusColor(status: TaskStatus): string {
  const colors: Record<TaskStatus, string> = {
    CREATED: "bg-gray-700 text-gray-100",
    ASSIGNED: "bg-blue-700 text-blue-100",
    IN_PROGRESS: "bg-cyan-700 text-cyan-100",
    BLOCKED: "bg-orange-700 text-orange-100",
    BREACHED: "bg-red-700 text-red-100",
    COMPLETED: "bg-green-700 text-green-100",
    CANCELLED: "bg-zinc-700 text-zinc-100",
  };
  return colors[status] || colors.CREATED;
}

function getPriorityBadgeClass(priority: TaskPriority): string {
  const classes: Record<TaskPriority, string> = {
    URGENT: "px-2 py-1 bg-red-900 text-red-200 rounded text-xs font-medium",
    HIGH: "px-2 py-1 bg-orange-900 text-orange-200 rounded text-xs font-medium",
    MEDIUM: "px-2 py-1 bg-yellow-900 text-yellow-200 rounded text-xs font-medium",
    LOW: "px-2 py-1 bg-green-900 text-green-200 rounded text-xs font-medium",
  };
  return classes[priority] || classes.MEDIUM;
}
```

### UI/UX Design
- **Color Scheme:**
  - **Green (>30 mins):** `bg-green-950` with `border-l-green-600` left accent
  - **Yellow (10-30 mins):** `bg-yellow-950` with `border-l-yellow-500` left accent
  - **Red (<10 mins or breached):** `bg-red-950` with `border-l-red-600` left accent
- **Subtlety:** Background is muted (950 = very dark), accent is bright
- **Text:** SLA timer text color matches zone (red text for red zone, etc.)
- **Animation:** Row hover brightens slightly (opacity increase)
- **Update Frequency:** Color recalculated every 10 seconds via `setInterval`

### State Changes
- No new state needed
- Color computed from existing `task.slaDeadline` and `task.createdAt`
- Recalculation triggered by task update or periodic 10-second refresh

### API Contract
- No API changes
- Uses existing task data

### Estimated Effort: 2-3 days
- SLA color calculation logic (useSLAColor hook): 4 hours
- Task row styling updates: 4 hours
- Testing & edge cases: 4 hours

### Testing Strategy
- **Unit Test:** useSLAColor calculates zones correctly
  - Task with 60 mins remaining → green
  - Task with 15 mins remaining → yellow
  - Task with 5 mins remaining → red
  - Task with -5 mins (breached) → red with overdue message
- **Integration Test:** Task row renders with correct color, updates every 10s
- **E2E Test:** Create task → see green → after 25+ mins see yellow → after 55+ mins see red

### Dependencies
- **Depends on:** F1.2 (real-time task updates)
- **Unblocks:** F1.4 (status widget relies on this)

---

## FEATURE F1.4: Status Distribution Widget

### Problem Solved
Ops can't see workflow bottlenecks at a glance. Must manually count or filter to find "where is the clog?"

### Component Architecture

**New File:** `/Users/maverick/Documents/TaskOs/src/components/head/StatusDistributionWidget.tsx`

```typescript
interface StatusCount {
  status: TaskStatus;
  count: number;
  percentage: number;
  color: string;
  bgColor: string;
}

interface StatusDistributionWidgetProps {
  tasks: Task[];
  onStatusClick: (status: TaskStatus) => void;
  selectedStatus: TaskStatus | null;
}

export const StatusDistributionWidget: React.FC<StatusDistributionWidgetProps> = ({
  tasks,
  onStatusClick,
  selectedStatus,
}) => {
  const statusCounts = useMemo(() => {
    const counts: Record<TaskStatus, number> = {
      CREATED: 0,
      ASSIGNED: 0,
      IN_PROGRESS: 0,
      BLOCKED: 0,
      BREACHED: 0,
      COMPLETED: 0,
      CANCELLED: 0,
    };

    // Count tasks by status
    tasks.forEach(task => {
      if (!task.isArchived) {
        counts[task.status]++;
      }
    });

    const total = tasks.filter(t => !t.isArchived).length;

    const statuses: StatusCount[] = [
      {
        status: "CREATED",
        count: counts.CREATED,
        percentage: total > 0 ? (counts.CREATED / total) * 100 : 0,
        color: "text-gray-400",
        bgColor: "bg-gray-900 hover:bg-gray-800",
      },
      {
        status: "ASSIGNED",
        count: counts.ASSIGNED,
        percentage: total > 0 ? (counts.ASSIGNED / total) * 100 : 0,
        color: "text-blue-400",
        bgColor: "bg-blue-900 hover:bg-blue-800",
      },
      {
        status: "IN_PROGRESS",
        count: counts.IN_PROGRESS,
        percentage: total > 0 ? (counts.IN_PROGRESS / total) * 100 : 0,
        color: "text-cyan-400",
        bgColor: "bg-cyan-900 hover:bg-cyan-800",
      },
      {
        status: "BLOCKED",
        count: counts.BLOCKED,
        percentage: total > 0 ? (counts.BLOCKED / total) * 100 : 0,
        color: "text-orange-400",
        bgColor: "bg-orange-900 hover:bg-orange-800",
      },
      {
        status: "BREACHED",
        count: counts.BREACHED,
        percentage: total > 0 ? (counts.BREACHED / total) * 100 : 0,
        color: "text-red-400",
        bgColor: "bg-red-900 hover:bg-red-800",
      },
    ];

    return statuses;
  }, [tasks]);

  return (
    <div className="flex items-center gap-1 px-3 py-2 bg-zinc-900 rounded border border-zinc-800">
      {statusCounts.map(status => (
        <button
          key={status.status}
          onClick={() => onStatusClick(status.status)}
          className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
            selectedStatus === status.status
              ? `${status.bgColor} ring-2 ring-offset-1 ring-offset-zinc-900 ring-${status.color}`
              : status.bgColor
          }`}
          title={`${status.status}: ${status.count} (${status.percentage.toFixed(0)}%)`}
        >
          <span className={status.color}>
            {status.count}
          </span>
          <span className="text-zinc-400 ml-1">{status.status}</span>
        </button>
      ))}
    </div>
  );
};
```

**Integration in AllTasksBoard.tsx:**

```typescript
const [selectedStatusFilter, setSelectedStatusFilter] = useState<TaskStatus | null>(null);

const handleStatusClick = (status: TaskStatus) => {
  if (selectedStatusFilter === status) {
    // Click same status = toggle off
    setStatusFilter(null);
    setSelectedStatusFilter(null);
  } else {
    // Click new status = filter by that status
    setStatusFilter(status);
    setSelectedStatusFilter(status);
  }
  setPage(1);  // Reset to page 1
};

// In render header:
<StatusDistributionWidget
  tasks={tasks}
  onStatusClick={handleStatusClick}
  selectedStatus={selectedStatusFilter}
/>
```

### UI/UX Design
- **Layout:** Horizontal pill-style buttons, left-to-right workflow (CREATED → ASSIGNED → IN_PROGRESS → BLOCKED → BREACHED)
- **Color Scheme:** 
  - Each status has distinct color (gray, blue, cyan, orange, red)
  - Text shows count (e.g., "12") + status name
  - Hover brightens
  - Selected has ring outline
- **Position:** Header, top-right corner, to the right of refresh button
- **Interactivity:** Click count → filter by that status → button gets ring. Click again → clear filter.
- **Visibility:** Always visible, updates real-time as tasks change

### State Changes
- **New State:** `selectedStatusFilter: TaskStatus | null`
- **Trigger:** User clicks status count → updates both this state AND the main `statusFilter`
- **Clear:** Click same status again to toggle off

### API Contract
- No API changes
- Computes from existing task list in memory

### Estimated Effort: 2-3 days
- Component creation: 4 hours
- Integration: 1 hour
- Testing: 2-3 hours
- CSS refinement: 1 hour

### Testing Strategy
- **Unit Test:** StatusDistributionWidget calculates counts correctly, renders all statuses
- **Integration Test:** Click status → filter updates → only that status shown
- **E2E Test:** See distribution → click "BREACHED (2)" → only 2 tasks shown
- **Real-time:** New task created → count updates immediately

### Dependencies
- **Depends on:** F1.2 (real-time updates)
- **Unblocks:** None (complete in itself)

---

## FEATURE F1.5: Assignment Status Visibility

### Problem Solved
Can't verify if auto-assignment rules are working. No visibility into why tasks were assigned to specific agents. Exceptions (manual reassignments) are invisible.

### Component Architecture

**Database Changes Required (Backend):**
- Add `assignmentMethod: "AUTO" | "MANUAL"` field to Task model
- Add `assignedByRuleId: string | null` field to Task model
- Add `assignmentHistory: TaskAssignment[]` relation

**Updated Task Row (add assignment column):**

```typescript
interface TaskRowProps {
  task: Task & { assignmentMethod: "AUTO" | "MANUAL"; assignedByRuleId?: string };
  // ... other props
}

const TaskRow: React.FC<TaskRowProps> = ({ task, ... }) => {
  return (
    <tr>
      {/* ... existing columns ... */}
      
      {/* New Assignment Status Column */}
      <td className="px-4 py-3 text-sm">
        <div className="flex items-center gap-1">
          {task.assignmentMethod === "AUTO" ? (
            <>
              <span className="inline-block w-2 h-2 rounded-full bg-blue-500"></span>
              <span className="text-blue-300">Auto-assigned</span>
            </>
          ) : (
            <>
              <span className="inline-block w-2 h-2 rounded-full bg-yellow-500"></span>
              <span className="text-yellow-300">Manual override</span>
            </>
          )}
        </div>
        {task.assignedByRuleId && (
          <div className="text-xs text-zinc-400 mt-1">
            Rule: {task.assignedByRuleId}
          </div>
        )}
        <div className="text-xs text-zinc-500 mt-1">
          Assigned {formatDistanceToNow(new Date(task.assignedAt))} ago
        </div>
      </td>
      
      {/* ... rest of columns ... */}
    </tr>
  );
};

function formatDistanceToNow(date: Date): string {
  const ms = Date.now() - date.getTime();
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  
  if (hours > 0) return `${hours}h`;
  if (mins > 0) return `${mins}m`;
  return `${secs}s`;
}
```

**New Filter: "Manually Reassigned"**

```typescript
interface FilterOptions {
  statusFilter?: TaskStatus;
  priorityFilter?: TaskPriority;
  assignmentMethod?: "AUTO" | "MANUAL";  // NEW
}

// In AllTasksBoard fetch params:
const params = new URLSearchParams({
  status: statusFilter || "",
  priority: priorityFilter || "",
  assignmentMethod: assignmentMethodFilter || "",  // NEW
  sortBy,
  sortOrder,
  page: page.toString(),
  limit: "25",
});

// Add toggle button in filter bar:
<button
  onClick={() => setAssignmentMethodFilter(
    assignmentMethodFilter === "MANUAL" ? null : "MANUAL"
  )}
  className={`px-3 py-1 text-sm rounded transition-colors ${
    assignmentMethodFilter === "MANUAL"
      ? "bg-yellow-700 text-yellow-100"
      : "bg-zinc-700 text-zinc-300 hover:bg-zinc-600"
  }`}
>
  ⚠ Manual Overrides Only
</button>
```

### UI/UX Design
- **Assignment Indicator Column:**
  - Blue dot + "Auto-assigned": Normal (rule-based)
  - Yellow dot + "Manual override": Exception (someone overrode the rule)
  - Show rule ID if available (e.g., "Rule: R2-Phlebotomy")
  - Show time since assignment: "Assigned 5 mins ago"

- **Filter Button:**
  - Position: Filter bar, after priority filter
  - Active state: Yellow background (shows it's filtering for manual overrides)
  - Inactive state: Gray background
  - Tooltip: "Show only manually reassigned tasks"

### State Changes
- **New State:** `assignmentMethodFilter: "AUTO" | "MANUAL" | null`
- **Update on:** User clicks filter button
- **Reset on:** Page load or when filters change

### API Contract
- **GET /api/tasks** additions:
  - Query param: `assignmentMethod=AUTO|MANUAL` (optional)
  - Response includes: `assignmentMethod`, `assignedByRuleId`, `assignedAt`
- **Example Response:**
```json
{
  "id": 1,
  "title": "Verify Insurance",
  "status": "ASSIGNED",
  "assignedToId": 5,
  "assignedToName": "John Smith",
  "assignmentMethod": "AUTO",
  "assignedByRuleId": "R2",
  "assignedAt": "2026-05-01T10:30:00Z",
  ...
}
```

### Estimated Effort: 3-4 days
- Database schema updates: 1 hour (backend)
- Component updates (add column, filter): 2 hours
- Filter logic: 1 hour
- Testing: 2-3 hours

### Testing Strategy
- **Unit Test:** Assignment status renders correctly (auto vs. manual)
- **Integration Test:** 
  - Create task auto-assigned → shows "Auto-assigned"
  - Manually reassign task → shows "Manual override"
  - Filter by "Manual overrides" → only shows manually reassigned tasks
- **E2E Test:** Create order → task auto-assigned → verify indicator, then manually reassign and verify indicator updates

### Dependencies
- **Depends on:** Backend changes (Backend Plan, F-B1.3)
- **Unblocks:** Phase 2 features (side panel, audit trail)

---

## PHASE 1 SUMMARY

### Completed Features
1. ✅ Manual Refresh + Last Updated (F1.1)
2. ✅ Auto-Refresh on New Tasks (F1.2)
3. ✅ Color-Coded Urgency Zones (F1.3)
4. ✅ Status Distribution Widget (F1.4)
5. ✅ Assignment Status Visibility (F1.5)

### Effort Summary
- **Total Days:** 14-18 developer days
- **Timeline:** 2 weeks (full-time team)
- **Dependencies on Backend:** F-B1.1 (WebSocket), F-B1.3 (assignment data)

### Success Criteria Met
- ✅ Ops can see data freshness (timestamp)
- ✅ Ops notified of new tasks (<5s)
- ✅ SLA urgency visible at a glance (colors)
- ✅ Workflow bottleneck visible instantly (status widget)
- ✅ Auto-assignment verification visible (assignment status)

### Next Steps
- Phase 2 builds on Phase 1
- All Phase 1 features must ship together (interdependent)
- QA sign-off required before Phase 2 starts

---

# PHASE 2: USABILITY (Weeks 3-5)

## Overview
Five features enabling deep inspection without context-switching, powerful filtering, and rich SLA context. These improve user productivity and decision velocity.

---

## FEATURE F2.1: Unified Filter Bar

**Problem Solved:** Filters scattered across header. Users can't easily combine multiple filters (e.g., "HIGH priority + CREATED + unassigned").

**File:** `/Users/maverick/Documents/TaskOs/src/components/head/UnifiedFilterBar.tsx` (new)

```typescript
interface FilterState {
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: string;  // User ID or "unassigned"
  dateFrom?: Date;
  dateTo?: Date;
  slaRiskOnly?: boolean;  // Show <30 mins remaining only
}

export const UnifiedFilterBar: React.FC<{
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  agents: Array<{ id: string; name: string }>;
  onSaveFilter?: (filterName: string, filters: FilterState) => void;
}> = ({ filters, onFiltersChange, agents, onSaveFilter }) => {
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showSaveFilter, setShowSaveFilter] = useState(false);
  const [filterName, setFilterName] = useState("");

  const activeFilterCount = Object.values(filters).filter(v => v).length;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded p-3 space-y-2">
      {/* Filter Input Row */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Status Filter */}
        <select
          value={filters.status || ""}
          onChange={(e) => onFiltersChange({ ...filters, status: e.target.value as TaskStatus || undefined })}
          className="px-3 py-1 bg-zinc-800 border border-zinc-700 rounded text-sm text-white"
        >
          <option value="">All Statuses</option>
          <option value="CREATED">CREATED</option>
          <option value="ASSIGNED">ASSIGNED</option>
          <option value="IN_PROGRESS">IN_PROGRESS</option>
          <option value="BLOCKED">BLOCKED</option>
          <option value="BREACHED">BREACHED</option>
          <option value="COMPLETED">COMPLETED</option>
          <option value="CANCELLED">CANCELLED</option>
        </select>

        {/* Priority Filter */}
        <select
          value={filters.priority || ""}
          onChange={(e) => onFiltersChange({ ...filters, priority: e.target.value as TaskPriority || undefined })}
          className="px-3 py-1 bg-zinc-800 border border-zinc-700 rounded text-sm text-white"
        >
          <option value="">All Priorities</option>
          <option value="URGENT">URGENT</option>
          <option value="HIGH">HIGH</option>
          <option value="MEDIUM">MEDIUM</option>
          <option value="LOW">LOW</option>
        </select>

        {/* Assignee Filter */}
        <select
          value={filters.assignee || ""}
          onChange={(e) => onFiltersChange({ ...filters, assignee: e.target.value || undefined })}
          className="px-3 py-1 bg-zinc-800 border border-zinc-700 rounded text-sm text-white"
        >
          <option value="">All Assignees</option>
          <option value="unassigned">Unassigned</option>
          {agents.map(agent => (
            <option key={agent.id} value={agent.id}>{agent.name}</option>
          ))}
        </select>

        {/* SLA Risk Toggle */}
        <button
          onClick={() => onFiltersChange({ ...filters, slaRiskOnly: !filters.slaRiskOnly })}
          className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
            filters.slaRiskOnly
              ? "bg-red-700 text-red-100"
              : "bg-zinc-700 text-zinc-300 hover:bg-zinc-600"
          }`}
        >
          🔴 SLA at Risk (<30 mins)
        </button>

        {/* Date Range Button */}
        <button
          onClick={() => setShowDatePicker(!showDatePicker)}
          className={`px-3 py-1 rounded text-sm transition-colors ${
            filters.dateFrom || filters.dateTo
              ? "bg-blue-700 text-blue-100"
              : "bg-zinc-700 text-zinc-300 hover:bg-zinc-600"
          }`}
        >
          📅 {filters.dateFrom && filters.dateTo ? `${new Date(filters.dateFrom).toLocaleDateString()} - ${new Date(filters.dateTo).toLocaleDateString()}` : "Date Range"}
        </button>

        {/* Clear All Button */}
        {activeFilterCount > 0 && (
          <button
            onClick={() => onFiltersChange({})}
            className="px-3 py-1 bg-zinc-700 text-zinc-300 rounded text-sm hover:bg-zinc-600"
          >
            ✕ Clear All ({activeFilterCount})
          </button>
        )}

        {/* Save Filter Button */}
        <button
          onClick={() => setShowSaveFilter(!showSaveFilter)}
          className="px-3 py-1 bg-zinc-700 text-zinc-300 rounded text-sm hover:bg-zinc-600"
        >
          ⭐ Save Filter
        </button>
      </div>

      {/* Date Range Picker (if shown) */}
      {showDatePicker && (
        <div className="flex items-center gap-2 p-2 bg-zinc-800 rounded">
          <input
            type="date"
            value={filters.dateFrom ? new Date(filters.dateFrom).toISOString().split("T")[0] : ""}
            onChange={(e) => onFiltersChange({
              ...filters,
              dateFrom: e.target.value ? new Date(e.target.value) : undefined,
            })}
            className="px-2 py-1 bg-zinc-700 border border-zinc-600 rounded text-sm text-white"
            placeholder="From"
          />
          <span className="text-zinc-400">to</span>
          <input
            type="date"
            value={filters.dateTo ? new Date(filters.dateTo).toISOString().split("T")[0] : ""}
            onChange={(e) => onFiltersChange({
              ...filters,
              dateTo: e.target.value ? new Date(e.target.value) : undefined,
            })}
            className="px-2 py-1 bg-zinc-700 border border-zinc-600 rounded text-sm text-white"
            placeholder="To"
          />
        </div>
      )}

      {/* Save Filter Dialog (if shown) */}
      {showSaveFilter && (
        <div className="flex items-center gap-2 p-2 bg-zinc-800 rounded">
          <input
            type="text"
            value={filterName}
            onChange={(e) => setFilterName(e.target.value)}
            placeholder="Filter name (e.g., 'URGENT CREATED')"
            className="flex-1 px-2 py-1 bg-zinc-700 border border-zinc-600 rounded text-sm text-white"
          />
          <button
            onClick={() => {
              if (filterName && onSaveFilter) {
                onSaveFilter(filterName, filters);
                setFilterName("");
                setShowSaveFilter(false);
              }
            }}
            className="px-3 py-1 bg-blue-700 text-blue-100 rounded text-sm hover:bg-blue-600"
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
};
```

**Integration in AllTasksBoard.tsx:**

```typescript
const [filters, setFilters] = useState<FilterState>({});
const [savedFilters, setSavedFilters] = useState<Array<{ name: string; filters: FilterState }>>([]);

const handleFiltersChange = (newFilters: FilterState) => {
  setFilters(newFilters);
  setPage(1);  // Reset pagination
  // Fetch with new filters
  fetchTasks();
};

const handleSaveFilter = (name: string, filterState: FilterState) => {
  setSavedFilters([...savedFilters, { name, filters: filterState }]);
  // Persist to localStorage or backend
};

// Render:
<UnifiedFilterBar
  filters={filters}
  onFiltersChange={handleFiltersChange}
  agents={agents}
  onSaveFilter={handleSaveFilter}
/>

{/* Saved Filters Quick Access */}
{savedFilters.length > 0 && (
  <div className="mt-2 flex gap-1 flex-wrap">
    {savedFilters.map(saved => (
      <button
        key={saved.name}
        onClick={() => handleFiltersChange(saved.filters)}
        className="px-2 py-1 bg-purple-800 text-purple-200 rounded text-xs hover:bg-purple-700"
      >
        {saved.name}
      </button>
    ))}
  </div>
)}
```

**Effort:** 4 days (UI, date picker integration, localStorage, testing)

---

## FEATURE F2.2: Better SLA Display

**Problem Solved:** SLA countdown shows only remaining time. Users don't understand SLA context (when created, what was deadline, when breached).

```typescript
interface EnhancedSLAColumnProps {
  task: Task;
}

const EnhancedSLAColumn: React.FC<EnhancedSLAColumnProps> = ({ task }) => {
  const now = new Date();
  const created = new Date(task.createdAt);
  const deadline = new Date(task.slaDeadline);
  const remaining = deadline.getTime() - now.getTime();
  
  // Calculate SLA duration from task rules (or estimate)
  const slaMinutes = (deadline.getTime() - created.getTime()) / 60000;
  
  const status = task.status === "BREACHED" || remaining < 0
    ? "breached"
    : remaining < 10 * 60 * 1000  // < 10 mins
    ? "critical"
    : remaining < 30 * 60 * 1000  // < 30 mins
    ? "at-risk"
    : "safe";

  const [showTooltip, setShowTooltip] = useState(false);
  
  return (
    <div
      className="relative"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {/* Main SLA Display */}
      <div className={`text-sm font-medium ${
        status === "breached" ? "text-red-400" :
        status === "critical" ? "text-red-300" :
        status === "at-risk" ? "text-yellow-400" :
        "text-green-400"
      }`}>
        {remaining < 0
          ? `+${Math.floor(Math.abs(remaining) / 60000)}m overdue`
          : `${Math.floor(remaining / 60000)}m remaining`
        }
      </div>

      {/* Hover Tooltip */}
      {showTooltip && (
        <div className="absolute top-full mt-1 left-0 bg-zinc-800 border border-zinc-700 rounded p-2 text-xs text-zinc-300 whitespace-nowrap z-10">
          <div>Created: {created.toLocaleTimeString()}</div>
          <div>SLA: {Math.round(slaMinutes)} minutes</div>
          <div>Deadline: {deadline.toLocaleTimeString()}</div>
          <div className="text-zinc-500 mt-1">
            {status === "breached" ? "BREACHED" : "On track"}
          </div>
        </div>
      )}

      {/* Optional: Inline Progress Bar */}
      <div className="mt-1 h-1 bg-zinc-800 rounded overflow-hidden">
        <div
          className={`h-full transition-all ${
            status === "breached" || status === "critical" ? "bg-red-600" :
            status === "at-risk" ? "bg-yellow-500" :
            "bg-green-600"
          }`}
          style={{
            width: status === "breached" ? "0%" : `${Math.max(0, Math.min(100, (remaining / (slaMinutes * 60000)) * 100))}%`,
          }}
        />
      </div>
    </div>
  );
};
```

**Effort:** 2 days (component, tooltip logic, testing)

---

## FEATURE F2.3: Task Detail Side Panel

**Problem Solved:** Click order ID opens modal (loses context). Need deep inspection without leaving task list.

**New File:** `/Users/maverick/Documents/TaskOs/src/components/TaskDetailPanel.tsx`

```typescript
interface TaskDetailPanelProps {
  task: Task | null;
  isOpen: boolean;
  onClose: () => void;
  onReassign?: (taskId: number, agentId: number) => Promise<void>;
  onBlock?: (taskId: number) => Promise<void>;
  onCancel?: (taskId: number) => Promise<void>;
}

export const TaskDetailPanel: React.FC<TaskDetailPanelProps> = ({
  task,
  isOpen,
  onClose,
  onReassign,
  onBlock,
  onCancel,
}) => {
  if (!isOpen || !task) return null;

  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"details" | "history" | "checklist">("details");

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
      />

      {/* Side Panel (slides in from right) */}
      <div className="fixed right-0 top-0 bottom-0 w-96 bg-zinc-900 border-l border-zinc-800 z-50 overflow-y-auto shadow-lg">
        {/* Header */}
        <div className="sticky top-0 bg-zinc-900 border-b border-zinc-800 p-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Task Details</h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-zinc-800">
          {["details", "history", "checklist"].map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab as typeof activeTab)}
              className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === tab
                  ? "text-white border-b-2 border-b-blue-500"
                  : "text-zinc-400 hover:text-zinc-300"
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {activeTab === "details" && (
            <>
              {/* Basic Info */}
              <section>
                <h3 className="text-sm font-bold text-white mb-2">Task</h3>
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="text-zinc-500">ID:</span>
                    <span className="ml-2 text-white">T-{task.id}</span>
                  </div>
                  <div>
                    <span className="text-zinc-500">Title:</span>
                    <span className="ml-2 text-white">{task.title}</span>
                  </div>
                  <div>
                    <span className="text-zinc-500">Status:</span>
                    <span className="ml-2">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${getStatusColor(task.status)}`}>
                        {task.status}
                      </span>
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-500">Priority:</span>
                    <span className="ml-2 text-white">{task.priority}</span>
                  </div>
                  <div>
                    <span className="text-zinc-500">Type:</span>
                    <span className="ml-2 text-white">{task.taskTypeName || "N/A"}</span>
                  </div>
                </div>
              </section>

              {/* Order Info */}
              <section className="border-t border-zinc-800 pt-4">
                <h3 className="text-sm font-bold text-white mb-2">Order</h3>
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="text-zinc-500">Order ID:</span>
                    <a href={`/orders/${task.entityId}`} className="ml-2 text-blue-400 hover:text-blue-300">
                      #{task.entityId}
                    </a>
                  </div>
                  <div>
                    <span className="text-zinc-500">Appointment:</span>
                    <span className="ml-2 text-white">
                      {task.appointmentTime
                        ? new Date(task.appointmentTime).toLocaleString()
                        : "Not scheduled"}
                    </span>
                  </div>
                </div>
              </section>

              {/* SLA Info */}
              <section className="border-t border-zinc-800 pt-4">
                <h3 className="text-sm font-bold text-white mb-2">SLA</h3>
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="text-zinc-500">Created:</span>
                    <span className="ml-2 text-white">{new Date(task.createdAt).toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-zinc-500">Deadline:</span>
                    <span className="ml-2 text-white">{new Date(task.slaDeadline).toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-zinc-500">Status:</span>
                    <span className="ml-2 text-white">
                      {new Date(task.slaDeadline).getTime() < Date.now() ? "Breached" : "On track"}
                    </span>
                  </div>
                </div>
              </section>

              {/* Assignment Info */}
              <section className="border-t border-zinc-800 pt-4">
                <h3 className="text-sm font-bold text-white mb-2">Assignment</h3>
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="text-zinc-500">Assigned To:</span>
                    <span className="ml-2 text-white">
                      {task.assignedToName || "Unassigned"}
                    </span>
                  </div>
                  {task.assignedAt && (
                    <div>
                      <span className="text-zinc-500">Assigned At:</span>
                      <span className="ml-2 text-white">
                        {new Date(task.assignedAt).toLocaleString()}
                      </span>
                    </div>
                  )}
                  <div>
                    <span className="text-zinc-500">Method:</span>
                    <span className="ml-2 text-white">
                      {task.assignmentMethod === "AUTO" ? "Auto-assigned" : "Manual override"}
                    </span>
                  </div>
                </div>
              </section>

              {/* Actions */}
              <section className="border-t border-zinc-800 pt-4">
                <div className="flex flex-col gap-2">
                  {task.status !== "COMPLETED" && (
                    <>
                      {onReassign && (
                        <button
                          onClick={() => {
                            // TODO: Open agent selector modal
                          }}
                          disabled={isLoading}
                          className="w-full px-4 py-2 bg-blue-700 text-white rounded hover:bg-blue-600 disabled:opacity-50"
                        >
                          Reassign
                        </button>
                      )}
                      {onBlock && task.status !== "BLOCKED" && (
                        <button
                          onClick={async () => {
                            setIsLoading(true);
                            try {
                              await onBlock(task.id);
                            } finally {
                              setIsLoading(false);
                            }
                          }}
                          disabled={isLoading}
                          className="w-full px-4 py-2 bg-orange-700 text-white rounded hover:bg-orange-600 disabled:opacity-50"
                        >
                          Mark Blocked
                        </button>
                      )}
                      {onCancel && (
                        <button
                          onClick={async () => {
                            setIsLoading(true);
                            try {
                              await onCancel(task.id);
                            } finally {
                              setIsLoading(false);
                            }
                          }}
                          disabled={isLoading}
                          className="w-full px-4 py-2 bg-red-700 text-white rounded hover:bg-red-600 disabled:opacity-50"
                        >
                          Cancel Task
                        </button>
                      )}
                    </>
                  )}
                </div>
              </section>
            </>
          )}

          {activeTab === "history" && (
            <section>
              <h3 className="text-sm font-bold text-white mb-3">Status Changes</h3>
              <div className="space-y-3">
                {/* TODO: Fetch and display task history */}
                <p className="text-xs text-zinc-500">History loading...</p>
              </div>
            </section>
          )}

          {activeTab === "checklist" && (
            <section>
              <h3 className="text-sm font-bold text-white mb-3">Checklist Items</h3>
              <div className="space-y-2">
                {/* TODO: Display checklist if task type has one */}
                <p className="text-xs text-zinc-500">No checklist items</p>
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
};
```

**Effort:** 4-5 days (panel component, task history endpoint, testing)

---

## FEATURE F2.4: Improved Empty State

**Problem Solved:** "No tasks match your filters" doesn't help users recover.

```typescript
const EmptyState: React.FC<{
  filters: FilterState;
  totalTasks: number;
  onClearFilters: () => void;
}> = ({ filters, totalTasks, onClearFilters }) => {
  const activeFilterCount = Object.values(filters).filter(v => v).length;

  return (
    <div className="text-center py-12">
      <div className="text-4xl mb-3">📭</div>
      <h2 className="text-lg font-bold text-white mb-2">No tasks match your filters</h2>
      <p className="text-zinc-400 mb-4">You have {totalTasks} total tasks.</p>
      
      {/* Active Filters Display */}
      {activeFilterCount > 0 && (
        <div className="mb-4">
          <p className="text-xs text-zinc-500 mb-2">Active filters:</p>
          <div className="flex gap-2 flex-wrap justify-center">
            {Object.entries(filters).filter(([_, v]) => v).map(([key, value]) => (
              <span key={key} className="px-2 py-1 bg-zinc-800 text-xs rounded text-zinc-300">
                {key}: {String(value)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Recovery Options */}
      <div className="space-y-2">
        <button
          onClick={onClearFilters}
          className="inline-block px-4 py-2 bg-blue-700 text-white rounded hover:bg-blue-600"
        >
          Clear all filters
        </button>
        <p className="text-xs text-zinc-500">or try adjusting your search</p>
      </div>
    </div>
  );
};
```

**Effort:** 1 day

---

## FEATURE F2.5: Assignment Rule Audit Trail (In Side Panel)

**Problem Solved:** Can't see which rule triggered task assignment or if manual intervention happened.

**Updates to TaskDetailPanel:**

```typescript
{activeTab === "details" && (
  <>
    {/* ... existing sections ... */}
    
    {/* Assignment Audit Trail */}
    <section className="border-t border-zinc-800 pt-4">
      <h3 className="text-sm font-bold text-white mb-2">Assignment Audit</h3>
      <div className="space-y-2 text-xs">
        {task.assignmentMethod === "AUTO" ? (
          <>
            <p className="text-blue-300">
              ✓ Auto-assigned by rule: {task.assignedByRuleId}
            </p>
            <p className="text-zinc-500">
              Evaluated at: {new Date(task.assignedAt).toLocaleString()}
            </p>
            {task.ruleDetails && (
              <div className="mt-2 p-2 bg-zinc-800 rounded text-zinc-400">
                <p className="font-mono text-xs">{task.ruleDetails}</p>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="text-yellow-300">
              ⚠ Manual override by: {task.reassignedByName}
            </p>
            <p className="text-zinc-500">
              Reassigned at: {new Date(task.reassignedAt).toLocaleString()}
            </p>
            {task.reassignmentReason && (
              <p className="text-zinc-400 mt-1">{task.reassignmentReason}</p>
            )}
          </>
        )}
      </div>
    </section>
  </>
)}
```

**Effort:** 2 days (data structure, display logic)

---

## PHASE 2 SUMMARY

### Completed Features
1. ✅ Unified Filter Bar (F2.1)
2. ✅ Better SLA Display (F2.2)
3. ✅ Task Detail Side Panel (F2.3)
4. ✅ Improved Empty State (F2.4)
5. ✅ Assignment Rule Audit Trail (F2.5)

### Effort Summary
- **Total Days:** 14-17 developer days
- **Timeline:** 3 weeks (with Phase 1 running in parallel)

### Next Steps
- Phase 3 builds on Phases 1 & 2
- All Phase 2 features should ship together

---

# PHASE 3: INTELLIGENCE (Weeks 6-10)

## Overview
Four advanced features enabling visual workflow management, proactive alerts, and task aging indicators. These make the system feel alive and responsive.

---

## FEATURE F3.1: Kanban / Grouping View

**Problem Solved:** Table view is linear. Ops need to see workflow visually (task distribution across statuses).

**New File:** `/Users/maverick/Documents/TaskOs/src/components/KanbanView.tsx`

```typescript
interface KanbanColumn {
  status: TaskStatus;
  tasks: Task[];
  count: number;
  color: string;
}

export const KanbanView: React.FC<{
  tasks: Task[];
  filters: FilterState;
  onTaskUpdate: (taskId: number, status: TaskStatus) => Promise<void>;
}> = ({ tasks, filters, onTaskUpdate }) => {
  const [columns, setColumns] = useState<KanbanColumn[]>([
    { status: "CREATED", tasks: [], count: 0, color: "bg-gray-700" },
    { status: "ASSIGNED", tasks: [], count: 0, color: "bg-blue-700" },
    { status: "IN_PROGRESS", tasks: [], count: 0, color: "bg-cyan-700" },
    { status: "BLOCKED", tasks: [], count: 0, color: "bg-orange-700" },
    { status: "COMPLETED", tasks: [], count: 0, color: "bg-green-700" },
  ]);

  useEffect(() => {
    // Organize tasks by status
    const byStatus: Record<TaskStatus, Task[]> = {
      CREATED: [],
      ASSIGNED: [],
      IN_PROGRESS: [],
      BLOCKED: [],
      BREACHED: [],
      COMPLETED: [],
      CANCELLED: [],
    };

    tasks.forEach(task => {
      byStatus[task.status].push(task);
    });

    setColumns(prev =>
      prev.map(col => ({
        ...col,
        tasks: byStatus[col.status] || [],
        count: (byStatus[col.status] || []).length,
      }))
    );
  }, [tasks]);

  const handleDragEnd = async (taskId: number, newStatus: TaskStatus) => {
    try {
      await onTaskUpdate(taskId, newStatus);
    } catch (e) {
      console.error("Failed to update task status:", e);
    }
  };

  return (
    <div className="grid grid-cols-5 gap-4 p-4 overflow-x-auto">
      {columns.map(column => (
        <div
          key={column.status}
          className="flex flex-col bg-zinc-900 rounded border border-zinc-800 min-w-72"
        >
          {/* Column Header */}
          <div className={`${column.color} text-white p-3 font-bold rounded-t flex items-center justify-between`}>
            <span>{column.status}</span>
            <span className="bg-black/30 rounded px-2 py-1 text-xs">
              {column.count}
            </span>
          </div>

          {/* Tasks */}
          <div className="flex-1 p-3 space-y-2 overflow-y-auto">
            {column.tasks.map(task => (
              <KanbanCard
                key={task.id}
                task={task}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("taskId", task.id.toString());
                }}
              />
            ))}
          </div>

          {/* Drop Zone */}
          <div
            className="p-3 border-t border-zinc-800 text-center text-xs text-zinc-500 hover:bg-zinc-800/50 transition-colors"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={(e) => {
              e.preventDefault();
              const taskId = parseInt(e.dataTransfer.getData("taskId"));
              handleDragEnd(taskId, column.status);
            }}
          >
            Drop here to move
          </div>
        </div>
      ))}
    </div>
  );
};

// Card Component
const KanbanCard: React.FC<{
  task: Task;
  onDragStart: (e: React.DragEvent) => void;
}> = ({ task, onDragStart }) => {
  const slaStatus = useSLAColor(task);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      className={`p-3 rounded border-l-4 cursor-move hover:shadow-lg transition-shadow ${
        slaStatus.zone === "red" ? "bg-red-900 border-l-red-600" :
        slaStatus.zone === "yellow" ? "bg-yellow-900 border-l-yellow-500" :
        "bg-green-900 border-l-green-600"
      }`}
    >
      <h4 className="text-sm font-medium text-white truncate">{task.title}</h4>
      <p className="text-xs text-zinc-400 mt-1">
        {task.assignedToName || "Unassigned"}
      </p>
      <p className={`text-xs mt-1 font-medium ${
        slaStatus.zone === "red" ? "text-red-300" :
        slaStatus.zone === "yellow" ? "text-yellow-300" :
        "text-green-300"
      }`}>
        {slaStatus.message}
      </p>
    </div>
  );
};
```

**Toggle in Header:**
```typescript
<div className="flex items-center gap-2">
  <button
    onClick={() => setViewMode("table")}
    className={`px-3 py-1 rounded text-sm ${viewMode === "table" ? "bg-blue-700" : "bg-zinc-700"}`}
  >
    Table
  </button>
  <button
    onClick={() => setViewMode("kanban")}
    className={`px-3 py-1 rounded text-sm ${viewMode === "kanban" ? "bg-blue-700" : "bg-zinc-700"}`}
  >
    Kanban
  </button>
</div>

{viewMode === "table" && <TaskTable ... />}
{viewMode === "kanban" && <KanbanView ... />}
```

**Effort:** 5-7 days (Kanban component, drag-drop logic, state management)

---

## FEATURE F3.2: Real-Time Alerts / Notifications

**Problem Solved:** User doesn't get notification when task breaches SLA; finds out 30+ mins later.

**New File:** `/Users/maverick/Documents/TaskOs/src/components/AlertBell.tsx`

```typescript
interface Alert {
  id: string;
  type: "sla_warning" | "sla_breached" | "assignment_failed";
  taskId: number;
  taskTitle: string;
  message: string;
  timestamp: Date;
  read: boolean;
}

export const AlertBell: React.FC<{
  alerts: Alert[];
  onMarkAsRead: (alertId: string) => void;
  onDismiss: (alertId: string) => void;
}> = ({ alerts, onMarkAsRead, onDismiss }) => {
  const [showDropdown, setShowDropdown] = useState(false);
  const unreadCount = alerts.filter(a => !a.read).length;

  return (
    <div className="relative">
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        className="relative p-2 hover:bg-zinc-800 rounded transition-colors"
        title="Notifications"
      >
        🔔
        {unreadCount > 0 && (
          <span className="absolute top-0 right-0 w-5 h-5 bg-red-600 text-white text-xs rounded-full flex items-center justify-center">
            {unreadCount}
          </span>
        )}
      </button>

      {showDropdown && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-zinc-900 border border-zinc-800 rounded shadow-lg z-50">
          <div className="border-b border-zinc-800 p-3 font-bold text-white flex items-center justify-between">
            <span>Alerts ({unreadCount} new)</span>
            <button onClick={() => setShowDropdown(false)}>✕</button>
          </div>

          {alerts.length === 0 ? (
            <div className="p-4 text-center text-zinc-500 text-sm">No alerts</div>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              {alerts.map(alert => (
                <div
                  key={alert.id}
                  className={`p-3 border-b border-zinc-800 cursor-pointer hover:bg-zinc-800 transition-colors ${
                    alert.read ? "" : "bg-blue-900/30"
                  }`}
                  onClick={() => onMarkAsRead(alert.id)}
                >
                  <div className="flex items-start gap-2">
                    <span className="text-lg mt-1">
                      {alert.type === "sla_breached" ? "🔴" : "⚠️"}
                    </span>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-white">{alert.message}</p>
                      <p className="text-xs text-zinc-400 mt-1">{alert.taskTitle}</p>
                      <p className="text-xs text-zinc-500 mt-1">
                        {new Date(alert.timestamp).toLocaleTimeString()}
                      </p>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDismiss(alert.id);
                      }}
                      className="text-zinc-500 hover:text-white"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
```

**WebSocket Integration:**

```typescript
useEffect(() => {
  const unsubscribe = taskEventEmitter.on(TaskEventType.TASK_UPDATED, (event) => {
    // Check if task is now breaching
    const deadline = new Date(event.task.slaDeadline);
    const now = new Date();
    const minutesRemaining = (deadline.getTime() - now.getTime()) / 60000;

    if (event.task.status === "BREACHED") {
      addAlert({
        type: "sla_breached",
        taskId: event.task.id,
        taskTitle: event.task.title,
        message: `Task T-${event.task.id} breached SLA!`,
        timestamp: now,
        read: false,
      });

      // Show toast
      showToast({
        type: "error",
        message: `🔴 Task T-${event.task.id} breached SLA!`,
        duration: 10000,
      });
    } else if (minutesRemaining > 0 && minutesRemaining < 5) {
      addAlert({
        type: "sla_warning",
        taskId: event.task.id,
        taskTitle: event.task.title,
        message: `Task breaching in ${Math.ceil(minutesRemaining)} minutes`,
        timestamp: now,
        read: false,
      });
    }
  });

  return unsubscribe;
}, []);
```

**Effort:** 3-4 days (alert system, WebSocket integration, bell component)

---

## FEATURE F3.3: Task Aging Indicator

**Problem Solved:** Task in ASSIGNED status for 2+ hours, but no visual cue that it's stuck.

```typescript
interface TaskAgeIndicatorProps {
  task: Task;
}

const TaskAgeIndicator: React.FC<TaskAgeIndicatorProps> = ({ task }) => {
  const [ageInfo, setAgeInfo] = useState<{
    duration: string;
    color: "green" | "yellow" | "red";
    minutes: number;
  }>({ duration: "", color: "green", minutes: 0 });

  useEffect(() => {
    const updateAge = () => {
      const now = new Date();
      let relevantTime = new Date(task.createdAt);

      // If task is in ASSIGNED or IN_PROGRESS, use that transition time
      if ((task.status === "ASSIGNED" || task.status === "IN_PROGRESS") && task.statusChangedAt) {
        relevantTime = new Date(task.statusChangedAt);
      }

      const minutes = Math.floor((now.getTime() - relevantTime.getTime()) / 60000);
      const hours = Math.floor(minutes / 60);

      let duration = "";
      if (hours > 0) {
        duration = `${hours}h ${minutes % 60}m`;
      } else {
        duration = `${minutes}m`;
      }

      const color = minutes > 60 ? "red" : minutes > 30 ? "yellow" : "green";

      setAgeInfo({ duration, color, minutes });
    };

    updateAge();
    const interval = setInterval(updateAge, 60000);  // Update every minute
    return () => clearInterval(interval);
  }, [task]);

  if (task.status === "CREATED" || task.status === "COMPLETED") {
    return null;  // Only show for in-progress statuses
  }

  return (
    <div className={`text-xs font-medium px-2 py-1 rounded ${
      ageInfo.color === "red" ? "bg-red-900 text-red-300" :
      ageInfo.color === "yellow" ? "bg-yellow-900 text-yellow-300" :
      "bg-green-900 text-green-300"
    }`}>
      {task.status} for {ageInfo.duration}
    </div>
  );
};
```

**Add to Task Row:**
```typescript
<td className="px-4 py-3 text-sm">
  <TaskAgeIndicator task={task} />
</td>
```

**Effort:** 2-3 days

---

## FEATURE F3.4: Bulk Select for Filtered View

**Problem Solved:** Can select individual tasks, but when filtering (e.g., "all COMPLETED"), can't select all at once to bulk archive.

```typescript
// Add checkbox to table header
<th className="px-4 py-3 w-10">
  <input
    type="checkbox"
    checked={allSelected}
    onChange={(e) => {
      if (e.target.checked) {
        // Select all visible tasks
        setSelected(new Set(tasks.map(t => t.id)));
      } else {
        setSelected(new Set());
      }
    }}
    title={`Select all ${tasks.length} visible tasks`}
    className="rounded"
  />
  <span className="text-xs text-zinc-500 ml-2">
    ({selected.size} selected)
  </span>
</th>
```

**Bulk Archive Action:**
```typescript
{selected.size > 0 && (
  <div className="fixed bottom-4 left-1/2 transform -translate-x-1/2 bg-zinc-900 border border-zinc-800 rounded p-4 shadow-lg z-40">
    <div className="flex items-center gap-4">
      <span className="text-sm text-white">{selected.size} tasks selected</span>
      
      {/* Archive Completed */}
      {Array.from(selected).every(id => {
        const task = tasks.find(t => t.id === id);
        return task?.status === "COMPLETED";
      }) && (
        <button
          onClick={async () => {
            await archiveTasks(Array.from(selected));
            setSelected(new Set());
            showToast({
              type: "success",
              message: `Archived ${selected.size} tasks`,
            });
          }}
          className="px-4 py-2 bg-green-700 text-white rounded hover:bg-green-600"
        >
          Archive All
        </button>
      )}

      {/* Bulk Reassign */}
      <button
        onClick={() => setShowBulkReassign(true)}
        className="px-4 py-2 bg-blue-700 text-white rounded hover:bg-blue-600"
      >
        Reassign ({selected.size})
      </button>

      <button
        onClick={() => setSelected(new Set())}
        className="px-2 py-1 bg-zinc-700 text-white rounded hover:bg-zinc-600"
      >
        ✕
      </button>
    </div>
  </div>
)}
```

**Effort:** 2-3 days

---

## PHASE 3 SUMMARY

### Completed Features
1. ✅ Kanban / Grouping View (F3.1)
2. ✅ Real-Time Alerts / Notifications (F3.2)
3. ✅ Task Aging Indicator (F3.3)
4. ✅ Bulk Select for Filtered View (F3.4)

### Effort Summary
- **Total Days:** 12-17 developer days
- **Timeline:** 4 weeks (including integration testing)

---

# SUMMARY & IMPLEMENTATION ROADMAP

## Timeline

| Phase | Weeks | Features | Effort | Status |
|-------|-------|----------|--------|--------|
| **1** | 1-2 | Refresh, Auto-refresh, Colors, Status widget, Assignment status | 14-18 days | CRITICAL |
| **2** | 3-5 | Filters, Better SLA, Side panel, Empty state, Audit trail | 14-17 days | HIGH |
| **3** | 6-10 | Kanban, Alerts, Aging, Bulk select | 12-17 days | MEDIUM |
| **Total** | 10 weeks | 14 features | 40-52 days | — |

## Critical Path

1. **Week 1-2:** Launch Phase 1 (real-time foundation)
2. **Week 3-5:** Launch Phase 2 (usability layer)
3. **Week 6-10:** Launch Phase 3 (intelligence)

## Team Requirements

- **1 Lead Frontend Engineer** (architecture, coordination)
- **1 Mid-level Frontend Engineer** (features, testing)
- **1 Product Manager** (requirements, QA sign-off)
- **Backend support** for API contracts & WebSocket

## Success Metrics

1. **Time to Identify SLA-at-Risk:** <3 seconds (vs. 30 seconds today)
2. **Time to Verify Auto-Assignments:** <5 minutes (vs. 10+ minutes today)
3. **Time to Manually Reassign:** <30 seconds (vs. 2 minutes today)
4. **Data Freshness:** <5 seconds (vs. 30+ minutes today)
5. **SLA Incidents:** Reduce by 40% (via alerts + color zones)
6. **User NPS:** Improve from 5/10 to 8/10

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| WebSocket failures (F1.2) | Fallback to polling if WS unavailable |
| Large task counts (Kanban) | Implement pagination within columns |
| Real-time performance | Debounce updates, virtualize rows |
| Browser compatibility | Test on Chrome, Firefox, Safari |
| Mobile responsiveness | Phase out desktop-only, add responsive layouts in Phase 4 |

---

**Next:** See Backend Implementation Plan for API contracts and database changes required to support these features.
