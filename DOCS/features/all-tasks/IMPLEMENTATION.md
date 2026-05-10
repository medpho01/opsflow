# All Tasks Feature - Technical & Architectural Specification
**Created for: Manjul (Tech Architect)**  
**Version: 1.1**  
**Date: May 2, 2026 (Dynamic Enum API Endpoints Added)**  
**Based on Product Spec v2.1 by Abhishek**

---

## Executive Summary

This technical specification details the implementation architecture of the "All Tasks" feature in TaskOS. It documents the system design, component hierarchy, database schema, API contracts, and implementation patterns used to build a high-performance, real-time task management system for operations teams.

### Technology Stack
- **Framework**: Next.js 15.0.0 (App Router)
- **Language**: TypeScript 5
- **Database**: PostgreSQL with Prisma 6.19.3
- **Frontend**: React 19.2.4 with Tailwind CSS 4
- **Real-time**: Polling (5-second interval), WebSocket/SSE planned
- **State Management**: React hooks (useState, useCallback, useEffect)
- **Authentication**: JWT-based session management

---

## 1. System Architecture

### 1.1 High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     Browser (React Frontend)                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  AllTasksBoard.tsx (Main Component)                            │
│  ├─ UnifiedFilterBar (Filter UI)                               │
│  ├─ View Toggle (Table/Kanban)                                │
│  ├─ TaskTable / KanbanBoard (Display)                          │
│  ├─ TaskDetailPanel (Right Sidebar)                            │
│  ├─ OrderQuickView (Modal)                                    │
│  └─ StatusDistribution (Widget)                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                            ▼ (HTTP)
┌─────────────────────────────────────────────────────────────────┐
│                  Next.js API Layer (Route Handlers)             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  GET  /api/tasks                   → Fetch tasks with filters  │
│  GET  /api/tasks/filters/schema    → Filter options           │
│  GET  /api/tasks/saved-filters     → User's saved filters    │
│  POST /api/tasks/saved-filters     → Save new filter         │
│  PATCH /api/tasks/{id}             → Update task status      │
│  PATCH /api/tasks/bulk             → Bulk update tasks       │
│  GET  /api/tasks/status-distribution → Status counts         │
│  GET  /api/alerts                  → Fetch notifications      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                            ▼ (SQL)
┌─────────────────────────────────────────────────────────────────┐
│                    PostgreSQL Database                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  tasks (Primary table)                                         │
│  ├─ id, title, status, priority                              │
│  ├─ assignedToId, createdAt, slaDeadline                    │
│  ├─ slaBreachedAt, lastStatusUpdate                         │
│  ├─ assignmentRuleId, assignmentMethod                      │
│  └─ [indices on status, priority, assigneeId, slaDeadline]  │
│                                                                 │
│  users (Agent/admin data)                                      │
│  userSavedFilters (Filter persistence)                         │
│  orders (Order details reference)                              │
│  taskTypes (Task type configuration)                           │
│  assignmentRules (Auto-assignment rules)                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Component Hierarchy

```
AllTasksBoard (Head role page)
├─ useCallback hooks
│  ├─ handleFilterChange
│  ├─ handleViewToggle
│  ├─ handleTaskClick
│  └─ handleRefresh
│
├─ useState hooks
│  ├─ view (table | kanban)
│  ├─ filters (active filter state)
│  ├─ selectedTasks (for bulk actions)
│  ├─ tasks (paginated list)
│  ├─ page (pagination state)
│  ├─ sortBy (current sort field)
│  ├─ sortOrder (asc | desc)
│  ├─ isLoading
│  ├─ lastUpdated (timestamp)
│  └─ selectedTaskId (for detail panel)
│
├─ useEffect hooks
│  ├─ Fetch tasks on filter/sort/page change
│  ├─ Auto-refresh polling (5s interval)
│  ├─ Load filter schema on mount
│  └─ Fetch status distribution on load
│
├─ UnifiedFilterBar
│  ├─ Multi-select filter UI
│  ├─ Save/load filters
│  └─ Filter persistence via localStorage + API
│
├─ ViewToggle (Button group)
│  ├─ Table mode (default)
│  └─ Kanban mode
│
├─ TaskTable (if view === 'table')
│  ├─ Headers (ID, Title, Status, Priority, Assignee, SLA, Aging, Order)
│  ├─ Sortable columns
│  ├─ Checkbox selection
│  └─ Row → Click to open TaskDetailPanel
│
├─ KanbanBoard (if view === 'kanban')
│  ├─ Status columns (6 columns)
│  ├─ Draggable task cards
│  ├─ Drop handler → Update status
│  └─ Column count badges
│
├─ TaskDetailPanel
│  ├─ Header section
│  ├─ Order details
│  ├─ SLADisplay (expanded)
│  ├─ AssignmentAuditTrail
│  ├─ Checklist progress
│  ├─ Notes section
│  └─ Action buttons
│
├─ OrderQuickView (Modal)
│  └─ Order metadata popup
│
├─ StatusDistribution (Widget)
│  └─ Count badges per status
│
├─ EmptyStateMessage
│  └─ Shown when filters return 0 results
│
└─ ManualRefresh (Button)
   └─ Force update + timestamp display
```

### 1.3 Data Flow Diagram

```
User Interaction
    ▼
AllTasksBoard.tsx (State update)
    ├─ Filter change → handleFilterChange() → setState(filters)
    ├─ Sort change → handleSort() → setState(sortBy, sortOrder)
    ├─ Page change → setState(page)
    ├─ View toggle → setState(view)
    └─ Task refresh → setState(isLoading=true)
    ▼
useEffect dependency array triggers
    ▼
API call: GET /api/tasks?filters=...&sort=...&page=...
    ▼
Route Handler: /api/tasks/route.ts
    ├─ Auth check (getSessionFromRequest)
    ├─ Parse query params
    ├─ Build Prisma WHERE clauses
    ├─ Apply role-based scoping
    ├─ Calculate slaContext (timeline)
    ├─ Calculate taskAging (color indicators)
    ├─ Apply sorting with tiebreakers
    ├─ Fetch from DB
    └─ Return JSON response
    ▼
setState(tasks, isLoading=false)
    ▼
React renders updated UI
```

---

## 2. Database Schema & Design

### 2.1 Prisma Schema (Relevant Models)

