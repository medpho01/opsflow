# Phase 2 & 3 Implementation Plan

## Status: DETAILED PLANNING

Comprehensive implementation strategy for Phase 2 (Usability) and Phase 3 (Intelligence) features.

---

# PHASE 2: USABILITY (Weeks 3-5) — Core Improvements

## Overview
Phase 2 adds core usability improvements that make the interface intuitive and context-aware.

**Timeline:** 3-5 sprints | **Effort:** 10-20 engineer-days
**Team:** 1 PM + 2 Engineers (1 backend, 1 frontend)

---

## Feature 6: Unified Filter Bar

### Problem Statement
Filters scattered across header (Status, Priority, Sort), difficult to discover and combine. Users can't apply multiple filters simultaneously.

### Requirements
- **Single filter bar** showing all available filters
- **Active filters displayed as removable tags**
- **Save favorite filter combinations** for repeated workflows
- **Clear all filters** button
- **Sticky position** (stays visible when scrolling)

### Backend Changes

#### A. New API Endpoint: `/api/tasks/filters/schema`
Returns available filter options for UI to render dropdowns.

```typescript
GET /api/tasks/filters/schema
Response: {
  statuses: ["CREATED", "ASSIGNED", "IN_PROGRESS", "BLOCKED", "BREACHED", "COMPLETED", "CANCELLED"],
  priorities: ["LOW", "MEDIUM", "HIGH", "URGENT"],
  assignees: [
    { id: 1, name: "John Doe", avatar: "...", isActive: true },
    { id: 2, name: "Sarah Johnson", avatar: "...", isActive: true }
  ],
  dateRangePresets: [
    { label: "Today", value: "today" },
    { label: "This Week", value: "thisWeek" },
    { label: "This Month", value: "thisMonth" },
    { label: "Custom Range", value: "custom" }
  ]
}
```

#### B. Modify: `/api/tasks`
Add new query parameters for advanced filtering:

```
GET /api/tasks?
  status=CREATED,ASSIGNED&
  priority=HIGH,URGENT&
  assigneeId=1,2&
  dateFrom=2026-05-01&
  dateTo=2026-05-05&
  slaRiskOnly=true&
  page=1&limit=25

New response fields:
- `appliedFilters`: { status: [...], priority: [...], ... }
- `availableFilters`: { statuses: [...], ... }
- `filterCount`: 4 (number of active filters)
```

#### C. New Endpoint: `/api/tasks/saved-filters`
Save/retrieve favorite filter combinations (requires authentication).

```typescript
// Get saved filters
GET /api/tasks/saved-filters
Response: [
  { id: "filter_1", name: "Urgent Unassigned", filters: {...}, createdAt: "...", usage: 42 },
  { id: "filter_2", name: "My Assigned Tasks", filters: {...}, createdAt: "...", usage: 156 }
]

// Create saved filter
POST /api/tasks/saved-filters
Body: { name: "High Priority Due Soon", filters: {...} }

// Delete saved filter
DELETE /api/tasks/saved-filters/{filterId}
```

### Frontend Changes

#### A. New Component: `UnifiedFilterBar.tsx`
```typescript
<UnifiedFilterBar
  appliedFilters={filters}
  onFilterChange={(filters) => setFilters(filters)}
  onClearAll={() => clearAllFilters()}
  onSaveFilter={(name) => saveCombination(name)}
  savedFilters={savedFilters}
/>
```

Structure:
- Filter button: "Filters" dropdown (shows Status, Priority, Assignee, Date Range, SLA Risk)
- Active filter tags with X to remove
- "Clear all" button (visible only if filters applied)
- "Save this combination" button (shows name input)
- Recent filters sidebar (quick access)

#### B. Modify: `AllTasksBoard.tsx`
- Remove scattered filter controls
- Integrate `UnifiedFilterBar` at top
- Show filter count badge ("4 active filters")
- Preserve filter state in URL params for sharing

### Database Changes
- Add `user_saved_filters` table (userId, filterName, filterJson, createdAt, usage)
- Index on userId for fast lookup

### Testing Checklist
- [ ] Filter bar renders all available options
- [ ] Multiple filters can be applied simultaneously
- [ ] Filter tags show correctly and remove on X click
- [ ] "Clear all" removes all filters
- [ ] Saved filter persists across sessions
- [ ] URL params update when filters change
- [ ] Performance: Adding/removing 5 filters < 500ms
- [ ] Empty state: Show helpful message when no results
- [ ] Mobile: Filter bar responsive on tablet/phone

---

## Feature 7: Better SLA Display

