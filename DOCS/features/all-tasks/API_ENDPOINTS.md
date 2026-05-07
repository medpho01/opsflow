# All Tasks - API Endpoints

All API endpoints for the All Tasks feature. These endpoints power the task board, filtering, and task management operations.

## 📋 Endpoint Overview

| Method | Endpoint | Purpose | Response |
|--------|----------|---------|----------|
| GET | `/api/tasks` | Fetch paginated task list with filters/sorting | TaskWithContext[] |
| GET | `/api/tasks/filters/schema` | Get filter dropdown options | FilterSchema |
| GET | `/api/tasks/saved-filters` | Get user's saved filter combinations | SavedFilter[] |
| POST | `/api/tasks/saved-filters` | Save new filter combination | SavedFilter |
| PATCH | `/api/tasks/{id}` | Update single task (status, notes, assignment) | TaskWithContext |
| PATCH | `/api/tasks/bulk` | Bulk update multiple tasks | BulkUpdateResponse |
| GET | `/api/tasks/status-distribution` | Get count of tasks per status | StatusDistribution |

---

## GET /api/tasks

Fetch paginated task list with advanced filtering, sorting, and SLA context.

### Request

**Query Parameters:**
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

**Example Request:**
```bash
GET /api/tasks?status=IN_PROGRESS&status=BLOCKED&priority=HIGH&sortBy=slaDeadline&sortOrder=asc&page=1&pageSize=25
Authorization: Bearer <jwt_token>
```

### Response (HTTP 200)

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
  status: TaskStatus;                      // CREATED, ASSIGNED, IN_PROGRESS, BLOCKED, COMPLETED, BREACHED, CANCELLED
  priority: Priority;                      // LOW, MEDIUM, HIGH, URGENT
  createdAt: string;                       // ISO-8601 UTC
  assignedTo: { id: number; name: string } | null;
  
  // SLA Context
  slaContext: {
    slaDeadline: string;                   // ISO-8601 UTC
    minutesRemaining: number;
    slaRiskLevel: 'safe' | 'warning' | 'critical' | 'breached';
    slaBreachedAt: string | null;
    breachDuration: number | null;
  };
  
  // Task Aging
  aging: {
    timeInStatus: number;                  // Minutes in current status
    colorCode: 'green' | 'yellow' | 'red';
    status: string;                        // "45 mins in ASSIGNED"
    isStuck: boolean;                      // > 60 mins
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

**Example Response:**
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
      },
      "assignmentRuleId": 3,
      "assignmentMethod": "AUTO"
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

### Error Cases
- **401 Unauthorized** - User not authenticated
- **403 Forbidden** - User lacks required role (OPS_HEAD, STORE_ADMIN, OPS_AGENT)
- **400 Bad Request** - Invalid filter/sort parameters
- **500 Server Error** - Database error

### Performance
- Response time target: <300ms
- Supports filters on: status, priority, assignee, date range, order ID
- Tiebreaker sorting: priority DESC, then createdAt ASC

---

## GET /api/tasks/filters/schema

Get available filter options for UI dropdown rendering.

### Request
```bash
GET /api/tasks/filters/schema
Authorization: Bearer <jwt_token>
```

### Response (HTTP 200)

```typescript
interface FilterSchema {
  statuses: string[];         // All 7 task status values
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

**Example Response:**
```json
{
  "statuses": ["CREATED", "ASSIGNED", "IN_PROGRESS", "BLOCKED", "COMPLETED", "BREACHED", "CANCELLED"],
  "priorities": ["LOW", "MEDIUM", "HIGH", "URGENT"],
  "assignees": [
    { "id": 1, "name": "Mayur" },
    { "id": 2, "name": "Priya" },
    { "id": 3, "name": "Anil" }
  ],
  "dateRangePresets": [
    { "label": "Today", "value": "today" },
    { "label": "This Week", "value": "thisWeek" },
    { "label": "This Month", "value": "thisMonth" },
    { "label": "Custom Range", "value": "custom" }
  ]
}
```

---

## GET /api/tasks/saved-filters

Get user's saved filter combinations.

### Request
```bash
GET /api/tasks/saved-filters
Authorization: Bearer <jwt_token>
```

### Response (HTTP 200)

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

---

## POST /api/tasks/saved-filters

Save a new filter combination for the user.

### Request

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

**Example:**
```bash
POST /api/tasks/saved-filters
Authorization: Bearer <jwt_token>
Content-Type: application/json