#### Task Model
```prisma
model Task {
  id                  Int      @id @default(autoincrement())
  title               String
  description         String?
  status              TaskStatus   @default(CREATED)
  priority            Priority     @default(MEDIUM)
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
  
  // SLA Management
  slaMinutes          Int      // Duration in minutes
  slaDeadline         DateTime // Calculated at creation
  slaBreachedAt       DateTime?
  
  // Assignment & Tracking
  assignedToId        Int?
  assignedTo          User?    @relation("TaskAssignee", fields: [assignedToId], references: [id])
  assignedAt          DateTime?
  lastStatusUpdate    DateTime @default(now())
  
  // Rule-based Assignment
  assignmentRuleId    Int?
  assignmentRule      AssignmentRule? @relation(fields: [assignmentRuleId], references: [id])
  assignmentMethod    AssignmentMethod @default(MANUAL) // AUTO | MANUAL
  
  // Relations
  taskTypeId          Int?
  taskType            TaskType? @relation(fields: [taskTypeId], references: [id])
  orderId             Int?
  order               Order?   @relation(fields: [orderId], references: [id])
  storeId             Int?
  store               Store?   @relation(fields: [storeId], references: [id])
  
  // Timeline tracking
  checklist           ChecklistItem[]
  notes               TaskNote[]
  
  // Indices for query performance
  @@index([status])
  @@index([priority])
  @@index([assignedToId])
  @@index([slaDeadline])
  @@index([createdAt])
  @@index([storeId])
}

enum TaskStatus {
  CREATED
  ASSIGNED
  IN_PROGRESS
  BLOCKED
  COMPLETED
  BREACHED
  CANCELLED
}

enum Priority {
  LOW
  MEDIUM
  HIGH
  URGENT
}

enum AssignmentMethod {
  AUTO     // Matched by rule
  MANUAL   // User assigned
}
```

#### UserSavedFilter Model
```prisma
model UserSavedFilter {
  id          Int      @id @default(autoincrement())
  userId      Int
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  filterName  String
  filterJson  Json     // Serialized filter configuration
  
  usageCount  Int      @default(0)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  
  // Unique constraint: one user can't have duplicate filter names
  @@unique([userId, filterName])
  @@index([userId])
  @@index([usageCount(sort: Desc)])
}
```

### 2.2 Query Optimization Strategy

#### Index Strategy
- **status**: Filtered frequently (WHERE status IN [...])
- **priority**: Filtered frequently, used for sorting
- **assignedToId**: Role-based scoping (WHERE assignedToId = userId)
- **slaDeadline**: SLA risk filtering and sorting
- **createdAt**: Tiebreaker sorting and date range filtering
- **storeId**: Store-based visibility (STORE_ADMIN role)

#### Join Strategy
```typescript
// Single query fetch with all relations included
const tasks = await prisma.task.findMany({
  where: {
    // Filter conditions
  },
  select: {
    id: true,
    title: true,
    status: true,
    priority: true,
    createdAt: true,
    slaDeadline: true,
    assignedToId: true,
    assignedTo: {
      select: {
        id: true,
        name: true,
      }
    },
    taskType: {
      select: {
        id: true,
        name: true,
      }
    },
    order: {
      select: {
        id: true,
        orderNumber: true,
        patientName: true,
      }
    },
    // ... other relations
  },
  orderBy: { /* ... */ },
  skip: (page - 1) * pageSize,
  take: pageSize,
});
```

#### Calculated Fields (Not Stored)
- **minutesRemaining**: `(slaDeadline - now()) / 60`
- **breachDuration**: `(now() - slaBreachedAt) / 60`
- **timeInStatus**: `(now() - lastStatusUpdate) / 60`
- **slaRiskLevel**: Logic based on minutesRemaining
- **agingColor**: Logic based on timeInStatus thresholds

### 2.3 Migration Strategy

All schema changes go through Prisma migrations:

```bash
# Create migration
npx prisma migrate dev --name add_feature_name

# Deploy to production
npx prisma migrate deploy

# Rollback (never use reset in prod!)
npx prisma migrate resolve --rolled-back migration_name
```

#### Migration Naming Convention
- `add_*`: Adding new tables/columns
- `update_*`: Modifying existing columns
- `drop_*`: Removing tables/columns
- `index_*`: Adding indices for performance

---

## 3. API Endpoint Specifications

### 3.1 GET /api/tasks

**Purpose**: Fetch paginated task list with advanced filtering, sorting, and SLA context.

**Request Parameters** (Query String):
```typescript
interface GetTasksQuery {
  page?: number;              // 1-indexed (default: 1)
  pageSize?: number;          // 1-50 (default: 25)
  status?: string[];          // Multiple: ?status=CREATED&status=ASSIGNED
  priority?: string[];        // Multiple values
  assigneeId?: number[];      // Multiple user IDs
  dateFrom?: string;          // ISO-8601: 2026-05-01T00:00:00Z
  dateTo?: string;            // ISO-8601: 2026-05-02T23:59:59Z
  orderId?: number;           // Single order ID
  slaRiskOnly?: boolean;      // true = show only warning/critical/breached
  sortBy?: 'createdAt' | 'priority' | 'slaDeadline' | 'status' | 'appointmentTime';
  sortOrder?: 'asc' | 'desc';
}
```

**Response** (HTTP 200):
```typescript
interface GetTasksResponse {
  data: TaskWithContext[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

interface TaskWithContext {
  id: number;
  title: string;
  status: TaskStatus;
  priority: Priority;
  createdAt: string;           // ISO-8601 UTC
  assignedTo: { id: number; name: string } | null;
  
  // SLA Context
  slaContext: {
    slaDeadline: string;       // ISO-8601 UTC
    minutesRemaining: number;
    slaRiskLevel: 'safe' | 'warning' | 'critical' | 'breached';
    slaBreachedAt: string | null;
    breachDuration: number | null;
  };
  
  // Task Aging
  aging: {
    timeInStatus: number;      // Minutes
    colorCode: 'green' | 'yellow' | 'red';
    status: string;            // "45 mins in ASSIGNED"
    isStuck: boolean;          // > 60 mins
  };
  
  // Order Reference
  order: {
    id: number;
    orderNumber: string;
    patientName: string;
  } | null;
  
  assignmentRuleId: number | null;
  assignmentMethod: 'AUTO' | 'MANUAL';
}
```

**Implementation Notes**:
- Applies role-based WHERE scoping (see section 3.8)
- Calculates slaContext in POST logic (not stored in DB)
- Uses Prisma `findMany()` with join on assignedTo, order, taskType
- Applies indices for <300ms response time
- Returns relative time strings formatted for IST timezone

**Error Cases**:
- 401: Unauthorized (user not authenticated)
- 403: Forbidden (user lacks required role)
- 500: Server error (log with [GetTasks] prefix)

---

### 3.2 GET /api/tasks/filters/schema

**Purpose**: Return available filter options for frontend dropdown rendering.

**Request**: No parameters.

**Response** (HTTP 200):
```typescript
interface FilterSchema {
  statuses: string[];         // All 7 status values
  priorities: string[];       // [LOW, MEDIUM, HIGH, URGENT]
  assignees: Array<{
    id: number;
    name: string;
  }>;
  dateRangePresets: Array<{
    label: string;
    value: string;
  }>;
}
```