### Problem Statement
Users see only remaining time ("2h 15m"). They don't understand: Was SLA 30 mins or 2 hours? Did this breach quickly or after delay?

### Requirements
- **Show SLA timeline:** "Created 45 mins ago | SLA: 30 mins | Breached 15 mins ago"
- **Hover tooltip:** Full timeline visualization
- **Status indicator:** Red (breached), Amber (at risk), Green (safe)
- **Contextual info:** Help ops understand root cause

### Backend Changes

#### A. Modify: `/api/tasks` Response
Add SLA context fields to each task:

```typescript
{
  id: 1,
  title: "...",
  slaDeadline: "2026-05-01T16:30:00Z",
  slaStatus: "critical",      // safe, warning, critical, breached
  
  // NEW FIELDS
  slaContext: {
    createdAt: "2026-05-01T15:45:00Z",
    slaMinutes: 30,
    minutesRemaining: -15,     // negative = overdue
    breachedAt: "2026-05-01T16:45:00Z",
    breachedSince: 15,         // minutes overdue
    
    // Timeline data for visualization
    timeline: {
      created: { label: "Created", time: "15:45", relativeTime: "45m ago" },
      deadline: { label: "SLA Deadline", time: "16:15", relativeTime: "35m ago" },
      breached: { label: "Breached", time: "16:15", relativeTime: "35m ago" }
    }
  },
  
  // ... other fields
}
```

### Frontend Changes

#### A. New Component: `SLADisplay.tsx`
```typescript
<SLADisplay 
  slaContext={task.slaContext}
  status={task.status}
/>
```

Display modes:
1. **Compact (in table row):** "Created 45m ago | SLA: 30m | Breached 15m ago"
2. **Hover tooltip:** Timeline visualization with CSS timeline or ASCII art
3. **Detail panel:** Full timeline with color coding

#### B. Color Coding
- Green: > 30 mins remaining
- Amber/Yellow: 10-30 mins remaining
- Orange/Red: < 10 mins remaining
- Dark Red: Breached

### Testing Checklist
- [ ] SLA context correctly calculated for all tasks
- [ ] Timeline shows correct times (created, deadline, breached)
- [ ] Hover tooltip appears and displays correctly
- [ ] Color coding matches remaining time
- [ ] Breached tasks show "overdue" instead of remaining time
- [ ] Timeline is readable and unambiguous
- [ ] Performance: SLA context calculation < 50ms per task

---

## Feature 8: Task Detail Side Panel

### Problem Statement
Click order ID opens modal (loses context of task list). Users need deep-dive without leaving main view.

### Requirements
- **Slide-in panel on right side** (non-destructive)
- **Shows full task details:** title, type, priority, status, SLA timeline
- **Order summary:** order ID, customer, appointment time, patient info
- **Task history:** status changes, notes, who touched it
- **Checklist items** (if applicable)
- **Quick actions:** reassign, mark blocked, complete
- **Can scroll task list while panel open**
- **Close with X or Escape key**

### Frontend Changes

#### A. New Component: `TaskDetailPanel.tsx`
```typescript
<TaskDetailPanel 
  task={selectedTask}
  isOpen={panelOpen}
  onClose={() => setPanelOpen(false)}
  onUpdate={() => refetchTasks()}
/>
```

Structure:
```
┌─────────────────────────────────────────┐
│ Task #1053: Confirm Booking        [×] │
├─────────────────────────────────────────┤
│ Status: ASSIGNED | Priority: MEDIUM      │
├─────────────────────────────────────────┤
│ ORDER SUMMARY                            │
│ Order #46251 | Appointment 2:30 PM      │
│ Patient: Siddhant | Store: Downtown     │
├─────────────────────────────────────────┤
│ SLA TIMELINE                             │
│ Created: 45m ago | Deadline: 30m | ...  │
├─────────────────────────────────────────┤
│ CHECKLIST (3/5 items)                    │
│ ✓ Step 1  ✓ Step 2  ○ Step 3  ○ Step 4  │
├─────────────────────────────────────────┤
│ TASK HISTORY                             │
│ 2:00 PM: Status changed to ASSIGNED      │
│ 1:55 PM: Assigned to John (auto)         │
│ 1:50 PM: Created                         │
├─────────────────────────────────────────┤
│ NOTES                                    │
│ [Recent notes from agents...]            │
├─────────────────────────────────────────┤
│ [Reassign] [Block] [Complete] [More...] │
└─────────────────────────────────────────┘
```

#### B. Modify: `AllTasksBoard.tsx`
- Click task row → open panel
- Keep task list visible on left
- Panel width: ~35-40% on desktop, full width on mobile
- Smooth slide-in animation