{
  "filterName": "Critical Tasks",
  "filters": {
    "status": ["IN_PROGRESS", "BLOCKED"],
    "priority": ["URGENT", "HIGH"],
    "slaRiskOnly": true
  }
}
```

### Response (HTTP 201)
```json
{
  "id": 42,
  "filterName": "Critical Tasks",
  "filterJson": { ... },
  "usageCount": 0,
  "createdAt": "2026-05-02T10:00:00Z",
  "updatedAt": "2026-05-02T10:00:00Z"
}
```

### Error Cases
- **400 Bad Request** - Empty filter name or invalid filters
- **409 Conflict** - Filter name already exists for user (suggest update)

---

## PATCH /api/tasks/{id}

Update single task (status, notes, assignment).

### Request

```typescript
interface UpdateTaskRequest {
  status?: TaskStatus;
  notes?: string;
  assignedToId?: number;
  assignmentMethod?: 'AUTO' | 'MANUAL';
}
```

### Response (HTTP 200)
Returns updated TaskWithContext (same as GET /api/tasks item)

### Business Logic
- Validate status transitions (e.g., BLOCKED → IN_PROGRESS only)
- Auto-update lastStatusUpdate on status change
- Only OPS_HEAD and STORE_ADMIN can reassign
- Log state changes for audit trail

---

## PATCH /api/tasks/bulk

Update multiple tasks in single API call.

### Request

```typescript
interface BulkUpdateRequest {
  taskIds: number[];
  action: 'reassign' | 'cancel' | 'block' | 'unblock';
  assignedToId?: number;  // Required if action='reassign'
}
```

### Response (HTTP 200)

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

---

## GET /api/tasks/status-distribution

Get count of tasks in each status for status distribution widget.

### Request
```bash
GET /api/tasks/status-distribution
Authorization: Bearer <jwt_token>
```

### Response (HTTP 200)

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

**Example:**
```json
{
  "CREATED": 45,
  "ASSIGNED": 23,
  "IN_PROGRESS": 178,
  "BLOCKED": 12,
  "BREACHED": 8,
  "COMPLETED": 156,
  "CANCELLED": 44,
  "TOTAL": 466
}
```

---

## Role-Based Access Control

All endpoints enforce role-based visibility:

| Endpoint | OPS_AGENT | STORE_ADMIN | OPS_HEAD |
|----------|-----------|------------|----------|
| GET /api/tasks | Own tasks only | Assigned stores | All tasks |
| GET /api/tasks/filters/schema | Limited options | Filtered options | All options |
| PATCH /api/tasks/{id} | Own tasks | Own store tasks | All tasks |
| PATCH /api/tasks/bulk | Not allowed | Own store | All |

---

## Error Response Format

All endpoints use consistent error format:

```typescript
interface ErrorResponse {
  error: string;
  code: string;
  details?: any;
}

// Examples
{ "error": "Unauthorized", "code": "UNAUTHORIZED", status: 401 }
{ "error": "Forbidden", "code": "FORBIDDEN", status: 403 }
{ "error": "Failed to fetch filter schema", "code": "SCHEMA_FETCH_ERROR", status: 500 }
```

---

## Performance Targets

| Endpoint | Target | Notes |
|----------|--------|-------|
| GET /api/tasks | <300ms | With filters and pagination |
| GET /api/tasks/filters/schema | <100ms | Cached on client |
| GET /api/tasks/saved-filters | <100ms | Per-user query |
| POST /api/tasks/saved-filters | <50ms | Simple insert |
| PATCH /api/tasks/{id} | <100ms | Single update |
| PATCH /api/tasks/bulk | <500ms | Batch of up to 50 tasks |
| GET /api/tasks/status-distribution | <100ms | Aggregation query |

---

**Last Updated**: May 2, 2026  
**Documentation Version**: 1.0