**Implementation**:
```typescript
// File: src/app/api/tasks/filters/schema/route.ts
const agents = await prisma.user.findMany({
  where: {
    role: UserRole.OPS_AGENT,
    isActive: true,
  },
  select: { id: true, name: true },
  orderBy: { name: "asc" },
});

const schema = {
  statuses: ["CREATED", "ASSIGNED", "IN_PROGRESS", ...],
  priorities: ["LOW", "MEDIUM", "HIGH", "URGENT"],
  assignees: agents,
  dateRangePresets: [
    { label: "Today", value: "today" },
    { label: "This Week", value: "thisWeek" },
    { label: "This Month", value: "thisMonth" },
    { label: "Custom Range", value: "custom" },
  ],
};

return NextResponse.json(schema);
```

---

### 3.3 GET /api/tasks/saved-filters

**Purpose**: Retrieve user's saved filter combinations.

**Request**: No parameters (user inferred from session).

**Response** (HTTP 200):
```typescript
interface SavedFilter {
  id: number;
  filterName: string;
  filterJson: {
    status?: string[];
    priority?: string[];
    assigneeId?: number[];
    dateFrom?: string;
    dateTo?: string;
    slaRiskOnly?: boolean;
  };
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

interface GetSavedFiltersResponse {
  filters: SavedFilter[];
}
```

**Implementation**:
```typescript
const filters = await prisma.userSavedFilter.findMany({
  where: { userId: user.id },
  orderBy: [
    { usageCount: 'desc' },  // Most used first
    { updatedAt: 'desc' },   // Then most recent
  ],
});

return NextResponse.json({ filters });
```

---

### 3.4 POST /api/tasks/saved-filters

**Purpose**: Save a new filter combination for the user.

**Request** (JSON Body):
```typescript
interface SaveFilterRequest {
  filterName: string;
  filters: {
    status?: string[];
    priority?: string[];
    assigneeId?: number[];
    dateFrom?: string;
    dateTo?: string;
    slaRiskOnly?: boolean;
  };
}
```

**Response** (HTTP 201):
```typescript
interface SavedFilter {
  id: number;
  filterName: string;
  // ... (same as GET response)
}
```

**Implementation**:
```typescript
// Check for duplicate name
const existing = await prisma.userSavedFilter.findUnique({
  where: {
    userId_filterName: {
      userId: user.id,
      filterName: req.body.filterName,
    },
  },
});

if (existing) {
  // Update existing
  return prisma.userSavedFilter.update({
    where: { id: existing.id },
    data: {
      filterJson: req.body.filters,
      updatedAt: new Date(),
    },
  });
}

// Create new
return prisma.userSavedFilter.create({
  data: {
    userId: user.id,
    filterName: req.body.filterName,
    filterJson: req.body.filters,
  },
});
```

**Error Cases**:
- 400: Invalid filter name (empty or too long)
- 409: Duplicate filter name (suggest update instead)
- 500: Database error

---

### 3.5 PATCH /api/tasks/{id}

**Purpose**: Update single task (status, notes, assignment).

**Request** (JSON Body):
```typescript
interface UpdateTaskRequest {
  status?: TaskStatus;
  notes?: string;           // Append to notes
  assignedToId?: number;    // Reassign task
  assignmentMethod?: 'AUTO' | 'MANUAL';
}
```

**Response** (HTTP 200):
```typescript
// Returns updated TaskWithContext (same as GET /api/tasks item)
```

**Implementation Pattern**:
```typescript
const task = await prisma.task.update({
  where: { id: taskId },
  data: {
    status: req.body.status,
    lastStatusUpdate: new Date(), // Auto-update
    assignedToId: req.body.assignedToId,
    assignmentMethod: req.body.assignmentMethod,
  },
  // ... include relations
});
```

**Business Logic**:
- Validate status transitions (BLOCKED → IN_PROGRESS only, etc.)
- Track lastStatusUpdate whenever status changes
- Only OPS_HEAD and STORE_ADMIN can reassign (role check)
- Log state changes for audit trail

---

### 3.6 PATCH /api/tasks/bulk

**Purpose**: Update multiple tasks in single API call.

**Request** (JSON Body):
```typescript
interface BulkUpdateRequest {
  taskIds: number[];
  action: 'reassign' | 'cancel' | 'block' | 'unblock';
  assignedToId?: number;  // Required if action='reassign'
}
```

**Response** (HTTP 200):
```typescript
interface BulkUpdateResponse {
  updated: number;
  failed: number;
  details: Array<{
    taskId: number;
    success: boolean;
    error?: string;
  }>;
}
```

**Implementation**:
```typescript
const results = await Promise.all(
  taskIds.map(async (taskId) => {
    try {
      await prisma.task.update({
        where: { id: taskId },
        data: getUpdateDataForAction(action),
      });
      return { taskId, success: true };
    } catch (err) {
      return { taskId, success: false, error: err.message };
    }
  })
);
```

---

### 3.7 GET /api/tasks/status-distribution

**Purpose**: Get count of tasks in each status for status widget.

**Request**: No parameters.

**Response** (HTTP 200):
```typescript
interface StatusDistribution {
  CREATED: number;
  ASSIGNED: number;
  IN_PROGRESS: number;
  BLOCKED: number;
  BREACHED: number;
  COMPLETED: number;
  CANCELLED: number;
  TOTAL: number;
}
```

**Implementation**:
```typescript
const counts = await prisma.task.groupBy({
  by: ['status'],
  _count: true,
  where: {
    // Apply same role-based scoping as GET /api/tasks
  },
});

const distribution = {
  CREATED: counts.find(c => c.status === 'CREATED')?._count ?? 0,
  ASSIGNED: counts.find(c => c.status === 'ASSIGNED')?._count ?? 0,
  // ... other statuses
};
```

---

### 3.8 Role-Based Scoping Strategy

All task-fetching endpoints apply WHERE clauses based on user role:

```typescript
function buildRoleBasedWhere(user: User): Prisma.TaskWhereInput {
  if (user.role === 'OPS_HEAD') {
    // No restrictions
    return {};
  }
  
  if (user.role === 'STORE_ADMIN') {
    // Can only see tasks for assigned stores
    return {
      store: {
        id: { in: user.assignedStoreIds },
      },
    };
  }
  
  if (user.role === 'OPS_AGENT') {
    // Can only see own assigned tasks
    return {
      assignedToId: user.id,
    };
  }
  
  throw new Error('Unknown role');
}
```

---

## 4. Frontend Component Architecture

### 4.1 AllTasksBoard Component

**File**: `src/components/head/AllTasksBoard.tsx`

**Responsibilities**:
- Orchestrate all task display features
- Manage global state (view mode, filters, pagination)
- Handle auto-refresh polling
- Coordinate child component interactions