#### C. New Endpoint: `/api/tasks/{id}/details`
Returns comprehensive task data for panel:

```typescript
GET /api/tasks/1053
Response: {
  id: 1053,
  title: "Confirm Booking",
  status: "ASSIGNED",
  priority: "MEDIUM",
  slaContext: {...},
  
  // Order summary
  order: {
    id: 46251,
    status: "PHLEBO_ASSIGNED",
    appointmentTime: "...",
    patientName: "Siddhant",
    storeName: "Downtown Lab"
  },
  
  // Checklist
  checklistItems: [
    { id: 1, stepOrder: 1, stepText: "...", isDone: true, doneAt: "..." },
    ...
  ],
  
  // History
  history: [
    { id: 1, status: "ASSIGNED", changedAt: "...", changedBy: "...", note: "..." },
    ...
  ],
  
  // Notes
  notes: [
    { id: 1, author: "John", text: "...", createdAt: "..." },
    ...
  ]
}
```

### Testing Checklist
- [ ] Panel opens on task row click
- [ ] Panel closes on X button click
- [ ] Panel closes on Escape key
- [ ] Task list remains visible and scrollable while panel open
- [ ] Panel shows all required information
- [ ] Actions (reassign, block, complete) work from panel
- [ ] Panel reflows properly on mobile (full width)
- [ ] History displays in chronological order
- [ ] Checklist items show correctly
- [ ] Performance: Panel data load < 200ms

---

## Feature 9: Improved Empty State

### Problem Statement
"No tasks match your filters" doesn't help user recover from overly-specific filters.

### Requirements
- **Helpful message** explaining what happened
- **Show total task count** for context
- **Suggest recovery options:** Clear filters, adjust date range
- **Common actions:** View all tasks, Create new task
- **Filter tags** as clickable remove buttons

### Frontend Changes

#### A. New Component: `EmptyStateMessage.tsx`
```typescript
<EmptyStateMessage
  filterCount={4}
  totalTasks={23}
  appliedFilters={filters}
  onClearFilters={clearAll}
  onRemoveFilter={removeFilter}
/>
```

Template:
```
╔════════════════════════════════════════╗
║  🔍 No tasks match your filters        ║
║                                        ║
║  You have 23 total tasks.              ║
║                                        ║
║  Active Filters:                       ║
║  [Status: URGENT ✕] [Assignee: John ✕]║
║                                        ║
║  Try:                                  ║
║  [Clear All Filters]                   ║
║  [Show All Statuses]                   ║
║  [Adjust Date Range]                   ║
║                                        ║
║  Or create new:                        ║
║  [+ New Task]                          ║
╚════════════════════════════════════════╝
```

### Testing Checklist
- [ ] Empty state appears when no results
- [ ] Filter tags show correct applied filters
- [ ] Total task count is accurate
- [ ] "Clear All" removes all filters and shows tasks
- [ ] Individual filter tags can be removed
- [ ] Links to recovery actions work
- [ ] Helpful tone/UX copy is clear

---

## Feature 10: Assignment Rule Audit Trail

### Problem Statement
Ops can't see which rule triggered assignment or if manual override occurred. Can't verify rule-based assignments are working.

### Requirements
- **Show which rule assigned task:** "Auto-assigned by R2: Phlebotomy"
- **Assignment timestamp:** "Assigned 5 mins ago (automatic)"
- **Exception alerts:** "⚠ No rule matched, manual override required"
- **Full audit trail:** Rule evaluation → match → assignment
- **Accessible in task detail panel**

### Backend Changes

#### A. Modify: Task Model & `/api/tasks` Response
Add assignment audit fields:

```typescript
{
  id: 1053,
  title: "...",
  
  // Assignment audit
  assignmentAudit: {
    method: "auto" | "manual",
    ruleId: "hsc_r2_assign_phlebo",
    ruleName: "HSC: Assign Phlebotomist",
    ruleType: "STATUS",
    ruleTriggerCondition: { statusIn: ["ORDER_SCHEDULED", "PHLEBO_ASSIGNED"] },
    evaluatedAt: "2026-05-01T15:45:00Z",
    matchResult: "matched" | "no_match",
    reasonForManual: "Rule evaluation failed, no eligible agents" | null,
    overriddenBy: { id: 1, name: "Sarah" } | null,
    overriddenAt: "..." | null
  },
  
  // ... other fields
}
```

#### B. Modify: `createTask()` in taskCreator.ts
Track which rule matched and store assignment audit info:

