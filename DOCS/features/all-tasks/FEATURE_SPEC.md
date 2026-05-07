# All Tasks - Feature Specification

**Feature Owner: Abhishek (Product Manager)**  
**Tech Lead: Manjul (Tech Architect)**  
**Version: 1.0** (Feature Documentation Restructure - May 2, 2026)  

---

## Quick Navigation
- 📖 [Codebase Location](#codebase-location)
- 🔌 [API Endpoints](API_ENDPOINTS.md)
- 🏗️ [Technical Spec](TECHNICAL_SPEC.md)
- 🧪 [Testing Guide](TESTING_GUIDE.md)
- 🗺️ [Implementation Roadmap](IMPLEMENTATION_ROADMAP.md)

---

## Codebase Location
- **Main Entry**: `/src/app/(app)/head/tasks/page.tsx` (AllTasksBoard component)
- **Components**: `/src/components/head/` (all task board components)
- **API Route**: `/src/app/api/tasks/` (GET /api/tasks endpoint)
- **Schema**: `/prisma/schema.prisma` (Task model, 7 status types)

---

## Executive Summary

The "All Tasks" feature is the central command center for task management in TaskOS. It provides operations teams with a comprehensive view of all tasks across the system, with advanced filtering, real-time status tracking, SLA monitoring, and intelligent insights for task aging and workload distribution.

### Key Metrics
- **Supported Tasks**: 466+ concurrent active tasks
- **Status States**: 7 distinct states (CREATED, ASSIGNED, IN_PROGRESS, BLOCKED, COMPLETED, CANCELLED, BREACHED)
- **SLA States**: 4 risk levels (safe, warning, critical, breached)
- **View Modes**: 2 (Table, Kanban)
- **Filter Types**: 6+ concurrent filters with save capability
- **Update Frequency**: Manual refresh only (Real-time updates with WebSocket/SSE planned)

---

## 1. Feature Overview

### 1.1 Core Features (Phase 1)
- ✅ **Task Listing with Pagination**: Browse tasks with configurable page sizes (default: 25 tasks/page)
- ✅ **Multi-column Table View**: Sortable columns with visual indicators
- ✅ **Basic Status Filtering**: Filter by task status
- ✅ **Priority Visualization**: Color-coded priority badges (URGENT=Red, HIGH=Orange, MEDIUM=Blue, LOW=Gray)
- ✅ **SLA Countdown**: Real-time SLA deadline countdown with color-coded urgency
- ✅ **Refresh Controls**: Manual refresh button with last-updated timestamp

### 1.2 Phase 2 Features (Usability)
- ✅ **Unified Filter Bar**: Multi-select filtering with save/load capability
- ✅ **SLA Timeline Display**: Visual timeline showing created → deadline → breach moments
- ✅ **Task Aging Indicators**: Color-coded time-in-status badges (green/yellow/red)
- ✅ **Assignment Audit Trail**: Rule-based assignment tracking with history
- ✅ **Empty State Messaging**: Helpful recovery actions when filters return no results

### 1.3 Phase 3 Features (Intelligence)
- ✅ **Kanban Board View**: Six-column drag-and-drop status management
- ✅ **Task Aging Intelligence**: Automatic detection of stuck tasks (>60min thresholds)
- ✅ **SLA Risk Filtering**: Toggle to show only warning/critical/breached tasks
- ✅ **Alert Infrastructure**: Ready for real-time notifications and updates

---

## 2. Task Status Flow

### 2.1 Status States and Transitions

```
CREATED (Initial)
   ↓
ASSIGNED (Rule-matched or manual)
   ↓
IN_PROGRESS (Agent started work)
   ├→ BLOCKED (Impediment encountered)
   │   └→ IN_PROGRESS (Resumed)
   └→ COMPLETED (Work finished)
   
BREACHED (SLA deadline missed - can occur from any active state)
   └→ IN_PROGRESS or COMPLETED (Recovery)

CANCELLED (Terminal - task abandoned)
```

### 2.2 Status Semantics

| Status | Meaning | Duration Threshold | Color | Can Transition To |
|--------|---------|-------------------|-------|------------------|
| **CREATED** | Task initialized, awaiting assignment | N/A | Gray | ASSIGNED, BREACHED |
| **ASSIGNED** | Task matched by rule, awaiting agent start | <30min (aging) | Blue | IN_PROGRESS, BREACHED |
| **IN_PROGRESS** | Agent actively working | <60min (aging) | Purple | BLOCKED, COMPLETED, BREACHED |
| **BLOCKED** | Waiting for external dependency | <45min (aging) | Orange | IN_PROGRESS, BREACHED |
| **COMPLETED** | Work finished successfully | Terminal | Green | N/A |
| **BREACHED** | SLA deadline missed | Terminal | Red | N/A |
| **CANCELLED** | Task abandoned | Terminal | Red | N/A |

### 2.3 Aging Thresholds

Tasks in any non-terminal status are monitored for time spent in that status:

```
Green (Safe):     0-30 minutes
Yellow (Warning): 30-45 minutes  
Red (Critical):   45+ minutes (stuck threshold: 60min)
```

---

## 3. SLA Management

### 3.1 SLA Lifecycle

Each task has a defined SLA deadline calculated at creation:
- **Formula**: `createdAt + slaMinutes`
- **Example**: Task created at 9:00 AM with 120 SLA minutes → Deadline at 11:00 AM

### 3.2 SLA Risk States

| Risk Level | Condition | Visual | Action Required |
|------------|-----------|--------|-----------------|
| **Safe** | >30 mins remaining | Green border | None |
| **Warning** | 10-30 mins remaining | Yellow border | Monitor closely |
| **Critical** | <10 mins remaining | Orange border | Escalate if needed |
| **Breached** | Deadline passed | Red border + "BREACHED" status | Post-mortem analysis |

### 3.3 SLA Tracking

- **slaDeadline**: ISO-8601 timestamp of deadline
- **slaBreachedAt**: ISO-8601 timestamp when breach occurred (if any)
- **minutesRemaining**: Calculated at query time
- **breachDuration**: Minutes exceeded deadline (for breached tasks)

---

## 4. Task Assignment

### 4.1 Assignment Methods

#### Auto-Assignment (Rule-Based)
- **Trigger**: Task matching rule conditions
- **Method**: `assignmentMethod = "auto"`
- **Tracking**: `assignmentRuleId` records which rule matched
- **Audit Trail**: Captured with timestamp and rule metadata

#### Manual Assignment
- **Trigger**: User explicitly assigns task to agent
- **Method**: `assignmentMethod = "manual"`
- **Tracking**: `assignmentRuleId` may be null or differ from trigger rule
- **Audit Trail**: User who assigned, timestamp, previous assignee

### 4.2 Assignment States

- **Unassigned**: No assignee, awaiting rule or manual assignment
- **Assigned**: `assignedToId` and `assignedAt` populated
- **Reassigned**: Assignment changed (tracked in audit trail)

---

## 5. Filtering System

### 5.1 Available Filters

| Filter | Type | Options | Multi-Select | Example |
|--------|------|---------|--------------|---------|
| **Status** | Enum | CREATED, ASSIGNED, IN_PROGRESS, BLOCKED, BREACHED, COMPLETED, CANCELLED | Yes | ["IN_PROGRESS", "BLOCKED"] |
| **Priority** | Enum | LOW, MEDIUM, HIGH, URGENT | Yes | ["HIGH", "URGENT"] |
| **Assignee** | User ID | All active OPS_AGENT and STORE_ADMIN users | Yes | [1, 5, 12] |
| **Store** | Location ID | All configured stores | No | 7 |
| **Date From** | ISO-8601 | Any past date | No | "2026-05-01T00:00:00Z" |
| **Date To** | ISO-8601 | Any future date | No | "2026-05-02T23:59:59Z" |
| **SLA Risk Only** | Boolean | true/false | N/A | true (shows warning/critical/breached) |
| **Order ID** | Integer | Any order ID | No | 46251 |

### 5.2 Filter Persistence

- **Saved Filters**: Named filter combinations stored per user
- **Storage**: `UserSavedFilter` table with userId + filterName unique constraint
- **Metadata**: 
  - `filterJson`: Full filter configuration as JSONB
  - `usageCount`: Times filter has been applied (for sorting/recommendations)
  - `createdAt`, `updatedAt`: Timestamps

### 5.3 Filter Operations

```
Apply Filter → Query executes with WHERE clauses → Results displayed
↓
Save Filter → User names combination → Stored with usage metadata
↓
Load Filter → Retrieve saved configuration → Auto-apply and execute
↓
Increment Usage → Track filter popularity → Sort by usage in UI
```

---

## 6. Timezone Handling

### 6.1 System Timezone: IST (UTC+5:30)

All timestamps in the system are stored in UTC but displayed in IST (Indian Standard Time).

### 6.2 Timezone Conversion

- **Database Storage**: UTC timestamps (enforced at Prisma level)
- **API Response**: ISO-8601 UTC strings
- **Frontend Display**: Converted to IST with offset +5:30
- **User Input**: Parsed as IST, converted to UTC for storage

### 6.3 Examples

```
User sees: "Friday, May 1, 2026, 8:30 PM IST"
Stored as: "2026-05-01T15:00:00Z" (UTC)
API returns: "2026-05-01T15:00:00Z"
Calculation: 15:00 UTC + 5:30 = 20:30 IST ✓
```

### 6.4 Relative Time Formatting

System calculates human-readable relative times:
- `"now"` - less than 1 minute ago
- `"45m ago"` - 45 minutes ago
- `"2h ago"` - 2 hours ago
- `"3d ago"` - 3 days ago
- `"in 1h"` - 1 hour in future
- `"in 2d"` - 2 days in future

---

## 7. Sorting

### 7.1 Supported Sort Fields

| Field | Direction | Tiebreaker | Use Case |
|-------|-----------|------------|----------|
| **createdAt** | asc/desc | None | Newest/oldest tasks |
| **priority** | asc/desc | createdAt (asc) | Most urgent first |
| **slaDeadline** | asc/desc | priority (desc) → createdAt (asc) | Most at-risk first |
| **status** | asc/desc | priority (desc) → createdAt (asc) | Organize by workflow stage |
| **appointmentTime** | asc/desc | priority (desc) → createdAt (asc) | By scheduled time |

### 7.2 Default Sorting

- **Default**: Priority (descending) = URGENT → HIGH → MEDIUM → LOW
- **Within same priority**: Older tasks first (createdAt ascending)

---

## 8. View Modes

### 8.1 Table View (Default)

**Columns** (left to right):
1. Checkbox (select multiple)
2. Task ID
3. Task Title
4. Status Badge (color-coded)
5. Priority Badge (color-coded)
6. Assignee Name
7. SLA Countdown (real-time)
8. SLA Status Indicator (colored border/icon)
9. Task Aging Indicator (time in status)
10. Order ID (clickable → Order details popup)

**Interactions**:
- Click row → Open task detail panel (right sidebar)
- Click status badge → View related tasks
- Click assignee → Filter by that agent
- Click order ID → View order quick-view modal
- Checkbox → Select for bulk actions

### 8.2 Kanban View

**Columns** (left to right):
1. CREATED (new tasks awaiting assignment)
2. ASSIGNED (assigned, awaiting start)
3. IN_PROGRESS (active work)
4. BLOCKED (waiting on dependencies)
5. COMPLETED (finished tasks)
6. CANCELLED (abandoned tasks)

**Card Layout**:
- Task title (truncated to 2 lines)
- Priority badge
- Task aging indicator (colored dot + minutes)
- Task ID

**Interactions**:
- Drag card between columns → Update status
- Click card → Open task detail panel
- View column count → See task distribution

---

## 9. Task Detail Panel

### 9.1 Sections

#### Header
- Task title
- Status badge (with terminal state indicator)
- Priority badge
- SLA deadline countdown (real-time)
- "Flag for Help" button (marks as BLOCKED)

#### Order Details
- Patient name
- Order type
- Lab name
- Store name
- Phlebotomist name and number
- Appointment time (IST formatted)
- Order status

#### SLA Timeline (Expanded)
- Created timestamp with relative time
- SLA deadline with relative time
- Breach timestamp (if breached) with relative time
- Visual timeline showing progression

#### Assignment Audit Trail
- Rule name that assigned task
- Trigger conditions
- Assignment method (auto/manual)
- Override history (if reassigned)

#### Checklist (if applicable)
- Progress bar (percentage complete)
- Checkbox items (required items marked)
- Mark complete on-demand

#### Notes
- Add notes textarea
- Save note button
- Note saved confirmation

#### Action Buttons
- "Start Task" → IN_PROGRESS
- "Mark Complete" → COMPLETED
- "Mark Blocked" → BLOCKED
- "Resume" → IN_PROGRESS (from BLOCKED)
- Terminal state indicator (COMPLETED/CANCELLED)

---

## 10. Bulk Actions

### 10.1 Supported Actions

- **Reassign**: Change assignee for multiple tasks
- **Cancel**: Mark tasks as CANCELLED
- **Block**: Mark tasks as BLOCKED
- **Unblock**: Move tasks back to IN_PROGRESS

### 10.2 UI Flow

1. Select multiple tasks (checkboxes)
2. Choose action from dropdown
3. If reassign: Select new assignee
4. Confirm action
5. Tasks updated
6. Success message shows count

---

## 11. Status Distribution Widget

Real-time count of tasks in each status:

```
CREATED: 45
ASSIGNED: 23
IN_PROGRESS: 178
BLOCKED: 12
BREACHED: 8
COMPLETED: 156
CANCELLED: 44
────────────
TOTAL: 466
```

Updates with task changes and manual refresh.

---

## 12. Performance & Scalability

### 12.1 Query Optimization

- **Pagination**: Default 25 tasks/page, max 50
- **Indices**: Created on status, priority, assigneeId, slaDeadline, createdAt
- **Join Strategy**: Include assignee, taskType, checklistItems in single query
- **Filter Pushdown**: WHERE clauses applied at database level

### 12.2 Caching Strategy

- **Front-end Cache**: 5-second polling interval (prevents thrashing)
- **Status Distribution**: Cached per request (recalculated on each fetch)
- **Filter Schema**: Cached on mount, refreshed on demand

### 12.3 Load Limits

- Max 466 active tasks per system
- Max 50 tasks per page
- Max 25 filters per user
- Filter response time: <300ms

---

## 13. Error Handling

### 13.1 Error Messages

| Error | Cause | Recovery |
|-------|-------|----------|
| HTTP 401 | Unauthorized | Re-authenticate |
| HTTP 403 | Forbidden (role-based) | Verify user role |
| HTTP 500 | Server error | Retry after 30s |
| 0 tasks returned | No matches in filters | Clear filters or adjust criteria |

### 13.2 Graceful Degradation

- If fetch fails: Show last known state + error banner
- If sort fails: Fall back to priority sort
- If filter schema unavailable: Show basic filters only
- If status distribution fails: Continue showing tasks

---

## 14. Role-Based Visibility

### 14.1 Visibility Rules

| Role | Can See | Can See | Notes |
|------|---------|---------|-------|
| **OPS_AGENT** | Own assigned tasks | Only their queue | Cannot see others' tasks |
| **STORE_ADMIN** | Tasks for assigned stores | By store | Cannot see other stores |
| **OPS_HEAD** | All tasks | Entire system | Full visibility |

### 14.2 Action Permissions

| Action | OPS_AGENT | STORE_ADMIN | OPS_HEAD |
|--------|-----------|------------|----------|
| View tasks | Own | Assigned stores | All |
| Update status | Own | Assigned stores | All |
| Reassign | No | Yes | Yes |
| Bulk actions | No | Own store | All |
| Create task | No | No | Yes |
| View audit trail | Own | Own store | All |

---

## 15. Integration Points

### 15.1 External Systems

- **Order Management**: Fetch order details (patient, lab, phlebotomist)
- **Roster System**: Load assignees and availability
- **Notification System**: Alert on SLA breaches and task updates
- **Analytics**: Track task completion metrics and SLA adherence

### 15.2 API Endpoints

- `GET /api/tasks` - Fetch tasks with filters and sorting
- `GET /api/tasks/filters/schema` - Get available filter options
- `GET /api/tasks/saved-filters` - Retrieve user's saved filters
- `POST /api/tasks/saved-filters` - Save new filter combination
- `PATCH /api/tasks/{id}` - Update task status/notes
- `PATCH /api/tasks/bulk` - Bulk update multiple tasks
- `GET /api/tasks/status-distribution` - Get count per status
- `GET /api/alerts` - Fetch pending alerts and notifications

---

## 16. Dynamic Enum Management

### 16.1 Overview

Order Types and Order Statuses are now fetched dynamically from the database at runtime, ensuring the system always reflects the actual database state without requiring code updates or Prisma schema changes.

### 16.2 Implementation

**Single Source of Truth**: All enum values come from PostgreSQL's system catalog (`pg_enum` table), queried directly through Prisma raw SQL.

**Endpoints**:
- `GET /api/order-types` → Returns all OrderType enum values (e.g., CAMP, CENTER_VISIT, HOME_SAMPLE, KIT_BASED)
- `GET /api/order-statuses` → Returns all OrderStatus enum values (e.g., ORDER_SCHEDULED, PHLEBO_ASSIGNED, SAMPLE_COLLECTED, etc.)

**Response Format**:
```json
// GET /api/order-types
{
  "orderTypes": ["CAMP", "CENTER_VISIT", "HOME_SAMPLE", "KIT_BASED"],
  "count": 4
}

// GET /api/order-statuses
{
  "statuses": ["CANCELED", "CREATED", "KIT_DISPATCHED", "ORDER_SCHEDULED", ...],
  "count": 13,
  "description": "All valid Labstack order statuses for task rule triggers"
}
```

### 16.3 Benefits

1. **No Maintenance Burden**: Enum values are queried from database, not hardcoded
2. **Consistency**: Database schema is always the single source of truth
3. **Real-Time Updates**: New enum values reflect immediately without code deployment
4. **Error Prevention**: Invalid enum references are caught at database layer
5. **Scalability**: Works with any number of enum values

### 16.4 Database Integration

**Data Flow**:
```
PostgreSQL pg_enum System Catalog
    ↓
Prisma Raw SQL Query
    ↓
API Endpoint (/api/order-types, /api/order-statuses)
    ↓
Frontend Components
    ├─ TaskRulesPanel (dropdown selectors)
    ├─ AllTasksBoard (filter options)
    └─ Custom Components
```

### 16.5 UI Integration

**Used in**:
- Task Rules Panel: Order type and status selection dropdowns
- Filter schema endpoint: Provides valid status values for filters
- Task Rules metadata fields endpoint: References for trigger conditions

**Dropdown Population**:
```
1. Component mounts
2. Fetches GET /api/order-types and GET /api/order-statuses
3. Populates dropdown menus with returned values
4. User selects from available options
5. Selected values are passed to API endpoints for validation
```

### 16.6 Performance

- **Response Time**: <50ms (direct database query with pagination)
- **Caching**: Frontend components cache responses for session duration
- **Load Impact**: Minimal (simple SELECT from system catalog)
- **Scalability**: Works efficiently regardless of enum count

---

## 17. Future Enhancements

- [ ] WebSocket real-time updates (currently manual refresh only)
- [ ] Server-Sent Events (SSE) for true push notifications
- [ ] Task commenting system
- [ ] Assignment optimization AI
- [ ] Custom SLA rules per task type
- [ ] Predictive aging alerts
- [ ] Team workload balancing
- [ ] Historical analytics dashboard

---

## 17. Appendix

### 17.1 Example: Task Creation Flow

```
1. User creates task via "New Task" dialog
   ├─ Title: "Confirm blood sample collected"
   ├─ Type: "Sample Collection"
   ├─ Priority: "HIGH"
   ├─ Entity: Order #46251
   └─ SLA: 120 minutes

2. Task stored:
   ├─ status: "CREATED"
   ├─ createdAt: "2026-05-01T15:00:00Z"
   ├─ slaDeadline: "2026-05-01T17:00:00Z"
   └─ No assignment yet

3. Rules evaluated:
   ├─ Rule R5: matches (statusIn: ["SAMPLE_COLLECTED"])
   └─ No match → stays "CREATED"

4. Agent sees task in "CREATED" column (Kanban)
5. Agent drags to "IN_PROGRESS"
   ├─ status: "IN_PROGRESS"
   └─ assignedAt: "2026-05-01T15:02:30Z"

6. SLA Monitoring:
   ├─ Deadline: 17:00 IST
   ├─ At 16:30: "30 mins remaining" → YELLOW
   ├─ At 16:50: "10 mins remaining" → RED (critical)
   └─ At 17:05: "BREACHED" → RED, status changed to BREACHED
```

---

**Document Version History**:
- v1.0 (Apr 25, 2026): Initial spec
- v2.0 (May 2, 2026): Added Phase 2 & 3 features, timezone details, filter persistence