**State Variables**:
```typescript
const [view, setView] = useState<'table' | 'kanban'>('table');
const [filters, setFilters] = useState<FilterState>({
  status: [],
  priority: [],
  assigneeId: [],
  dateFrom: null,
  dateTo: null,
  slaRiskOnly: false,
  orderId: null,
});
const [tasks, setTasks] = useState<TaskWithContext[]>([]);
const [page, setPage] = useState(1);
const [sortBy, setSortBy] = useState<'priority'>('priority');
const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
const [selectedTasks, setSelectedTasks] = useState<Set<number>>(new Set());
const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
const [isLoading, setIsLoading] = useState(false);
const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
```

**Key Callbacks**:
```typescript
const handleFilterChange = useCallback((newFilters: FilterState) => {
  setFilters(newFilters);
  setPage(1); // Reset to first page
}, []);

const handleSort = useCallback((field: string, order: 'asc' | 'desc') => {
  setSortBy(field);
  setSortOrder(order);
}, []);

const handleRefresh = useCallback(async () => {
  await fetchTasks();
  setLastUpdated(new Date());
}, []);

const fetchTasks = useCallback(async () => {
  setIsLoading(true);
  try {
    const response = await fetch(
      `/api/tasks?${buildQueryString(filters, page, sortBy, sortOrder)}`
    );
    const data = await response.json();
    setTasks(data.data);
  } finally {
    setIsLoading(false);
  }
}, [filters, page, sortBy, sortOrder]);
```

**Auto-Refresh Polling**:
```typescript
useEffect(() => {
  const interval = setInterval(() => {
    fetchTasks(); // Silent refresh every 5 seconds
  }, 5000);
  
  return () => clearInterval(interval);
}, [fetchTasks]);
```

**Renders**:
- UnifiedFilterBar (filter UI)
- View toggle buttons
- TaskTable or KanbanBoard (based on view mode)
- StatusDistribution widget
- TaskDetailPanel (right sidebar, if selectedTaskId)
- OrderQuickView modal (if order selected)

---

### 4.2 UnifiedFilterBar Component

**File**: `src/components/shared/UnifiedFilterBar.tsx`

**Responsibilities**:
- Render multi-select filter checkboxes
- Save/load filter combinations
- Display active filter tags
- Call filter schema endpoint

**Key Features**:
- Checkbox groups for status, priority, assignee
- Toggle for SLA risk only
- Active filter tags with remove buttons (X)
- Save filter dialog (name input + confirm)
- Recent filters sidebar (sorted by usageCount)

**Workflow**:
```
1. Mount → GET /api/tasks/filters/schema → Populate options
2. Mount → GET /api/tasks/saved-filters → Show recent filters
3. User click checkbox → setState(filters) → Emit onChange callback
4. User click "Save" → Modal dialog → POST /api/tasks/saved-filters
5. User click recent filter → Load saved filter → Emit onChange
6. User click X on tag → Remove filter → setState
```

---

### 4.3 KanbanBoard Component

**File**: `src/components/shared/KanbanBoard.tsx`

**Responsibilities**:
- Render six status columns
- Handle drag-and-drop
- Update task status on drop
- Display task card with aging indicator

**HTML5 Drag-Drop Implementation**:
```typescript
const handleDragOver = (e: React.DragEvent) => {
  e.preventDefault(); // Allow drop
  e.dataTransfer.dropEffect = 'move';
};

const handleDrop = (status: TaskStatus) => {
  const taskId = parseInt(e.dataTransfer.getData('taskId'));
  updateTaskStatus(taskId, status);
};

const handleDragStart = (taskId: number) => {
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('taskId', taskId.toString());
};
```

**Optimistic UI Pattern**:
```typescript
// 1. Update local state immediately
const updatedTasks = tasks.map(t =>
  t.id === taskId ? { ...t, status } : t
);
setTasks(updatedTasks);

// 2. Send API request
try {
  await updateTaskStatus(taskId, status);
} catch (error) {
  // 3. Rollback on error
  setTasks(prevTasks); // Revert to previous state
}
```

---

### 4.4 TaskDetailPanel Component

**File**: `src/components/agent/TaskDetailPanel.tsx`

**Responsibilities**:
- Display comprehensive task information
- Show expanded SLA timeline
- Display assignment audit trail
- Provide action buttons for status transitions

**Sections**:
1. **Header**: Task title, status badge, priority badge, SLA countdown
2. **Order Details**: Patient name, lab, phlebotomist, appointment time
3. **SLA Timeline** (Expanded): Visual timeline with created → deadline → breach moments
4. **Assignment Audit Trail**: Rule name, trigger conditions, assignment method, override history
5. **Checklist**: Progress bar with checkbox items
6. **Notes**: Textarea for task notes with save button
7. **Action Buttons**: Start, Complete, Block, Resume, Mark As...

---

### 4.5 Shared Display Components

#### SLADisplay (Component)

**File**: `src/components/shared/SlaCountdown.tsx`

**Modes**:
- **Compact** (used in table/kanban): Shows countdown in remaining minutes
  - "🟢 45m remaining"
  - "🟡 15m remaining"
  - "🔴 CRITICAL - 5m remaining"
  - "🔴 BREACHED 10m ago"

- **Expanded** (used in detail panel): Shows full timeline
  ```
  Created:  May 1, 2026, 3:00 PM IST
  Deadline: May 1, 2026, 5:00 PM IST
  Breached: May 1, 2026, 5:15 PM IST (breach: 15m)
  ```

**Color Mapping**:
```typescript
const getSLAColor = (minutesRemaining: number, isBreached: boolean) => {
  if (isBreached) return 'red';      // BREACHED
  if (minutesRemaining < 10) return 'orange';  // CRITICAL
  if (minutesRemaining < 30) return 'yellow';  // WARNING
  return 'green';                    // SAFE
};
```

#### TaskAgingIndicator (Component)

**File**: `src/components/shared/TaskAgingIndicator.tsx`

**Display Modes**:
- **Compact**: "🟢 12m", "🟡 45m", "🔴 120m"
- **Expanded**: Full status message with warning
  - "⏱️ 12 minutes in ASSIGNED"
  - "⚠️ WARNING: 45 minutes in BLOCKED"
  - "🔴 STUCK: 120 minutes in IN_PROGRESS"

**Color Logic**:
```typescript
function getAgingColor(timeInStatus: number, thresholds: AgingThresholds) {
  if (timeInStatus > thresholds.critical) return 'red';    // > 60 min
  if (timeInStatus > thresholds.warning) return 'yellow';  // 30-45 min
  return 'green';                                           // < 30 min
}
```

#### StatusBadge & PriorityBadge (Components)