```typescript
// When a task is created by a rule match:
const task = await prisma.task.create({
  data: {
    // ... existing fields
    assignmentMethod: "auto",
    assignmentRuleId: rule.id,
    
    // New: store audit info
    metadata: {
      ...metadata,
      assignmentAudit: {
        ruleName: rule.name,
        ruleType: rule.triggerType,
        evaluatedAt: new Date(),
        condition: rule.triggerCondition
      }
    }
  }
});
```

### Frontend Changes

#### A. New Component: `AssignmentAuditTrail.tsx`
Display in task detail panel:

```typescript
<AssignmentAuditTrail
  audit={task.assignmentAudit}
  currentAssignee={task.assignedTo}
/>
```

Display format:
```
ASSIGNMENT AUDIT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Initial Assignment:
  ✓ R2 (Phlebotomy) evaluated
  ✓ Condition matched: ORDER_SCHEDULED status
  ✓ Assigned to: John Doe (automatic)
  Time: 2026-05-01 15:45 (5 mins ago)

Later Changes:
  ⚠ Manual reassignment: Sarah → Mike
  Reason: "Agent unavailable"
  Time: 2026-05-01 15:50
```

### Testing Checklist
- [ ] Assignment audit shows correct rule name and ID
- [ ] Timestamp shows when task was assigned
- [ ] "auto" vs "manual" is clear
- [ ] Condition display is readable
- [ ] Manual overrides show who changed it and when
- [ ] Reason for manual override is captured
- [ ] Audit trail updates when task is reassigned
- [ ] Performs correctly even with multiple reassignments

---

# PHASE 3: INTELLIGENCE (Weeks 6-10) — Advanced Features

## Overview
Phase 3 adds visual intelligence and real-time awareness to the platform.

**Timeline:** 5 sprints | **Effort:** 12-30 engineer-days
**Team:** 1 PM + 2 Engineers (1 backend, 1 frontend) + 1 DevOps (WebSocket setup)

---

## Feature 11: Kanban / Grouping View

### Problem Statement
Table view is linear; ops need visual workflow representation. Can't see task flow across statuses at a glance.

### Requirements
- **Toggle between Table and Kanban views** (top-right)
- **Kanban columns:** CREATED | ASSIGNED | IN_PROGRESS | BLOCKED | COMPLETED | CANCELLED
- **Drag card between columns** to update status
- **Count badges per column** showing task volume
- **Filters and sorts** work across both views
- **Visual urgency indicators** (color coding) in Kanban cards too

### Frontend Changes

#### A. New Component: `KanbanBoard.tsx`
```typescript
<KanbanBoard
  tasks={tasks}
  onStatusChange={(taskId, newStatus) => updateTask(taskId, newStatus)}
  colorZone={(task) => getUrgencyColor(task)}
/>
```

Structure:
```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│  CREATED     │ ASSIGNED     │ IN_PROGRESS  │ BLOCKED      │
│      (5)     │      (12)    │      (3)     │      (0)     │
├──────────────┼──────────────┼──────────────┼──────────────┤
│ ┌──────────┐ │ ┌──────────┐ │ ┌──────────┐ │              │
│ │ Task123  │ │ │ Task456  │ │ │ Task789  │ │              │
│ │ HIGH     │ │ │ MEDIUM   │ │ │ URGENT   │ │              │
│ │ 2h 15m   │ │ │ 30m 12s  │ │ │ +5m      │ │              │
│ └──────────┘ │ │ (red bg) │ │ (red bg) │ │              │
│              │ └──────────┘ │ └──────────┘ │              │
│ ┌──────────┐ │ ┌──────────┐ │              │              │
│ │ Task234  │ │ │ Task567  │ │              │              │
│ │ MEDIUM   │ │ │ HIGH     │ │              │              │
│ │ 45m      │ │ │ 15m      │ │              │              │
│ └──────────┘ │ │ (yellow) │ │              │              │
│              │ └──────────┘ │              │              │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

#### B. View Toggle: Add to Header
```typescript
<ViewToggle>
  <Button onClick={() => setView('table')}>📋 Table</Button>
  <Button onClick={() => setView('kanban')}>📊 Kanban</Button>
</ViewToggle>
```

#### C. Drag & Drop Implementation
- Use React library: `react-beautiful-dnd` or native HTML5 drag-drop
- On drop: Call `PATCH /api/tasks/{id}` with new status
- Optimistic UI update (show change immediately)
- Rollback if API fails

### Testing Checklist
- [ ] Kanban view renders all 6 status columns
- [ ] Task cards show title, priority, SLA status
- [ ] Drag card to different column updates status
- [ ] Count badge updates when card moves
- [ ] Filters apply to Kanban view
- [ ] Color zones work in Kanban (red for urgent)
- [ ] Mobile: Kanban responsive or switches to table
- [ ] Performance: 10k tasks load < 2s
- [ ] Empty column shows "Drop tasks here" placeholder

---

## Feature 12: Real-Time Alerts

### Problem Statement
User doesn't get notification when task breaches SLA; finds out 30+ mins later.

### Requirements
- **Proactive alerts:** Warning 5 mins before breach
- **Toast notifications** with action buttons
- **Bell icon** in header with alert count
- **Alert history** accessible
- **Mark as read / dismiss** functionality
- **Sound option** (optional, respectful)

### Backend Changes

#### A. New Endpoint: `/api/alerts`
```typescript
GET /api/alerts?limit=10&unreadOnly=true
Response: {
  alerts: [
    {
      id: "alert_1",
      type: "sla_warning" | "sla_breach" | "assignment_failed",
      severity: "low" | "medium" | "high" | "critical",
      title: "Task T-4521 breaching in 5 mins!",
      message: "Order #46251 appointment-related task",
      taskId: 4521,
      createdAt: "2026-05-01T16:25:00Z",
      isRead: false,
      actionUrl: "/tasks/4521"
    },
    ...
  ],
  unreadCount: 3,
  totalCount: 47
}

// Mark alert as read
PATCH /api/alerts/{alertId}
Body: { isRead: true }

// Dismiss all alerts
POST /api/alerts/dismiss-all
```

#### B. Backend Alert Generation
Modify `slaWatcher.ts` to generate alerts:

```typescript
// When task enters warning zone (5 mins before breach)
await createAlert({
  type: "sla_warning",
  severity: "high",
  taskId: task.id,
  title: `Task "${task.title}" breaching in 5 mins!`,
  broadcast: true  // Send to all WebSocket clients
});

// When task breaches SLA
await createAlert({
  type: "sla_breach",
  severity: "critical",
  taskId: task.id,
  title: `Task "${task.title}" SLA breached!`,
  broadcast: true
});
```

#### C. WebSocket Broadcasting
When alert created, broadcast to all connected clients:

```typescript
io.emit('alert_created', {
  id: "alert_1",
  type: "sla_breach",
  taskId: 4521,
  title: "Task T-4521 breached SLA!",
  timestamp: new Date()
});
```

### Frontend Changes

#### A. New Component: `AlertBell.tsx`
```typescript
<AlertBell
  unreadCount={3}
  onClick={() => openAlertHistory()}
  onSound={(enabled) => setAlertSound(enabled)}
/>
```

Position: Top-right header

#### B. New Component: `AlertToast.tsx`
When alert received via WebSocket:

```typescript
<AlertToast
  alert={alert}
  onDismiss={() => dismissAlert(alert.id)}
  onViewTask={() => navigate(`/tasks/${alert.taskId}`)}
/>
```

Toast template:
```
┌─────────────────────────────────────┐
│ ⚠️  Task T-4521 breaching in 5 min!  │
│ Order #46251 - Confirm Booking      │
│                                     │
│ [View Task] [Dismiss] [🔔 Mute]     │
└─────────────────────────────────────┘
```

Auto-dismiss after 10 seconds (or if user interacts)

#### C. New Component: `AlertHistory.tsx`
```typescript
<AlertHistory
  alerts={alerts}
  onMarkAsRead={(id) => markAsRead(id)}
  onDismissAll={() => dismissAll()}