**StatusBadge** (Color-coded):
- CREATED → Gray
- ASSIGNED → Blue
- IN_PROGRESS → Purple
- BLOCKED → Orange
- COMPLETED → Green
- BREACHED → Red
- CANCELLED → Red (darker shade)

**PriorityBadge** (Color-coded):
- LOW → Gray
- MEDIUM → Blue
- HIGH → Orange
- URGENT → Red

---

## 5. Filtering & Query Optimization

### 5.1 Query Building Strategy

```typescript
// File: src/app/api/tasks/route.ts

function buildWhereClause(
  filters: FilterRequest,
  roleBasedScoping: Prisma.TaskWhereInput
): Prisma.TaskWhereInput {
  const where: Prisma.TaskWhereInput = {
    AND: [roleBasedScoping],
  };
  
  // Status filter
  if (filters.status?.length > 0) {
    where.AND.push({ status: { in: filters.status } });
  }
  
  // Priority filter
  if (filters.priority?.length > 0) {
    where.AND.push({ priority: { in: filters.priority } });
  }
  
  // Assignee filter
  if (filters.assigneeId?.length > 0) {
    where.AND.push({ assignedToId: { in: filters.assigneeId } });
  }
  
  // Date range filter
  if (filters.dateFrom || filters.dateTo) {
    const dateFilter: Prisma.DateTimeFilter = {};
    if (filters.dateFrom) {
      dateFilter.gte = new Date(filters.dateFrom);
    }
    if (filters.dateTo) {
      dateFilter.lte = new Date(filters.dateTo);
    }
    where.AND.push({ createdAt: dateFilter });
  }
  
  // SLA Risk filter
  if (filters.slaRiskOnly) {
    // Calculated at runtime in POST logic
    // Fetch all and filter in memory
  }
  
  // Order ID filter
  if (filters.orderId) {
    where.AND.push({ orderId: filters.orderId });
  }
  
  return where;
}
```

### 5.2 SLA Risk Filtering

SLA risk cannot be filtered at database level because it's a calculated field. Strategy:

```typescript
// Option 1: Fetch all, filter in memory (for small datasets)
const allTasks = await prisma.task.findMany({ where });
const filteredTasks = allTasks.filter(task => {
  const minutesRemaining = 
    (new Date(task.slaDeadline).getTime() - Date.now()) / 60000;
  return minutesRemaining < 30 || task.slaBreachedAt;
});

// Option 2: SQL query (for large datasets, performance-critical)
// Add computed column at DB level or use raw SQL
```

### 5.3 Sorting Strategy with Tiebreakers

```typescript
type SortField = 'createdAt' | 'priority' | 'slaDeadline' | 'status';

function buildOrderBy(
  sortBy: SortField,
  sortOrder: 'asc' | 'desc'
): Prisma.TaskOrderByWithRelationInput[] {
  const orderByArray: Prisma.TaskOrderByWithRelationInput[] = [];
  
  // Primary sort
  orderByArray.push({ [sortBy]: sortOrder });
  
  // Tiebreakers based on primary sort field
  if (sortBy === 'priority' || sortBy === 'slaDeadline' || sortBy === 'status') {
    orderByArray.push({ priority: 'desc' });    // Higher priority first
    orderByArray.push({ createdAt: 'asc' });    // Older tasks first
  }
  
  if (sortBy === 'createdAt') {
    // No tiebreaker needed
  }
  
  return orderByArray;
}
```

**Tiebreaker Logic**:
- **Primary sort by priority**: Show URGENT before HIGH, then by age (oldest first)
- **Primary sort by SLA deadline**: Most at-risk first, then by priority, then by age
- **Primary sort by status**: Group by status, then by priority within group
- **Primary sort by createdAt**: No tiebreaker needed (unique per task)

---

## 6. Timezone & Timestamp Handling

### 6.1 System Timezone: IST (UTC+5:30)

**Key Principle**: Store UTC in database, convert to IST for display, parse IST from user input.

### 6.2 Implementation Pattern

```typescript
// Database storage (always UTC)
const task = await prisma.task.create({
  data: {
    createdAt: new Date(), // JavaScript Date is UTC by default
    slaDeadline: new Date(Date.now() + slaMinutes * 60000),
  },
});

// API response (UTC ISO-8601)
const response = {
  createdAt: task.createdAt.toISOString(), // "2026-05-01T15:00:00Z"
};

// Frontend display (IST)
const istTime = utcDate.toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
// Result: "1/5/2026, 20:30:00" (IST = UTC + 5:30)

// User input parsing (IST to UTC)
const userInputIST = '2026-05-01 20:30'; // User enters in IST
const offset = 5 * 60 + 30; // IST is UTC+5:30
const utcDate = new Date(
  new Date(userInputIST).getTime() - offset * 60000
);
```

### 6.3 Relative Time Formatting

```typescript
function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  
  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  
  return date.toLocaleDateString('en-IN');
}

// Future times
function formatRelativeTimeFuture(date: Date): string {
  const now = Date.now();
  const diffMs = date.getTime() - now;
  // Similar logic but with "in X mins/hours/days"
}
```

---

## 7. Real-Time Update Mechanisms

### 7.1 Current: Manual Refresh Only

**Implementation** (AllTasksBoard):
```typescript
const handleRefresh = useCallback(async () => {
  setIsRefreshing(true);
  await fetchTasks();
  await fetchStatusDistribution();
  setLastUpdated(new Date());
}, []);

// Renders manual refresh button
<button onClick={handleRefresh} disabled={isRefreshing}>
  🔄 Refresh
</button>
<span>Last updated: {lastUpdatedDisplay}</span>
```

**Characteristics**:
- ✅ User-controlled (no irritating auto-refresh)
- ✅ Zero unnecessary network traffic
- ✅ Clean, simple implementation
- ❌ Latency: User must manually refresh
- ❌ No real-time push updates (yet)

**Status**: Auto-polling removed (May 2, 2026) due to user feedback about constant screen reloads being irritating.

### 7.2 Planned: Server-Sent Events (SSE)

**Endpoint**: `GET /api/events?subscribe=tasks`

```typescript
// Backend implementation
export async function GET(request: NextRequest) {
  const stream = new ReadableStream({
    async start(controller) {
      // Send initial data
      controller.enqueue(
        `data: ${JSON.stringify({ type: 'INITIAL', tasks })}\n\n`
      );
      
      // Subscribe to database changes
      const subscription = taskChangeEmitter.on('update', (task) => {
        controller.enqueue(
          `data: ${JSON.stringify({ type: 'TASK_UPDATED', task })}\n\n`
        );
      });
      
      // Cleanup on close
      request.signal.addEventListener('abort', () => {
        subscription.unsubscribe();
        controller.close();
      });
    },
  });
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
```