/>
```

Show unread alerts with badges, allow filtering by type.

#### D. WebSocket Integration
Connect to alert server on component mount:

```typescript
useEffect(() => {
  const socket = io('/api/alerts');
  socket.on('alert_created', (alert) => {
    setAlerts([alert, ...alerts]);
    showToast(alert);
    if (soundEnabled) playAlertSound();
  });
  return () => socket.disconnect();
}, []);
```

### Testing Checklist
- [ ] Alert created 5 mins before SLA breach
- [ ] Alert created when task breaches
- [ ] Toast appears in <1 second via WebSocket
- [ ] Sound plays if enabled
- [ ] Bell icon shows correct unread count
- [ ] Clicking bell opens alert history
- [ ] Marking as read removes from unread count
- [ ] "Dismiss All" clears history
- [ ] Alerts persist in database (queryable)
- [ ] Alerts filtered by type and severity
- [ ] Mobile: Toast responsive, doesn't cover critical UI
- [ ] Performance: Alert creation < 100ms

---

## Feature 13: Task Aging Indicator

### Problem Statement
Task has been in ASSIGNED status for 2 hours, but no visual cue that it's stuck. Ops don't know if this is normal or abnormal.

### Requirements
- **Age in current status:** "ASSIGNED for 35 mins"
- **Color shift:** Green (<30 mins) → Yellow (30-60) → Red (>60)
- **Configurable thresholds** per task type
- **Updates every 60 seconds**
- **Accessible in table row and Kanban card**

### Backend Changes

#### A. Modify: `/api/tasks` Response
Add task aging data:

```typescript
{
  id: 1053,
  title: "...",
  status: "ASSIGNED",
  lastStatusUpdate: "2026-05-01T15:30:00Z",  // when status changed
  
  // NEW FIELD
  aging: {
    minutesInStatus: 35,
    isStuck: false,           // true if > normal threshold for task type
    stuckThreshold: 60,       // configurable, default 60 mins
    ageColor: "yellow",       // "green", "yellow", "red"
    displayText: "ASSIGNED for 35 mins"
  },
  
  // ... other fields
}
```

#### B. Calculation Logic
In task response builder:

```typescript
function calculateAging(task: Task, now: Date): AgingInfo {
  const minutesSinceStatusChange = 
    (now.getTime() - new Date(task.lastStatusUpdate).getTime()) / 60000;
  
  // Get threshold for this task type
  const threshold = getTaskTypeThreshold(task.taskTypeId) || 60;
  
  // Determine color
  let ageColor = "green";
  if (minutesSinceStatusChange > threshold) ageColor = "red";
  else if (minutesSinceStatusChange > threshold * 0.5) ageColor = "yellow";
  
  return {
    minutesInStatus: Math.floor(minutesSinceStatusChange),
    isStuck: minutesSinceStatusChange > threshold,
    stuckThreshold: threshold,
    ageColor,
    displayText: `${task.status} for ${Math.floor(minutesSinceStatusChange)} mins`
  };
}
```

#### C. Configuration: Task Type Aging Thresholds
Add to task type configuration:

```typescript
{
  id: "confirm_booking",
  name: "Confirm Booking",
  normalAgingMinutes: 30,    // normal time in any status
  warningAgingMinutes: 45,   // yellow threshold
  criticalAgingMinutes: 60   // red threshold
}
```

### Frontend Changes

#### A. New Component: `TaskAgingIndicator.tsx`
```typescript
<TaskAgingIndicator aging={task.aging} />
```

Display in table row:
```
[ASSIGNED] 35 mins (yellow background/text)
```

Display in Kanban card:
```
ASSIGNED for 35 mins
(card background tinted yellow)
```

#### B. Real-Time Update
Update aging every 60 seconds:

```typescript
useEffect(() => {
  const interval = setInterval(() => {
    setTasks(tasks.map(t => ({
      ...t,
      aging: recalculateAging(t, new Date())
    })));
  }, 60000);
  return () => clearInterval(interval);
}, []);
```

### Testing Checklist
- [ ] Aging calculated correctly (task.lastStatusUpdate to now)
- [ ] Color transitions: Green → Yellow → Red at correct thresholds
- [ ] Display text is human-readable ("ASSIGNED for 35 mins")
- [ ] Updates every 60 seconds without page refresh
- [ ] Thresholds configurable per task type
- [ ] Works in both table and Kanban views
- [ ] Stuck tasks visually prominent (red)
- [ ] Performance: Aging calculation < 10ms per task

---

## Feature 14: Select All for Filtered View

### Problem Statement
Users can't bulk archive 20 completed tasks at once. Must select individually (20 clicks).

### Requirements
- **Checkbox: "Select all visible"** in table header
- **Selects only tasks matching current filters**
- **Enables bulk actions:** Reassign, Block, Archive, Cancel
- **Shows "X of Y selected"** counter
- **Deselect all** option

### Frontend Changes

#### A. Modify: AllTasksBoard.tsx Header
Add select-all checkbox with label:

```typescript
<TableHeader>
  <checkbox
    indeterminate={selectedCount > 0 && selectedCount < visibleCount}
    onChange={(e) => {
      if (e.target.checked) selectAllVisible();
      else deselectAll();
    }}
  />
  <span>{selectedCount > 0 ? `${selectedCount} selected` : ''}</span>
</TableHeader>
```

#### B. Bulk Actions Bar
When tasks selected, show action bar:

```
✓ 20 selected | [Reassign to...▼] [Archive All] [Cancel All] [×Clear]
```

#### C. Modify: BulkActionPanel
Make work with select-all:

```typescript
function handleBulkAction(action: string, selectedIds: number[]) {
  const count = selectedIds.length;
  
  if (action === "archive") {
    const message = `Archive ${count} completed tasks?`;
    if (confirm(message)) {
      bulkArchive(selectedIds);
    }
  }
  // ... other actions
}
```

### Testing Checklist
- [ ] "Select all" checkbox appears in header
- [ ] Checking "Select all" selects all visible (filtered) tasks
- [ ] Unchecking "Select all" deselects all
- [ ] Counter shows correct number selected
- [ ] Bulk action bar appears when tasks selected
- [ ] Bulk actions work on selected tasks only
- [ ] Performance: Selecting 1000 tasks < 1s
- [ ] Works with all filter combinations
- [ ] Preserves selection when applying new filters (if possible)

---

# PHASE 2 & 3 DATABASE MIGRATIONS

## Migration Files

### Phase 2 Migrations
File: `/prisma/migrations/20260515_phase2_core_improvements.sql`

```sql
-- Saved filters table
CREATE TABLE user_saved_filters (
  id SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "filterName" VARCHAR NOT NULL,
  "filterJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  "usageCount" INTEGER DEFAULT 0,
  UNIQUE("userId", "filterName")
);

CREATE INDEX idx_user_saved_filters_user_id ON user_saved_filters("userId");

-- Assignment audit fields (added to tasks table)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "assignmentRuleId" VARCHAR;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "assignmentMethod" VARCHAR;
```

### Phase 3 Migrations
File: `/prisma/migrations/20260525_phase3_intelligence.sql`

```sql
-- Alerts table
CREATE TABLE alerts (
  id SERIAL PRIMARY KEY,
  "type" VARCHAR NOT NULL,
  "severity" VARCHAR NOT NULL,
  "title" VARCHAR NOT NULL,
  "message" TEXT,
  "taskId" INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  "userId" INTEGER REFERENCES "User"(id) ON DELETE CASCADE,
  "isRead" BOOLEAN DEFAULT FALSE,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "dismissedAt" TIMESTAMP,
  INDEX idx_user_alerts ("userId", "isRead"),
  INDEX idx_task_alerts ("taskId", "createdAt")
);

-- Alert preferences (per user)
CREATE TABLE alert_preferences (
  id SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL UNIQUE REFERENCES "User"(id) ON DELETE CASCADE,
  "slaWarningEnabled" BOOLEAN DEFAULT TRUE,
  "slaBreachEnabled" BOOLEAN DEFAULT TRUE,
  "assignmentFailureEnabled" BOOLEAN DEFAULT TRUE,
  "soundEnabled" BOOLEAN DEFAULT FALSE,
  "createdAt" TIMESTAMP DEFAULT NOW()
);