**Frontend usage**:
```typescript
const eventSource = new EventSource('/api/events?subscribe=tasks');

eventSource.onmessage = (event) => {
  const { type, task } = JSON.parse(event.data);
  if (type === 'TASK_UPDATED') {
    setTasks(prev => 
      prev.map(t => t.id === task.id ? task : t)
    );
  }
};

eventSource.onerror = () => {
  eventSource.close();
  // Fallback to manual refresh (user clicks button)
};
```

### 7.3 Planned: WebSocket Real-Time Updates

```typescript
// Future: /api/socket endpoint via next-ws or similar
// Bi-directional communication for live updates
```

---

## 8. Error Handling & Recovery

### 8.1 API Error Response Format

```typescript
interface ErrorResponse {
  error: string;
  code: string;
  details?: any;
}

// Examples
{ error: "Unauthorized", code: "UNAUTHORIZED", status: 401 }
{ error: "Forbidden", code: "FORBIDDEN", status: 403 }
{ error: "Failed to fetch filter schema", code: "SCHEMA_FETCH_ERROR", status: 500 }
```

### 8.2 Frontend Error Handling

```typescript
const fetchTasks = async () => {
  try {
    const res = await fetch(`/api/tasks?...`);
    if (res.status === 401) {
      // Redirect to login
      window.location.href = '/login';
    } else if (res.status === 403) {
      // Show permission error
      showError('You do not have access to this resource');
    } else if (!res.ok) {
      // Show generic error
      showError(`Failed to load tasks (${res.status})`);
    } else {
      const data = await res.json();
      setTasks(data.data);
    }
  } catch (err) {
    // Network error
    showError('Network error. Please check your connection.');
    // Keep showing last known state
  }
};
```

### 8.3 Graceful Degradation

| Component | Failure Mode | Fallback |
|-----------|--------------|----------|
| Filter schema API | 500 error | Show basic filters (status, priority) |
| Status distribution | 500 error | Continue showing tasks, hide widget |
| Task fetch | 500 error | Show last known state + error banner |
| Sort fail | Sort error | Fall back to default priority sort |
| Pagination | Invalid page | Return to page 1 |

---

## 9. Performance Optimization Techniques

### 9.1 Database Query Optimization

**Query Execution Plan Analysis**:
```sql
-- Check query execution plan
EXPLAIN ANALYZE
SELECT * FROM tasks
WHERE status = 'IN_PROGRESS' AND slaDeadline < NOW()
ORDER BY priority DESC, createdAt ASC
LIMIT 25 OFFSET 0;
```

**Expected**: <300ms response time with proper indices

### 9.2 Frontend Rendering Optimization

**React.memo for Task Cards**:
```typescript
const TaskCard = React.memo(({ task, onDragStart }) => (
  <div draggable onDragStart={() => onDragStart(task.id)}>
    {task.title}
  </div>
));
```

**useMemo for Computed Values**:
```typescript
const sortedTasks = useMemo(() => {
  return [...tasks].sort(getSortFunction(sortBy, sortOrder));
}, [tasks, sortBy, sortOrder]);
```

### 9.3 Network Optimization

**Request Compression**:
- Enable gzip in Next.js (automatic)
- Minimize query parameters

**Response Caching**:
- Filter schema: Cache on client (5-minute TTL)
- Status distribution: Fetch every 10 seconds
- Tasks: Poll every 5 seconds

### 9.4 Pagination Strategy

```typescript
// Default: 25 tasks/page
// Max: 50 tasks/page
// Prevents loading 1000+ tasks at once

const pageSize = Math.min(Math.max(req.query.pageSize || 25, 1), 50);
const offset = (page - 1) * pageSize;
```

---

## 10. Code Patterns & Conventions

### 10.1 API Route Naming Convention

```
src/app/api/
├─ tasks/
│  ├─ route.ts              [GET] /api/tasks
│  ├─ bulk/route.ts         [PATCH] /api/tasks/bulk
│  ├─ filters/
│  │  ├─ schema/route.ts    [GET] /api/tasks/filters/schema
│  │  └─ saved/route.ts     [GET] /api/tasks/saved-filters
│  └─ status-distribution/
│     └─ route.ts           [GET] /api/tasks/status-distribution
├─ alerts/
│  └─ route.ts              [GET] /api/alerts
└─ events/
   └─ route.ts              [GET] /api/events (SSE, planned)
```

### 10.2 Component File Structure

```
src/components/
├─ head/
│  └─ AllTasksBoard.tsx             (Main component, Head role)
├─ agent/
│  ├─ AgentTaskBoard.tsx            (Agent role view)
│  └─ TaskDetailPanel.tsx           (Detailed view)
└─ shared/
   ├─ UnifiedFilterBar.tsx          (Filter UI)
   ├─ KanbanBoard.tsx               (Kanban view)
   ├─ TaskAgingIndicator.tsx        (Aging display)
   ├─ SlaCountdown.tsx              (SLA display)
   ├─ StatusBadge.tsx               (Status badge)
   ├─ PriorityBadge.tsx             (Priority badge)
   ├─ AssignmentAuditTrail.tsx      (Audit trail)
   ├─ EmptyStateMessage.tsx         (Empty results)
   └─ OrderQuickView.tsx            (Order modal)
```

### 10.3 State Management Pattern

**Lifting state up for coordination**:
```typescript
// AllTasksBoard holds global state
const [tasks, setTasks] = useState([]);
const [filters, setFilters] = useState({});

// Pass down as props
<UnifiedFilterBar filters={filters} onChange={handleFilterChange} />
<TaskTable tasks={tasks} />

// Child components call parent callbacks on user action
<button onClick={() => onChange(newFilters)} />
```

### 10.4 Async Data Fetching Pattern

```typescript
const fetchData = useCallback(async () => {
  setIsLoading(true);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setState(data);
  } catch (error) {
    setError(error.message);
  } finally {
    setIsLoading(false);
  }
}, [dependencies]);

useEffect(() => {
  fetchData();
}, [fetchData]);
```

---

## 11. Dynamic Enum API Endpoints

### 11.1 GET /api/order-types

**Purpose**: Fetch all valid OrderType enum values from the database.

**Request**: No parameters.

**Response** (HTTP 200):
```typescript
interface GetOrderTypesResponse {
  orderTypes: string[];
  count: number;
}

// Example:
{
  "orderTypes": ["CAMP", "CENTER_VISIT", "HOME_SAMPLE", "KIT_BASED"],
  "count": 4
}
```

**Implementation**:
```typescript
// File: src/app/api/order-types/route.ts
import { NextResponse } from "next/server";
import { getOrderTypesFromDB } from "@/lib/db/enums";

export async function GET() {
  try {
    const orderTypes = await getOrderTypesFromDB();
    return NextResponse.json(
      { orderTypes, count: orderTypes.length },
      { status: 200 }
    );
  } catch (error) {
    console.error("Failed to fetch order types:", error);
    return NextResponse.json(
      { error: "Failed to fetch order types" },
      { status: 500 }
    );
  }
}
```