-- Task aging configuration (per task type)
ALTER TABLE task_types ADD COLUMN IF NOT EXISTS "normalAgingMinutes" INTEGER DEFAULT 30;
ALTER TABLE task_types ADD COLUMN IF NOT EXISTS "warningAgingMinutes" INTEGER DEFAULT 45;
ALTER TABLE task_types ADD COLUMN IF NOT EXISTS "criticalAgingMinutes" INTEGER DEFAULT 60;
```

---

# IMPLEMENTATION TIMELINE

## Week 3-4: Phase 2.1 (Foundation for Usability)
- Feature 6: Unified Filter Bar (backend + frontend)
- Feature 10: Assignment Rule Audit Trail (metadata tracking)
- **Deliverable:** Ops can filter tasks efficiently, understand assignments

## Week 5: Phase 2.2 (Context & Detail)
- Feature 7: Better SLA Display
- Feature 8: Task Detail Side Panel
- Feature 9: Improved Empty State
- **Deliverable:** Ops understand full task context without modal friction

## Week 6-8: Phase 3.1 (Visual Intelligence)
- Feature 11: Kanban / Grouping View
- Feature 13: Task Aging Indicator
- Feature 14: Select All for Filtered View
- **Deliverable:** Ops see workflow flow visually, spot stuck tasks

## Week 9-10: Phase 3.2 (Real-Time Awareness)
- Feature 12: Real-Time Alerts (WebSocket integration)
- **Deliverable:** Ops get proactive warnings, never miss SLA breaches

---

# TESTING STRATEGY

## Phase 2 Testing
- **Unit tests:** Filter logic, SLA display calculations, pagination
- **Integration tests:** Filter + sort combinations, task detail panel data
- **E2E tests:** Select filter → see correct tasks → click task → panel opens
- **Performance:** 10k tasks with filters < 2s load time
- **QA checklist:** Comprehensive user workflows

## Phase 3 Testing
- **Unit tests:** Aging calculations, alert generation logic
- **Integration tests:** WebSocket connection, alert broadcasting
- **E2E tests:** Task breaches → alert fires → user sees → dismisses
- **Kanban testing:** Drag task → status updates → count badge changes
- **Performance:** 10k tasks in Kanban < 3s render, drag < 500ms response

---

# SUCCESS METRICS

| Metric | Phase 2 Target | Phase 3 Target |
|--------|---|---|
| Time to identify SLA-at-risk tasks | <5s | <3s |
| Time to drill into task details | <3s (vs 10s before) | <3s |
| Users using Kanban view | 30% of ops | 60% of ops |
| SLA breach incidents | -30% vs Phase 1 | -50% vs Phase 1 |
| Manual workarounds | <20% | <10% |
| User NPS | 7.5/10 | 8.5/10 |

---

# FILES TO CREATE/MODIFY

## Backend Files

### APIs to Create
- `/src/app/api/tasks/filters/schema.ts` (NEW)
- `/src/app/api/tasks/saved-filters/route.ts` (NEW)
- `/src/app/api/alerts/route.ts` (NEW)
- `/src/app/api/alerts/preferences/route.ts` (NEW)

### Files to Modify
- `/src/app/api/tasks/route.ts` (add filter params, SLA context)
- `/src/lib/engine/slaWatcher.ts` (add alert generation)
- `/src/lib/engine/taskCreator.ts` (add assignment audit)
- `/prisma/schema.prisma` (add models: SavedFilter, Alert)

### New Services
- `/src/lib/services/alertService.ts` (alert creation, broadcasting)
- `/src/lib/services/filterService.ts` (save/load filter combos)
- `/src/lib/services/agingService.ts` (calculate task aging)

## Frontend Files

### Components to Create
- `/src/components/filters/UnifiedFilterBar.tsx` (NEW)
- `/src/components/tasks/TaskDetailPanel.tsx` (NEW - if not exists)
- `/src/components/tasks/SLADisplay.tsx` (NEW)
- `/src/components/tasks/AssignmentAuditTrail.tsx` (NEW)
- `/src/components/tasks/KanbanBoard.tsx` (NEW)
- `/src/components/alerts/AlertBell.tsx` (NEW)
- `/src/components/alerts/AlertToast.tsx` (NEW)
- `/src/components/alerts/AlertHistory.tsx` (NEW)
- `/src/components/tasks/TaskAgingIndicator.tsx` (NEW)
- `/src/components/tasks/EmptyStateMessage.tsx` (NEW)

### Files to Modify
- `/src/components/head/AllTasksBoard.tsx` (integrate all new components)
- `/src/lib/hooks/useTasks.ts` (add WebSocket listening, aging calculation)
- `/src/types/index.ts` (add new types: Filter, Alert, Aging, etc.)

## Database Migrations
- `/prisma/migrations/20260515_phase2_core_improvements.sql` (NEW)
- `/prisma/migrations/20260525_phase3_intelligence.sql` (NEW)

---

# DEPLOYMENT CHECKLIST

### Phase 2 Pre-Deployment
- [ ] All backend endpoints tested and documented
- [ ] Frontend components built and tested
- [ ] Database migrations applied to staging
- [ ] Performance benchmarks met (<2s load time)
- [ ] Error handling for all edge cases
- [ ] Code review completed
- [ ] QA sign-off

### Phase 3 Pre-Deployment
- [ ] WebSocket server configured and tested
- [ ] Alert generation logic verified
- [ ] Kanban drag-drop working smoothly
- [ ] Real-time updates tested with multiple users
- [ ] Performance benchmarks for real-time features
- [ ] Graceful fallback if WebSocket unavailable
- [ ] Browser compatibility tested (Chrome, Firefox, Safari)

---

# KNOWN RISKS & MITIGATION

| Risk | Severity | Mitigation |
|------|----------|-----------|
| WebSocket connection instability | HIGH | Implement reconnect logic with exponential backoff |
| Alert spam (too many toasts) | MEDIUM | Rate-limit alerts, group similar alerts |
| Kanban drag-drop performance | MEDIUM | Virtual scrolling for large task counts |
| Filter state loss on page reload | LOW | Persist filters in URL/localStorage |
| Real-time sync inconsistency | MEDIUM | Server-side audit log for all changes |

---

**Implementation Start Date:** May 15, 2026
**Phase 2 Target Completion:** May 31, 2026
**Phase 3 Target Completion:** June 15, 2026
**Total Effort:** ~40-50 engineer-days (1.5-2 months with 2 engineers)