**Database Query** (`src/lib/db/enums.ts`):
```typescript
export async function getOrderTypesFromDB(): Promise<string[]> {
  try {
    const result = await prisma.$queryRawUnsafe(
      `SELECT enumlabel FROM pg_enum 
       WHERE enumtypid = 'public."OrderType"'::regtype 
       ORDER BY enumsortorder`
    );

    return (result as Array<{ enumlabel: string }>)
      .map((row) => row.enumlabel)
      .sort();
  } catch (error) {
    console.error("Failed to fetch OrderType values from database:", error);
    throw error;
  }
}
```

**Key Details**:
- Queries PostgreSQL system catalog (`pg_enum` table)
- Sorts results alphabetically for consistent ordering
- Returns empty array if enum not found (graceful fallback)
- Response time: <50ms for typical enum sizes

---

### 11.2 GET /api/order-statuses

**Purpose**: Fetch all valid OrderStatus enum values from the database.

**Request**: No parameters.

**Response** (HTTP 200):
```typescript
interface GetOrderStatusesResponse {
  statuses: string[];
  count: number;
  description: string;
}

// Example:
{
  "statuses": [
    "CANCELED", "CREATED", "KIT_DISPATCHED", "ORDER_SCHEDULED",
    "PATIENT_MISSED", "PATIENT_VISITED", "PENDING", "PHLEBO_ASSIGNED",
    "REPORT_DELIVERED", "RESCHEDULED", "SAMPLE_COLLECTED",
    "SAMPLE_DELIVERED", "SAMPLE_PROCESSED"
  ],
  "count": 13,
  "description": "All valid Labstack order statuses for task rule triggers"
}
```

**Implementation**:
```typescript
// File: src/app/api/order-statuses/route.ts
import { NextResponse } from "next/server";
import { getOrderStatusesFromDB } from "@/lib/db/enums";

export async function GET() {
  try {
    const statuses = await getOrderStatusesFromDB();
    return NextResponse.json(
      {
        statuses,
        count: statuses.length,
        description: "All valid Labstack order statuses for task rule triggers",
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Failed to fetch order statuses:", error);
    return NextResponse.json(
      { error: "Failed to fetch order statuses" },
      { status: 500 }
    );
  }
}
```

**Database Query** (`src/lib/db/enums.ts`):
```typescript
export async function getOrderStatusesFromDB(): Promise<string[]> {
  try {
    const result = await prisma.$queryRawUnsafe(
      `SELECT enumlabel FROM pg_enum 
       WHERE enumtypid = 'public."OrderStatus"'::regtype 
       ORDER BY enumsortorder`
    );

    return (result as Array<{ enumlabel: string }>)
      .map((row) => row.enumlabel)
      .sort();
  } catch (error) {
    console.error("Failed to fetch OrderStatus values from database:", error);
    throw error;
  }
}
```

**Key Details**:
- Queries PostgreSQL system catalog for OrderStatus enum
- Returns 13 order statuses (as of May 2, 2026)
- Includes helpful description for API consumers
- Response time: <50ms

---

### 11.3 Integration with Components

**TaskRulesPanel.tsx**:
```typescript
// Fetch both endpoints on component mount
const [orderTypes, setOrderTypes] = useState<string[]>([]);
const [orderStatuses, setOrderStatuses] = useState<string[]>([]);

useEffect(() => {
  const fetchEnums = async () => {
    const [typesRes, statusesRes] = await Promise.all([
      fetch("/api/order-types"),
      fetch("/api/order-statuses"),
    ]);

    if (typesRes.ok) {
      const data = await typesRes.json();
      setOrderTypes(data.orderTypes);
    }

    if (statusesRes.ok) {
      const data = await statusesRes.json();
      setOrderStatuses(data.statuses);
    }
  };

  fetchEnums();
}, []);
```

**Component Usage**:
```typescript
// Order Type Selector Dropdown
<select value={selectedOrderType} onChange={(e) => setSelectedOrderType(e.target.value)}>
  {orderTypes.map(type => (
    <option key={type} value={type}>{type}</option>
  ))}
</select>

// Order Status Checkboxes
{orderStatuses.map(status => (
  <label key={status}>
    <input
      type="checkbox"
      checked={selectedStatuses.includes(status)}
      onChange={() => toggleStatus(status)}
    />
    {status}
  </label>
))}
```

---

### 11.4 Error Handling

**Scenarios**:
1. Database connection fails → 500 error with message
2. Enum type not found → Returns empty array (graceful)
3. Permission error → 403 Forbidden (if auth added later)

**Frontend Handling**:
```typescript
try {
  const res = await fetch("/api/order-types");
  if (!res.ok) {
    console.error("Failed to fetch order types");
    setOrderTypes([]); // Empty array for graceful fallback
  } else {
    const data = await res.json();
    setOrderTypes(data.orderTypes);
  }
} catch (err) {
  console.error("Network error:", err);
  // Continue with empty state
}
```

---

### 11.5 Performance Characteristics

| Metric | Value |
|--------|-------|
| Response Time | <50ms (direct DB query) |
| Payload Size | ~200 bytes (typical) |
| Caching Strategy | Client-side per session |
| Database Load | Minimal (system catalog query) |
| Scalability | Linear with enum count |

**Optimization Notes**:
- Queries only system catalog (fast)
- No JOINs required
- Results sorted in memory (not DB)
- No pagination needed (enum count typically <20)

---

## 12. Integration Points

### 11.1 External System Dependencies

```
┌─ Order Management System
│  ├─ Fetch order details: GET /api/orders/{orderId}
│  ├─ Verify order status
│  └─ Get patient information
│
├─ Roster/Agent System
│  ├─ List active agents: GET /api/users?role=OPS_AGENT
│  ├─ Check agent availability
│  └─ Get agent schedules
│
├─ Notification System
│  ├─ Send SLA breach alerts
│  ├─ Notify task assignment
│  └─ Alert on task state change
│
├─ Analytics System
│  ├─ Track task completion rate
│  ├─ Monitor SLA adherence
│  └─ Analyze workload distribution
│
└─ Store/Location System
   ├─ Verify store IDs
   └─ Get store details (name, location)
```

### 11.2 Database Triggers (Planned)

```sql
-- Trigger: Update lastStatusUpdate when status changes
CREATE TRIGGER update_last_status_update
AFTER UPDATE OF status ON tasks
FOR EACH ROW
BEGIN
  UPDATE tasks
  SET lastStatusUpdate = NOW()
  WHERE id = NEW.id AND NEW.status != OLD.status;
END;

-- Trigger: Auto-calculate slaBreachedAt when deadline passes
CREATE TRIGGER check_sla_breach
AFTER UPDATE OF slaDeadline ON tasks
FOR EACH ROW
BEGIN
  IF NEW.slaDeadline < NOW() AND OLD.status != 'BREACHED' THEN
    UPDATE tasks
    SET status = 'BREACHED', slaBreachedAt = NOW()
    WHERE id = NEW.id;
  END IF;
END;
```

---

## 13. Testing Strategy

### 13.1 Unit Tests (Mani's QA Spec)

**Test Categories**:
- Filter logic (status, priority, date range combinations)
- SLA calculations (minutesRemaining, riskLevel)
- Task aging calculations (color coding, stuck detection)
- Timezone conversions (UTC ↔ IST)
- Role-based scoping (OPS_AGENT vs STORE_ADMIN vs OPS_HEAD)
- Sort order with tiebreakers

**Example Test**:
```typescript
describe('SLA Risk Calculation', () => {
  it('should return "safe" when >30 mins remaining', () => {
    const deadline = new Date(Date.now() + 45 * 60000);
    const risk = calculateSLARisk(deadline);
    expect(risk).toBe('safe');
  });
  
  it('should return "critical" when <10 mins remaining', () => {
    const deadline = new Date(Date.now() + 5 * 60000);
    const risk = calculateSLARisk(deadline);
    expect(risk).toBe('critical');
  });
});
```

### 13.2 Integration Tests

- Filter combinations returning correct result counts
- API endpoint authorization checks
- Bulk action updates affecting correct tasks
- Saved filter persistence across sessions

### 13.3 E2E Tests (Mani's QA Spec)

**User Workflows**:
1. User logs in → Sees All Tasks board → Default view is table
2. User applies filter → Results update → Filter tags shown
3. User saves filter → Name dialog → Filter saved and shown in sidebar
4. User clicks task → Detail panel opens → Shows full task info
5. User drags task in Kanban → Status updates → Card moves to new column
6. User selects multiple tasks → Bulk action dropdown appears → Can reassign

---

## 14. Deployment & Operations

### 14.1 Environment Variables

```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/taskos

# JWT
JWT_SECRET=your_secret_key_here
SESSION_SECRET=your_session_secret

# External APIs
ORDER_SERVICE_URL=https://order-api.internal
NOTIFICATION_SERVICE_URL=https://notification-api.internal

# Feature Flags
ENABLE_SSE=false          # Enable Server-Sent Events (planned)
ENABLE_WEBSOCKET=false    # Enable WebSocket (planned)
```

### 14.2 Database Migration Workflow

```bash
# Development: Create and test migration
npx prisma migrate dev --name add_feature

# Staging: Deploy migration
npx prisma migrate deploy

# Production: Deploy with backup
# 1. Backup database
# 2. Run: npx prisma migrate deploy
# 3. Verify: SELECT COUNT(*) FROM tasks;
```

### 14.3 Performance Monitoring

**Metrics to Track**:
- API response times (target: <300ms)
- Database query times (target: <100ms)
- Manual refresh request frequency
- Memory usage on browser (prevent leaks)
- Error rates per endpoint

**Tools**:
- Next.js analytics (built-in)
- PostgreSQL slow query log
- Browser DevTools performance tab
- Sentry for error tracking

---

## 15. Future Enhancements & Roadmap

### Phase 4: Real-Time Updates
- [ ] Implement Server-Sent Events (SSE) or WebSocket
- [ ] Replace manual refresh with automatic push updates
- [ ] Reduce latency from manual refresh to <1s push notifications

### Phase 5: Advanced Analytics
- [ ] Task aging trends dashboard
- [ ] SLA adherence metrics
- [ ] Workload distribution reports
- [ ] Agent performance analytics

### Phase 6: AI-Powered Features
- [ ] Assignment optimization algorithm
- [ ] Predictive SLA breach alerts
- [ ] Auto-escalation for stuck tasks
- [ ] Intelligent task routing

### Phase 7: Mobile & Offline
- [ ] Progressive Web App (PWA)
- [ ] Offline task viewing
- [ ] Mobile-optimized UI
- [ ] Push notifications

---

## 16. Appendix

### 16.1 Complete API Request/Response Example

**Request**: Get tasks with filtering and sorting
```
GET /api/tasks?status=IN_PROGRESS&status=BLOCKED&priority=HIGH&priority=URGENT&sortBy=slaDeadline&sortOrder=asc&page=1&pageSize=25
Host: localhost:3000
Authorization: Bearer <jwt_token>
```

**Response**:
```json
{
  "data": [
    {
      "id": 1,
      "title": "Confirm blood sample collected",
      "status": "IN_PROGRESS",
      "priority": "URGENT",
      "createdAt": "2026-05-01T15:00:00Z",
      "assignedTo": {
        "id": 5,
        "name": "Mayur"
      },
      "slaContext": {
        "slaDeadline": "2026-05-01T17:00:00Z",
        "minutesRemaining": 5,
        "slaRiskLevel": "critical",
        "slaBreachedAt": null,
        "breachDuration": null
      },
      "aging": {
        "timeInStatus": 45,
        "colorCode": "red",
        "status": "45 minutes in IN_PROGRESS",
        "isStuck": false
      },
      "order": {
        "id": 46251,
        "orderNumber": "ORD-46251",
        "patientName": "John Doe"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 25,
    "total": 178,
    "totalPages": 8
  }
}
```

### 16.2 Database Index Creation

```sql
-- Indices for query performance
CREATE INDEX idx_task_status ON tasks(status);
CREATE INDEX idx_task_priority ON tasks(priority);
CREATE INDEX idx_task_assigned_to ON tasks(assigned_to_id);
CREATE INDEX idx_task_sla_deadline ON tasks(sla_deadline);
CREATE INDEX idx_task_created_at ON tasks(created_at);
CREATE INDEX idx_task_store_id ON tasks(store_id);

-- Composite indices for common filter combinations
CREATE INDEX idx_task_status_priority ON tasks(status, priority DESC);
CREATE INDEX idx_task_sla_created ON tasks(sla_deadline, created_at);

-- User saved filters indices
CREATE INDEX idx_user_saved_filter_user_id ON user_saved_filters(user_id);
CREATE INDEX idx_user_saved_filter_usage ON user_saved_filters(usage_count DESC);
```

### 16.3 Environment Setup for Local Development

```bash
# Clone repo
git clone <repo>
cd TaskOs

# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Edit .env with local database URL

# Database setup
npx prisma generate
npx prisma migrate dev
npx prisma db seed

# Start development server
npm run dev
# Server runs on http://localhost:3000

# Seed test data (optional)
npm run db:seed
```

---

**Document Version History**:
- v1.0 (May 2, 2026): Initial technical specification, comprehensive architecture documentation
