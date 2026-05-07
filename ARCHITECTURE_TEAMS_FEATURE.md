# Teams Feature - Detailed Architecture & Implementation Guide

**Architect**: Manjul  
**For**: Mayur (Senior Developer)  
**Date**: May 3, 2026  
**Status**: Ready for Implementation  
**Timeline**: 3-4 weeks (22 engineering days)

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Database Schema](#database-schema)
3. [API Specifications](#api-specifications)
4. [Assignment Engine Algorithm](#assignment-engine-algorithm)
5. [Implementation Sequence](#implementation-sequence)
6. [Code Examples](#code-examples)
7. [Test Cases](#test-cases)
8. [Error Handling & Edge Cases](#error-handling--edge-cases)

---

## System Architecture

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                   React Frontend                        │
│  ├─ TeamPanel (list members)                            │
│  ├─ Member Detail + OrderType Drawer                    │
│  ├─ OrderTypeAssignmentModal (assign/remove OT)         │
│  └─ Performance Metrics Display                         │
└────────────────────┬────────────────────────────────────┘
                     │ HTTP/JSON
┌────────────────────▼────────────────────────────────────┐
│              Next.js API Layer                          │
│  ├─ GET /api/team (enhanced with orderTypes)           │
│  ├─ GET/POST/DELETE /api/team/[id]/order-types         │
│  ├─ GET /api/order-types (valid enum values)           │
│  └─ GET /api/team/[id]/performance (stats)             │
└────────────────────┬────────────────────────────────────┘
                     │ SQL/ORM
┌────────────────────▼────────────────────────────────────┐
│            Prisma ORM + Query Layer                     │
│  ├─ TeamMemberOrderType model queries                  │
│  ├─ Task aggregation for performance stats             │
│  ├─ Member eligibility filtering                       │
│  └─ Round-robin state management                       │
└────────────────────┬────────────────────────────────────┘
                     │ SQL
┌────────────────────▼────────────────────────────────────┐
│           PostgreSQL Database                          │
│  ├─ team_member_order_types (new)                      │
│  ├─ team_members (enhanced with relation)              │
│  ├─ tasks (existing, queried for stats)                │
│  └─ round_robin_state (new, for tracking)              │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│            Engine Layer (Background)                   │
│  └─ pickAssignee() in taskCreator.ts                   │
│     ├─ Filter by order type                            │
│     ├─ Filter by skills                                │
│     ├─ Filter by roster status                         │
│     ├─ Load balance (least tasks)                       │
│     └─ Round-robin tiebreaker                          │
└─────────────────────────────────────────────────────────┘
```

### Data Flow: Task Assignment

```
TaskRule triggers (in poller)
         ↓
Load order from Labstack
         ↓
Evaluate trigger condition
         ↓
Get required skills from TaskRule
         ↓
Call pickAssignee(orderType, skillIds, storeId)
         ├─ [MODIFIED] Get all members with required skills
         ├─ [MODIFIED] Filter to members with orderType assigned
         ├─ Filter by store assignment
         ├─ Filter by roster status (ACTIVE, ON_FIELD)
         ├─ Group by current task load
         ├─ If tie: Use round-robin pointer
         ├─ Update round-robin state
         └─ Return selected member ID
         ↓
Create Task with assignedToId, orderType, assignmentMethod="auto"
         ↓
Notify assigned member
```

---

## Database Schema

### Schema Changes

#### 1. New Table: `TeamMemberOrderType`

```prisma
model TeamMemberOrderType {
  id                Int         @id @default(autoincrement())
  
  // Foreign keys
  teamMemberId      Int
  teamMember        TeamMember  @relation("orderTypes", fields: [teamMemberId], references: [id], onDelete: Cascade)
  
  // Order type assignment
  orderType         OrderType   // HOME_SAMPLE, CENTER_VISIT, INJECTION
  
  // Metadata
  assignedAt        DateTime    @default(now())
  assignedBy        Int?        // User ID who assigned it (optional)
  
  // Constraints
  @@unique([teamMemberId, orderType])
  @@index([teamMemberId])
  @@index([orderType])
  @@index([assignedAt])
}
```

#### 2. Modify `TeamMember` Model

```prisma
model TeamMember {
  // ... existing fields ...
  
  // NEW relation
  orderTypes        TeamMemberOrderType[] @relation("orderTypes")
  
  // ... rest of model ...
}
```

#### 3. New Table: `RoundRobinState` (For Round-Robin Tracking)

```prisma
model RoundRobinState {
  id                String      @id @default(cuid())
  
  // Scope
  orderType         OrderType   // Which order type this tracks
  
  // Round-robin pointer
  lastAssignedMemberId Int?     // NULL or member ID
  lastUpdatedAt     DateTime    @updatedAt
  
  // Metadata
  createdAt         DateTime    @default(now())
  
  // Constraints
  @@unique([orderType])
  @@index([orderType])
}
```

**Rationale for Round-Robin State Table:**
- Persists across server restarts (unlike in-memory)
- Queryable for debugging
- Better than Redis (no external dependency)
- Simple and maintainable

### Migration Script

```sql
-- Create TeamMemberOrderType table
CREATE TABLE "TeamMemberOrderType" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "teamMemberId" INTEGER NOT NULL,
  "orderType" TEXT NOT NULL,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "assignedBy" INTEGER,
  FOREIGN KEY ("teamMemberId") REFERENCES "TeamMember"("id") ON DELETE CASCADE,
  UNIQUE ("teamMemberId", "orderType")
);

-- Create indexes
CREATE INDEX "TeamMemberOrderType_teamMemberId_idx" ON "TeamMemberOrderType"("teamMemberId");
CREATE INDEX "TeamMemberOrderType_orderType_idx" ON "TeamMemberOrderType"("orderType");
CREATE INDEX "TeamMemberOrderType_assignedAt_idx" ON "TeamMemberOrderType"("assignedAt");

-- Create RoundRobinState table
CREATE TABLE "RoundRobinState" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orderType" TEXT NOT NULL UNIQUE,
  "lastAssignedMemberId" INTEGER,
  "lastUpdatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create index
CREATE INDEX "RoundRobinState_orderType_idx" ON "RoundRobinState"("orderType");
```

### Prisma Migration Command

```bash
npx prisma migrate dev --name add_order_type_assignments
```

---

## API Specifications

### 1. GET /api/team - Enhanced Response

**Endpoint**: `GET /api/team?storeId=1&role=OPS_AGENT&page=1&pageSize=25`

**Query Parameters**:
- `storeId` (optional): Filter by store
- `role` (optional): Filter by role
- `page` (default: 1): Pagination
- `pageSize` (default: 25): Items per page

**Response** (200 OK):
```json
{
  "team": [
    {
      "id": 15,
      "userId": 100,
      "name": "John Doe",
      "email": "john@example.com",
      "role": "OPS_AGENT",
      "storeId": 1,
      "storeName": "Store 1",
      "maxConcurrentTasks": 5,
      "isActive": true,
      "createdAt": "2026-04-01T10:00:00Z",
      
      "orderTypes": [
        {
          "orderType": "HOME_SAMPLE",
          "assignedAt": "2026-04-01T10:00:00Z"
        },
        {
          "orderType": "CENTER_VISIT",
          "assignedAt": "2026-03-15T10:00:00Z"
        }
      ],
      "orderTypeCount": 2,
      
      "skills": [
        { "id": 7, "name": "CAMP", "label": "CAMP" },
        { "id": 8, "name": "CENTER_VISIT", "label": "Center Visit" }
      ],
      "skillCount": 2,
      
      "stores": [1, 2],
      "storeCount": 2,
      
      "currentLoad": 3,
      "taskStats": {
        "thisMonth": {
          "assigned": 25,
          "completed": 24,
          "slaCompliance": 96.8
        },
        "thisWeek": {
          "assigned": 5,
          "completed": 5,
          "slaCompliance": 100
        }
      },
      
      "rosterStatus": "ACTIVE",
      "rosterUpdatedAt": "2026-05-03T09:00:00Z"
    },
    // ... more members
  ],
  "pagination": {
    "page": 1,
    "pageSize": 25,
    "total": 150,
    "totalPages": 6
  }
}
```

**Implementation Notes**:
- `orderTypes`: New field, array of assigned order types
- `taskStats`: Aggregate Task table by assignedToId
- Include both month and week stats
- Calculate SLA compliance: (tasksCompleted / tasksAssigned) * 100

---

### 2. GET /api/team/[id]/order-types

**Endpoint**: `GET /api/team/15/order-types`

**Response** (200 OK):
```json
{
  "teamMemberId": 15,
  "memberName": "John Doe",
  "orderTypes": [
    {
      "orderType": "HOME_SAMPLE",
      "assignedAt": "2026-04-01T10:00:00Z",
      "assignedBy": 42
    },
    {
      "orderType": "CENTER_VISIT",
      "assignedAt": "2026-03-15T10:00:00Z",
      "assignedBy": 42
    }
  ]
}
```

**Error Responses**:
```json
// 404 - Member not found
{ "error": "Team member not found", "code": "MEMBER_NOT_FOUND" }

// 403 - Insufficient permissions
{ "error": "Not authorized to view this member", "code": "FORBIDDEN" }
```

**Implementation Notes**:
- Check user has OPS_HEAD role
- If STORE_ADMIN, verify user and member are in same store
- Query: `TeamMemberOrderType.findMany({ where: { teamMemberId } })`

---

### 3. POST /api/team/[id]/order-types

**Endpoint**: `POST /api/team/15/order-types`

**Request Body**:
```json
{
  "orderType": "HOME_SAMPLE"
}
```

**Response** (201 Created):
```json
{
  "id": 42,
  "teamMemberId": 15,
  "memberName": "John Doe",
  "orderType": "HOME_SAMPLE",
  "assignedAt": "2026-05-03T10:30:00Z",
  "assignedBy": 42
}
```

**Error Responses**:
```json
// 400 - Invalid order type
{
  "error": "Invalid order type",
  "code": "INVALID_ORDER_TYPE",
  "details": {
    "validTypes": ["HOME_SAMPLE", "CENTER_VISIT", "INJECTION"],
    "provided": "INVALID_TYPE"
  }
}

// 409 - Already assigned
{
  "error": "Order type already assigned to this member",
  "code": "DUPLICATE_ASSIGNMENT",
  "details": {
    "teamMemberId": 15,
    "orderType": "HOME_SAMPLE",
    "assignedAt": "2026-04-01T10:00:00Z"
  }
}

// 404 - Member not found
{ "error": "Team member not found", "code": "MEMBER_NOT_FOUND" }

// 403 - Insufficient permissions
{ "error": "Not authorized", "code": "FORBIDDEN" }
```

**Implementation Notes**:
- Validate orderType against enum (HOME_SAMPLE, CENTER_VISIT, INJECTION)
- Check unique constraint: (teamMemberId, orderType)
- Use upsert or handle constraint error
- Set assignedBy = current user ID
- Return 201 Created with full object

---

### 4. DELETE /api/team/[id]/order-types/[orderType]

**Endpoint**: `DELETE /api/team/15/order-types/HOME_SAMPLE`

**Response** (204 No Content)
```
(empty body)
```

**Error Responses**:
```json
// 404 - Assignment not found
{
  "error": "Order type assignment not found",
  "code": "ASSIGNMENT_NOT_FOUND"
}

// 404 - Member not found
{ "error": "Team member not found", "code": "MEMBER_NOT_FOUND" }

// 403 - Insufficient permissions
{ "error": "Not authorized", "code": "FORBIDDEN" }
```

**Implementation Notes**:
- Check assignment exists before deleting
- Return 204 No Content (no body)
- Use deleteUnique or deleteMany with where clause

---

### 5. GET /api/order-types

**Endpoint**: `GET /api/order-types`

**Response** (200 OK):
```json
{
  "orderTypes": [
    {
      "id": 1,
      "name": "HOME_SAMPLE",
      "label": "Home Sample",
      "description": "Sample collection at home"
    },
    {
      "id": 2,
      "name": "CENTER_VISIT",
      "label": "Center Visit",
      "description": "Visit to center"
    },
    {
      "id": 3,
      "name": "INJECTION",
      "label": "Injection",
      "description": "Injection service"
    }
  ]
}
```

**Implementation Notes**:
- Don't query database, hardcode or map from enum
- These are immutable (defined in Prisma schema)
- Could cache response indefinitely
- No authentication required (public info)

---

### 6. GET /api/team/[id]/performance

**Endpoint**: `GET /api/team/15/performance?period=month`

**Query Parameters**:
- `period` (default: "month"): "week" | "month" | "alltime"

**Response** (200 OK):
```json
{
  "teamMemberId": 15,
  "memberName": "John Doe",
  "period": "month",
  "stats": {
    "tasksAssigned": 25,
    "tasksCompleted": 24,
    "tasksCancelled": 1,
    "slaBreaches": 1,
    "slaCompliancePercent": 96,
    "avgCompletionTimeMinutes": 138,
    "avgCompletionTimeHours": "2h 18m",
    "completionRate": 96
  }
}
```

**Implementation Notes**:
- Calculate based on Task table
- Filter: `assignedToId = memberId AND createdAt >= startDate`
- SLA breaches: Tasks where `completedAt > slaDeadline`
- Avg time: Average of `(completedAt - assignedAt)` in minutes
- Return both raw minutes and formatted string

---

## Assignment Engine Algorithm

### Updated `pickAssignee()` Function

**Current Location**: `/src/lib/engine/taskCreator.ts:231-280`

**New Signature**:
```typescript
async function pickAssignee(
  orderType: OrderType,      // NEW: Which order type is needed
  skillIds: number[],         // Required skills
  storeId: number            // Store scope
): Promise<number | null>
```

**Algorithm Pseudocode**:

```
FUNCTION pickAssignee(orderType, skillIds, storeId):
  
  // Step 1: Check if this order type has any allocations
  allocationsExist = await checkOrderTypeAllocations(orderType)
  
  // Step 2: Get all roster entries for today
  todayRosters = await getDailyRoster(today)
  
  // Step 3: Get all team members with required skills and store
  candidates = await db.user.findMany({
    where: {
      role: OPS_AGENT,
      teamMember: {
        isActive: true,
        skills: { some: { skillId: { in: skillIds } } },
        storeAssignments: { some: { storeId: storeId } }
      }
    },
    include: {
      teamMember: {
        include: {
          orderTypes: true,
          dailyRosters: { where: { date: today } }
        }
      },
      assignedTasks: { where: { status: { not_in: [COMPLETED, CANCELLED] } } }
    }
  })
  
  // Step 4: Filter by roster status (ACTIVE, ON_FIELD)
  eligible = candidates.filter(user => {
    roster = user.teamMember.dailyRosters[0]
    if (!roster) return false  // No roster entry = not available
    return roster.status in [ACTIVE, ON_FIELD]
  })
  
  // Step 5: Filter by order type allocation (if allocations exist)
  if (allocationsExist) {
    eligible = eligible.filter(user => {
      return user.teamMember.orderTypes.some(ot => ot.orderType === orderType)
    })
  }
  
  // Step 6: If no eligible members
  if (eligible.length === 0) {
    log.warn(`No eligible members for orderType=${orderType}, skills=${skillIds}`)
    return null
  }
  
  // Step 7: Group by current load
  loadGroups = group(eligible, user => user.assignedTasks.length)
  minLoad = min(loadGroups.keys())
  minLoadMembers = loadGroups[minLoad]
  
  // Step 8: Apply round-robin tiebreaker if multiple at min load
  if (minLoadMembers.length > 1) {
    selected = applyRoundRobin(orderType, minLoadMembers)
  } else {
    selected = minLoadMembers[0]
  }
  
  // Step 9: Update round-robin state
  if (minLoadMembers.length > 1) {
    updateRoundRobinState(orderType, selected.id)
  }
  
  return selected.id

FUNCTION applyRoundRobin(orderType, candidates):
  // Get current round-robin state
  state = await db.roundRobinState.findUnique({
    where: { orderType: orderType }
  })
  
  // Get list of candidate IDs
  candidateIds = candidates.map(c => c.id)
  
  // Find next in rotation
  if (!state) {
    // First time - create state and return first candidate
    await db.roundRobinState.create({
      data: {
        orderType: orderType,
        lastAssignedMemberId: candidateIds[0]
      }
    })
    return candidates[0]
  }
  
  // Find current member's position
  currentIndex = candidateIds.indexOf(state.lastAssignedMemberId)
  
  // If current member not in list, start at 0
  if (currentIndex === -1) {
    nextIndex = 0
  } else {
    // Move to next
    nextIndex = (currentIndex + 1) % candidateIds.length
  }
  
  return candidates[nextIndex]

FUNCTION checkOrderTypeAllocations(orderType):
  count = await db.teamMemberOrderType.count({
    where: { orderType: orderType }
  })
  return count > 0
```

**Key Design Decisions**:

1. **Order Type Filtering**:
   - If allocations exist for an order type, ONLY assign to members with that order type
   - If no allocations exist, assign to any qualified member (backward compatible)

2. **Round-Robin Implementation**:
   - Uses database table for persistence
   - Scoped per order type
   - Rotates through members at minimum load
   - Handles member deletion gracefully (not found → restart rotation)

3. **Load Balancing Priority**:
   - Primary: Minimum current task count
   - Secondary: Round-robin among tied members

4. **Roster Status Check**:
   - Only ACTIVE or ON_FIELD status eligible
   - ON_LEAVE, OFF status skipped
   - No roster entry = not available (for safety)

---

## Implementation Sequence

### Week 1: Database & APIs

#### Day 1-2: Database Schema
**Owner**: Mayur (with DB review)

- [ ] Update `/prisma/schema.prisma`:
  - Add `TeamMemberOrderType` model
  - Add relation to `TeamMember`
  - Add `RoundRobinState` model
  
- [ ] Create migration:
  ```bash
  npx prisma migrate dev --name add_order_type_assignments
  ```
  
- [ ] Verify migration creates:
  - `team_member_order_types` table with indexes
  - `round_robin_state` table
  - Unique constraint on (teamMemberId, orderType)

- [ ] Test: Run migration locally, verify tables exist
  ```sql
  SELECT * FROM "TeamMemberOrderType" LIMIT 0;
  SELECT * FROM "RoundRobinState" LIMIT 0;
  ```

**Acceptance Criteria**:
- Tables created successfully
- Indexes present
- Prisma client regenerates without errors
- Migration reversible

---

#### Day 3: Type Definitions
**Owner**: Mayur

- [ ] Update `/src/types/index.ts`:
  ```typescript
  // Add these interfaces
  interface TeamMemberOrderType {
    id: number;
    teamMemberId: number;
    orderType: OrderType;
    assignedAt: Date;
    assignedBy?: number;
  }
  
  interface TeamMemberWithOrderTypes extends TeamMember {
    orderTypes: TeamMemberOrderType[];
  }
  
  interface MemberPerformanceStats {
    teamMemberId: number;
    memberName: string;
    period: "week" | "month" | "alltime";
    tasksAssigned: number;
    tasksCompleted: number;
    tasksCancelled: number;
    slaBreaches: number;
    slaCompliancePercent: number;
    avgCompletionTimeMinutes: number;
  }
  
  interface OrderTypeOption {
    id: number;
    name: OrderType;
    label: string;
    description: string;
  }
  ```

**Acceptance Criteria**:
- TypeScript compiles without errors
- All new types exported from index
- No breaking changes to existing types

---

#### Days 4-5: API Endpoints - GET /api/team (Enhanced)
**Owner**: Mayur

- [ ] Modify `/src/app/api/team/route.ts` (GET handler)
  - Keep existing filters (storeId, role, page, pageSize)
  - Add order type data to response
  - Add task statistics
  
- [ ] Implementation:
  ```typescript
  // For each team member, query:
  // 1. orderTypes from TeamMemberOrderType
  // 2. taskStats aggregation from Task table
  // 3. rosterStatus from DailyRoster
  
  const members = await db.teamMember.findMany({
    include: {
      user: true,
      orderTypes: true,  // NEW
      dailyRosters: { where: { date: today } },
      assignedTasks: { where: { status: { not: ["COMPLETED", "CANCELLED"] } } }
    }
  });
  
  // For each member, calculate:
  const stats = await calculateMemberStats(member.userId, "month");
  ```

- [ ] Test with Postman:
  - GET /api/team?page=1
  - Verify orderTypes in response
  - Verify stats calculated correctly

**Acceptance Criteria**:
- Returns 200 OK
- Includes orderTypes array for each member
- Includes taskStats (assigned, completed, slaCompliance)
- Performance: <500ms for 25 members
- Pagination works

---

#### Days 6-7: API Endpoints - Order Type CRUD
**Owner**: Mayur

**Endpoints to create**:

1. **GET /api/team/[id]/order-types**
   ```typescript
   // File: /src/app/api/team/[id]/order-types/route.ts
   // Handler: GET
   
   export async function GET(
     request: NextRequest,
     { params }: { params: { id: string } }
   ) {
     const memberId = parseInt(params.id);
     
     // 1. Check member exists
     // 2. Check permissions (OPS_HEAD or same store)
     // 3. Query TeamMemberOrderType
     // 4. Return ordered by assignedAt DESC
   }
   ```

2. **POST /api/team/[id]/order-types**
   ```typescript
   // Handler: POST
   // Validate orderType is valid enum
   // Check unique constraint
   // Create and return
   ```

3. **DELETE /api/team/[id]/order-types/[orderType]**
   ```typescript
   // Handler: DELETE
   // Validate member exists
   // Delete and return 204
   ```

4. **GET /api/order-types**
   ```typescript
   // File: /src/app/api/order-types/route.ts
   // Handler: GET
   // Return hardcoded order type list
   ```

- [ ] Test each endpoint:
  - Create, read, delete operations
  - Error cases (duplicate, invalid, not found)
  - Permission checks
  - Validation

**Acceptance Criteria**:
- All 4 endpoints implemented
- Correct status codes (200, 201, 204, 400, 404, 409)
- Proper error messages
- Input validation
- Permission checks working

---

### Week 2: Assignment Logic & Performance

#### Day 8-9: Implement `getMemberStats()` Query
**Owner**: Mayur

- [ ] Create `/src/lib/performance.ts`:
  ```typescript
  export async function getMemberStats(
    memberId: number,
    period: "week" | "month" | "alltime"
  ): Promise<MemberPerformanceStats> {
    // 1. Calculate date range based on period
    // 2. Query Task table with filters
    // 3. Count: assigned, completed, cancelled
    // 4. Calculate SLA compliance
    // 5. Calculate average completion time
    // 6. Return formatted stats
  }
  ```

- [ ] Implementation logic:
  ```sql
  SELECT
    COUNT(*) as tasksAssigned,
    COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as tasksCompleted,
    COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as tasksCancelled,
    COUNT(CASE WHEN completedAt > slaDeadline THEN 1 END) as slaBreaches,
    AVG(EXTRACT(EPOCH FROM (completedAt - assignedAt)) / 60) as avgCompletionTime
  FROM "Task"
  WHERE "assignedToId" = $1
    AND "createdAt" >= $2
    AND status IN ('COMPLETED', 'CANCELLED')
  ```

- [ ] Create `/src/app/api/team/[id]/performance/route.ts` (GET handler)

- [ ] Test:
  - Verify calculations for known data
  - Test different periods (week, month, alltime)
  - Performance: <200ms query

**Acceptance Criteria**:
- Stats calculated correctly
- All fields populated
- Handles edge cases (no tasks, no SLA breaches)
- Query performance acceptable

---

#### Days 10-12: Update Assignment Logic in taskCreator
**Owner**: Mayur

- [ ] Backup current version: `/src/lib/engine/taskCreator.ts.bak`

- [ ] Modify `pickAssignee()` function:
  ```typescript
  // OLD signature:
  // async function pickAssignee(skillIds: number[], storeId: number)
  
  // NEW signature:
  async function pickAssignee(
    orderType: OrderType,
    skillIds: number[],
    storeId: number
  ): Promise<number | null>
  ```

- [ ] Implement full algorithm from pseudocode above:
  - Order type allocation check
  - Eligibility filtering (skills, store, roster)
  - Load balancing
  - Round-robin for ties

- [ ] Implement helper functions:
  ```typescript
  async function checkOrderTypeAllocations(orderType: OrderType): Promise<boolean>
  async function applyRoundRobin(orderType: OrderType, candidates: User[]): Promise<User>
  async function updateRoundRobinState(orderType: OrderType, memberId: number): Promise<void>
  ```

- [ ] Update all calls to `pickAssignee()`:
  - Line ~307 in taskCreator: Add `rule.orderType` parameter
  - Verify function is called correctly in evaluation loop

- [ ] Test with real data:
  - Create test rule with ORDER TYPE
  - Create test members with ORDER TYPE assignments
  - Run poller, verify correct assignment
  - Verify round-robin rotates through tied members

**Acceptance Criteria**:
- Order type filtering works
- Round-robin implemented and persistent
- Backward compatible (unallocated members still get tasks)
- Assignment logic produces correct member selection
- Poller runs without errors
- No performance regression

---

### Week 3: Frontend & Integration

#### Days 13-14: Add Order Type Handling to TeamPanel
**Owner**: Mayur

- [ ] Modify `/src/components/head/TeamPanel.tsx`:
  - In team member card/row: Add order type count display
  - Show assigned order types as chips/badges
  
- [ ] In edit drawer for member:
  - Add section: "Order Types Can Handle"
  - Show list of assigned order types with Remove button
  - Add "+ Assign Order Type" button

- [ ] Create `/src/components/head/OrderTypeAssignmentModal.tsx`:
  ```typescript
  interface OrderTypeAssignmentModalProps {
    memberId: number;
    currentOrderTypes: OrderType[];
    onClose: () => void;
    onSave: (orderTypes: OrderType[]) => void;
  }
  ```
  - Show all available order types as checkboxes
  - Pre-check assigned ones
  - On submit: Call API to add/remove

- [ ] Implement API calls:
  - POST /api/team/[id]/order-types for new assignments
  - DELETE /api/team/[id]/order-types/[orderType] for removals
  - Use React Query or fetch for state management

- [ ] Test:
  - Assign order type to member
  - Remove order type
  - Update reflects in member card
  - Error handling for API failures

**Acceptance Criteria**:
- UI shows order types for each member
- Can assign/remove order types
- Changes persist to database
- No console errors
- Responsive on mobile

---

#### Day 15: Add Performance Metrics Display
**Owner**: Mayur

- [ ] Modify `/src/components/head/TeamPanel.tsx` or create new component:
  - In member card: Add performance stats
    - Tasks assigned this month
    - Tasks completed this month
    - SLA compliance %
    - Avg completion time (e.g., "2h 18m")

- [ ] Add hover tooltip or expandable section:
  - Show both monthly and weekly stats
  - Show breakdown (completed vs cancelled)

- [ ] Create `/src/components/shared/PerformanceMetrics.tsx`:
  ```typescript
  interface PerformanceMetricsProps {
    memberId: number;
    period?: "week" | "month";
  }
  ```
  - Calls GET /api/team/[id]/performance
  - Displays formatted stats
  - Shows loading state
  - Handles errors gracefully

- [ ] Test:
  - Stats display correctly
  - Period selector works
  - Loading/error states

**Acceptance Criteria**:
- Performance stats visible for each member
- Calculations match backend
- UI updates when stats change
- Performance acceptable (<1s load time)

---

#### Days 16-17: Integration Testing
**Owner**: Mayur

- [ ] End-to-end tests:
  - Create team member
  - Assign order type
  - Create task rule with that order type
  - Run poller
  - Verify task assigned to correct member

- [ ] Test round-robin:
  - Create 3 members, assign same order type
  - Create 3 tasks with that order type
  - Verify distributed: member1, member2, member3, member1, ...

- [ ] Test backward compatibility:
  - Disable order type allocations (remove all)
  - Create task
  - Verify still assigns to any eligible member

- [ ] Manual testing:
  - Full user workflow:
    1. Add team member
    2. Assign order types
    3. View performance
    4. Edit/remove assignments

**Acceptance Criteria**:
- No console errors or warnings
- All workflows complete successfully
- Database state consistent
- Performance metrics accurate

---

### Week 4: Testing & Deployment

#### Days 18-19: Unit Tests
**Owner**: Mayur (with QA)

Test files to create:
- [ ] `/src/lib/engine/__tests__/pickAssignee.test.ts`
- [ ] `/src/lib/__tests__/performance.test.ts`
- [ ] `/src/app/api/team/__tests__/order-types.test.ts`

(See Test Cases section below for detailed test cases)

---

#### Days 20-21: QA Testing
**Owner**: QA Team

(See Test Cases section below)

---

#### Day 22: Deployment Preparation
**Owner**: Mayur + DevOps

- [ ] Code review
- [ ] Performance testing
- [ ] Security review
- [ ] Documentation
- [ ] Deploy to staging
- [ ] Production deployment plan

---

## Code Examples

### Example 1: Updated pickAssignee() Implementation

```typescript
// File: /src/lib/engine/taskCreator.ts

async function pickAssignee(
  orderType: OrderType,
  skillIds: number[],
  storeId: number
): Promise<number | null> {
  try {
    // Step 1: Check if order type allocations exist
    const allocationsExist = await checkOrderTypeAllocations(orderType);

    // Step 2: Get today's date
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Step 3: Query eligible members
    const candidates = await prisma.user.findMany({
      where: {
        role: "OPS_AGENT",
        isActive: true,
        teamMember: {
          isActive: true,
          // Required skills filter
          skills: {
            every: {
              skillId: { in: skillIds },
            },
          },
          // Store filter
          storeAssignments: {
            some: {
              storeId: storeId,
            },
          },
        },
      },
      include: {
        teamMember: {
          include: {
            orderTypes: true,
            dailyRosters: {
              where: { date: today },
              select: { status: true },
            },
          },
        },
        _count: {
          select: {
            assignedTasks: {
              where: {
                status: { notIn: ["COMPLETED", "CANCELLED"] },
              },
            },
          },
        },
      },
    });

    // Step 4: Filter by roster status
    let eligible = candidates.filter((user) => {
      const roster = user.teamMember?.dailyRosters?.[0];
      if (!roster) return false; // No roster entry = not available
      return ["ACTIVE", "ON_FIELD"].includes(roster.status);
    });

    // Step 5: Filter by order type allocation (if allocations exist)
    if (allocationsExist) {
      eligible = eligible.filter((user) => {
        return user.teamMember?.orderTypes?.some(
          (ot) => ot.orderType === orderType
        );
      });
    }

    // Step 6: If no eligible members, log and return null
    if (eligible.length === 0) {
      logger.warn(
        `No eligible members for orderType=${orderType}, skills=${skillIds.join(",")}`,
        { orderType, skillIds, storeId }
      );
      return null;
    }

    // Step 7: Group by current load
    const byLoad = new Map<number, typeof eligible>();
    for (const member of eligible) {
      const load = member._count.assignedTasks;
      if (!byLoad.has(load)) {
        byLoad.set(load, []);
      }
      byLoad.get(load)!.push(member);
    }

    // Get minimum load
    const minLoad = Math.min(...Array.from(byLoad.keys()));
    const minLoadMembers = byLoad.get(minLoad)!;

    // Step 8: Apply round-robin if multiple at min load
    let selected: typeof eligible[0];
    if (minLoadMembers.length > 1) {
      selected = await applyRoundRobin(orderType, minLoadMembers);
    } else {
      selected = minLoadMembers[0];
    }

    // Step 9: Update round-robin state if we used round-robin
    if (minLoadMembers.length > 1) {
      await updateRoundRobinState(orderType, selected.id);
    }

    logger.info(`Task assigned to member ${selected.id} (load: ${minLoad})`, {
      orderType,
      memberId: selected.id,
      currentLoad: minLoad,
      totalCandidates: eligible.length,
      usedRoundRobin: minLoadMembers.length > 1,
    });

    return selected.id;
  } catch (error) {
    logger.error(`Error in pickAssignee: ${error.message}`, {
      error,
      orderType,
      skillIds,
      storeId,
    });
    return null;
  }
}

// Helper: Check if order type has allocations
async function checkOrderTypeAllocations(
  orderType: OrderType
): Promise<boolean> {
  const count = await prisma.teamMemberOrderType.count({
    where: { orderType },
  });
  return count > 0;
}

// Helper: Apply round-robin logic
async function applyRoundRobin(
  orderType: OrderType,
  candidates: Array<{id: number; teamMember: {userId: number}}>
): Promise<typeof candidates[0]> {
  // Get current round-robin state
  let state = await prisma.roundRobinState.findUnique({
    where: { orderType },
  });

  const candidateIds = candidates.map((c) => c.id);

  // If no state, create it and return first candidate
  if (!state) {
    await prisma.roundRobinState.create({
      data: {
        orderType,
        lastAssignedMemberId: candidateIds[0],
      },
    });
    return candidates[0];
  }

  // Find next in rotation
  const currentIndex = candidateIds.indexOf(state.lastAssignedMemberId || -1);
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % candidateIds.length;

  return candidates[nextIndex];
}

// Helper: Update round-robin state
async function updateRoundRobinState(
  orderType: OrderType,
  memberId: number
): Promise<void> {
  await prisma.roundRobinState.upsert({
    where: { orderType },
    update: {
      lastAssignedMemberId: memberId,
      lastUpdatedAt: new Date(),
    },
    create: {
      orderType,
      lastAssignedMemberId: memberId,
    },
  });
}
```

### Example 2: Performance Stats Query

```typescript
// File: /src/lib/performance.ts

import { prisma } from "@/lib/db/client";
import { MemberPerformanceStats } from "@/types";

export async function getMemberStats(
  memberId: number,
  period: "week" | "month" | "alltime" = "month"
): Promise<MemberPerformanceStats | null> {
  // Get team member
  const teamMember = await prisma.teamMember.findUnique({
    where: { id: memberId },
    include: { user: true },
  });

  if (!teamMember) {
    return null;
  }

  // Calculate date range
  const now = new Date();
  const startDate = new Date();

  if (period === "week") {
    startDate.setDate(now.getDate() - 7);
  } else if (period === "month") {
    startDate.setMonth(now.getMonth() - 1);
  } else {
    startDate.setFullYear(1900); // All time
  }

  // Query tasks
  const tasks = await prisma.task.findMany({
    where: {
      assignedToId: teamMember.userId,
      createdAt: { gte: startDate },
    },
    select: {
      status: true,
      completedAt: true,
      assignedAt: true,
      slaDeadline: true,
    },
  });

  // Calculate stats
  const completed = tasks.filter((t) => t.status === "COMPLETED");
  const cancelled = tasks.filter((t) => t.status === "CANCELLED");
  const assigned = tasks.length;

  let slaBreaches = 0;
  let totalCompletionTimeMs = 0;

  for (const task of completed) {
    if (task.completedAt && task.slaDeadline) {
      if (task.completedAt > task.slaDeadline) {
        slaBreaches++;
      }
      if (task.assignedAt) {
        totalCompletionTimeMs += 
          task.completedAt.getTime() - task.assignedAt.getTime();
      }
    }
  }

  const avgCompletionTimeMinutes =
    completed.length > 0 ? totalCompletionTimeMs / completed.length / (1000 * 60) : 0;

  const slaCompliancePercent =
    completed.length > 0 ? ((completed.length - slaBreaches) / completed.length) * 100 : 0;

  return {
    teamMemberId: memberId,
    memberName: teamMember.user.name,
    period,
    tasksAssigned: assigned,
    tasksCompleted: completed.length,
    tasksCancelled: cancelled.length,
    slaBreaches,
    slaCompliancePercent: Math.round(slaCompliancePercent * 10) / 10,
    avgCompletionTimeMinutes: Math.round(avgCompletionTimeMinutes * 10) / 10,
  };
}

// Batch stats for multiple members
export async function getTeamStats(
  memberIds: number[],
  period: "week" | "month" | "alltime" = "month"
): Promise<MemberPerformanceStats[]> {
  const stats: MemberPerformanceStats[] = [];

  for (const memberId of memberIds) {
    const stat = await getMemberStats(memberId, period);
    if (stat) stats.push(stat);
  }

  return stats;
}
```

### Example 3: API Endpoint - POST Order Type

```typescript
// File: /src/app/api/team/[id]/order-types/route.ts

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole, OrderType } from "@/types";

// Valid order types
const VALID_ORDER_TYPES = ["HOME_SAMPLE", "CENTER_VISIT", "INJECTION"];

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getSessionFromRequest(request);
    if (!session) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const memberId = parseInt(params.id);

    // Get member with user
    const member = await prisma.teamMember.findUnique({
      where: { id: memberId },
      include: { user: true, orderTypes: true },
    });

    if (!member) {
      return NextResponse.json(
        { error: "Team member not found", code: "MEMBER_NOT_FOUND" },
        { status: 404 }
      );
    }

    // Permission check
    if (session.role === "STORE_ADMIN") {
      // STORE_ADMIN can only view members in their store
      const isInStore = await prisma.storeAssignment.findFirst({
        where: {
          teamMemberId: memberId,
          storeId: session.storeId,
        },
      });
      if (!isInStore) {
        return NextResponse.json(
          { error: "Not authorized to view this member", code: "FORBIDDEN" },
          { status: 403 }
        );
      }
    } else if (session.role !== "OPS_HEAD") {
      return NextResponse.json(
        { error: "Not authorized", code: "FORBIDDEN" },
        { status: 403 }
      );
    }

    return NextResponse.json({
      teamMemberId: member.id,
      memberName: member.user.name,
      orderTypes: member.orderTypes.map((ot) => ({
        orderType: ot.orderType,
        assignedAt: ot.assignedAt,
        assignedBy: ot.assignedBy,
      })),
    });
  } catch (error) {
    console.error("GET /api/team/[id]/order-types error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getSessionFromRequest(request);
    if (!session) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const memberId = parseInt(params.id);
    const body = await request.json();
    const { orderType } = body;

    // Validate order type
    if (!orderType || !VALID_ORDER_TYPES.includes(orderType)) {
      return NextResponse.json(
        {
          error: "Invalid order type",
          code: "INVALID_ORDER_TYPE",
          details: {
            validTypes: VALID_ORDER_TYPES,
            provided: orderType,
          },
        },
        { status: 400 }
      );
    }

    // Check member exists
    const member = await prisma.teamMember.findUnique({
      where: { id: memberId },
      include: { user: true },
    });

    if (!member) {
      return NextResponse.json(
        { error: "Team member not found", code: "MEMBER_NOT_FOUND" },
        { status: 404 }
      );
    }

    // Permission check
    if (session.role === "STORE_ADMIN") {
      const isInStore = await prisma.storeAssignment.findFirst({
        where: {
          teamMemberId: memberId,
          storeId: session.storeId,
        },
      });
      if (!isInStore) {
        return NextResponse.json(
          { error: "Not authorized", code: "FORBIDDEN" },
          { status: 403 }
        );
      }
    } else if (session.role !== "OPS_HEAD") {
      return NextResponse.json(
        { error: "Not authorized", code: "FORBIDDEN" },
        { status: 403 }
      );
    }

    // Check duplicate
    const existing = await prisma.teamMemberOrderType.findUnique({
      where: {
        teamMemberId_orderType: {
          teamMemberId: memberId,
          orderType: orderType as OrderType,
        },
      },
    });

    if (existing) {
      return NextResponse.json(
        {
          error: "Order type already assigned to this member",
          code: "DUPLICATE_ASSIGNMENT",
          details: {
            teamMemberId: memberId,
            orderType,
            assignedAt: existing.assignedAt,
          },
        },
        { status: 409 }
      );
    }

    // Create assignment
    const assignment = await prisma.teamMemberOrderType.create({
      data: {
        teamMemberId: memberId,
        orderType: orderType as OrderType,
        assignedBy: session.userId,
      },
    });

    // Log event
    console.log(
      `Member ${member.user.name} assigned to order type ${orderType}`,
      {
        memberId,
        orderType,
        assignedBy: session.userId,
      }
    );

    return NextResponse.json(
      {
        id: assignment.id,
        teamMemberId: assignment.teamMemberId,
        memberName: member.user.name,
        orderType: assignment.orderType,
        assignedAt: assignment.assignedAt,
        assignedBy: assignment.assignedBy,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/team/[id]/order-types error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
```

---

## Test Cases

### Unit Tests: pickAssignee()

**File**: `/src/lib/engine/__tests__/pickAssignee.test.ts`

```typescript
import { pickAssignee } from "@/lib/engine/taskCreator";
import { OrderType, RosterStatus } from "@/types";
import { prisma } from "@/lib/db/client";

describe("pickAssignee", () => {
  let storeId: number;
  let skillIds: number[];
  let memberIds: number[];

  beforeEach(async () => {
    // Setup test data
    // Create store, skills, members with order type assignments
  });

  afterEach(async () => {
    // Cleanup
  });

  describe("Order Type Allocation", () => {
    test("should only assign to members with required order type", async () => {
      // Setup:
      // - Member 1: Has HOME_SAMPLE order type
      // - Member 2: Does NOT have HOME_SAMPLE
      // Both have required skills and are ACTIVE

      const memberId = await pickAssignee(
        OrderType.HOME_SAMPLE,
        skillIds,
        storeId
      );

      // Should pick Member 1 only
      expect(memberId).toBe(memberIds[0]);
    });

    test("should assign to any qualified member if no allocations exist", async () => {
      // Setup:
      // - No members have order type assignments
      // - Multiple members have skills

      const memberId = await pickAssignee(
        OrderType.CENTER_VISIT,
        skillIds,
        storeId
      );

      // Should pick any qualified member
      expect(memberIds).toContain(memberId);
    });

    test("should return null if no members have required order type", async () => {
      // Setup:
      // - Order type allocations exist
      // - But no members have this specific order type

      const memberId = await pickAssignee(
        OrderType.INJECTION,
        skillIds,
        storeId
      );

      expect(memberId).toBeNull();
    });
  });

  describe("Load Balancing", () => {
    test("should assign to member with fewest open tasks", async () => {
      // Setup:
      // - Member 1: 5 open tasks
      // - Member 2: 2 open tasks
      // - Member 3: 2 open tasks
      // All have required order type

      const memberId = await pickAssignee(
        OrderType.HOME_SAMPLE,
        skillIds,
        storeId
      );

      // Should pick Member 2 or 3 (both have 2 tasks)
      expect([memberIds[1], memberIds[2]]).toContain(memberId);
    });

    test("should apply round-robin for tied load", async () => {
      // Setup:
      // - Member 1: 2 open tasks
      // - Member 2: 2 open tasks
      // - Member 3: 2 open tasks

      // First assignment
      let memberId1 = await pickAssignee(
        OrderType.HOME_SAMPLE,
        skillIds,
        storeId
      );

      // Should be one of them
      expect([memberIds[0], memberIds[1], memberIds[2]]).toContain(memberId1);

      // Create dummy task for member1 to ensure load changes
      // Second assignment (within same session)
      let memberId2 = await pickAssignee(
        OrderType.HOME_SAMPLE,
        skillIds,
        storeId
      );

      // Should rotate to different member if round-robin working
      // Note: This test is tricky because load changes after assignment
    });
  });

  describe("Roster Status Filtering", () => {
    test("should only include members with ACTIVE or ON_FIELD status", async () => {
      // Setup:
      // - Member 1: ACTIVE roster status
      // - Member 2: ON_LEAVE roster status
      // - Member 3: ON_FIELD roster status

      const memberId = await pickAssignee(
        OrderType.HOME_SAMPLE,
        skillIds,
        storeId
      );

      // Should pick Member 1 or 3, never Member 2
      expect([memberIds[0], memberIds[2]]).toContain(memberId);
    });

    test("should return null if all members are unavailable", async () => {
      // Setup:
      // - All members have OFF roster status

      const memberId = await pickAssignee(
        OrderType.HOME_SAMPLE,
        skillIds,
        storeId
      );

      expect(memberId).toBeNull();
    });
  });

  describe("Skill Filtering", () => {
    test("should filter members by required skills", async () => {
      // Setup:
      // - Require skills: [7, 8]
      // - Member 1: Has skills 7, 8
      // - Member 2: Has skill 7 only
      // - Member 3: Has skills 7, 8, 9

      const memberId = await pickAssignee(
        OrderType.HOME_SAMPLE,
        [7, 8],
        storeId
      );

      // Should pick Member 1 or 3, never Member 2
      expect([memberIds[0], memberIds[2]]).toContain(memberId);
    });
  });

  describe("Store Filtering", () => {
    test("should only assign members in the specified store", async () => {
      // Setup:
      // - Store 1: Member 1, Member 2
      // - Store 2: Member 3

      const memberId = await pickAssignee(
        OrderType.HOME_SAMPLE,
        skillIds,
        storeId // Store 1
      );

      // Should pick Member 1 or 2, never Member 3
      expect([memberIds[0], memberIds[1]]).toContain(memberId);
    });
  });

  describe("Error Handling", () => {
    test("should return null if no candidates meet all criteria", async () => {
      // Setup: All members fail one or more filters

      const memberId = await pickAssignee(
        OrderType.HOME_SAMPLE,
        skillIds,
        storeId
      );

      expect(memberId).toBeNull();
    });

    test("should handle database errors gracefully", async () => {
      // Mock Prisma to throw error
      jest.spyOn(prisma.user, "findMany").mockRejectedValueOnce(
        new Error("DB error")
      );

      const memberId = await pickAssignee(
        OrderType.HOME_SAMPLE,
        skillIds,
        storeId
      );

      expect(memberId).toBeNull();
    });
  });
});
```

### Integration Tests: Order Type Assignment Flow

**File**: `/src/__tests__/integration/order-type-assignment.test.ts`

```typescript
describe("Order Type Assignment End-to-End", () => {
  let memberId: number;
  let ruleId: string;
  let orderType: OrderType = OrderType.HOME_SAMPLE;

  beforeEach(async () => {
    // Setup test data
  });

  test("should assign task to member with required order type", async () => {
    // Step 1: Assign order type to member
    const response1 = await fetch(
      `/api/team/${memberId}/order-types`,
      {
        method: "POST",
        body: JSON.stringify({ orderType }),
      }
    );
    expect(response1.status).toBe(201);

    // Step 2: Create task rule with order type
    const response2 = await fetch("/api/task-rules", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Rule",
        orderType,
        triggerType: "STATUS",
        triggerCondition: { statusIn: ["NEW"] },
        taskTypeId: 1,
        slaMinutes: 120,
      }),
    });
    expect(response2.status).toBe(201);
    const rule = await response2.json();
    ruleId = rule.id;

    // Step 3: Simulate order creation (trigger rule evaluation)
    const taskResponse = await fetch("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        orderId: 12345,
        orderType,
        storeId: 1,
      }),
    });

    // Step 4: Verify task assigned to correct member
    const task = await taskResponse.json();
    expect(task.assignedToId).toBe(memberId);
    expect(task.assignmentMethod).toBe("auto");
    expect(task.assignmentRuleId).toBe(ruleId);
  });

  test("should rotate assignment among members with same load", async () => {
    // Step 1: Assign order type to 3 members
    const memberIds = [1, 2, 3];
    for (const mid of memberIds) {
      await fetch(`/api/team/${mid}/order-types`, {
        method: "POST",
        body: JSON.stringify({ orderType }),
      });
    }

    // Step 2: Create 3 tasks
    const taskIds = [];
    for (let i = 0; i < 3; i++) {
      const response = await fetch("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          orderId: 100 + i,
          orderType,
          storeId: 1,
        }),
      });
      const task = await response.json();
      taskIds.push({ id: task.id, assignedTo: task.assignedToId });
    }

    // Step 3: Verify round-robin distribution
    const assignees = taskIds.map((t) => t.assignedTo);
    expect(assignees.length).toBe(3);
    // All three members should be assigned at least once
    expect(new Set(assignees).size).toBe(3);
  });
});
```

### API Tests: GET /api/team

**File**: `/src/app/api/team/__tests__/get.test.ts`

```typescript
describe("GET /api/team", () => {
  test("should return members with order types", async () => {
    const response = await fetch("/api/team");
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.team).toBeArray();
    expect(data.team[0]).toHaveProperty("orderTypes");
    expect(data.team[0].orderTypes).toBeArray();
    expect(data.team[0]).toHaveProperty("orderTypeCount");
  });

  test("should include task statistics", async () => {
    const response = await fetch("/api/team");
    const data = await response.json();

    const member = data.team[0];
    expect(member).toHaveProperty("taskStats");
    expect(member.taskStats).toHaveProperty("thisMonth");
    expect(member.taskStats.thisMonth).toHaveProperty("assigned");
    expect(member.taskStats.thisMonth).toHaveProperty("completed");
    expect(member.taskStats.thisMonth).toHaveProperty("slaCompliance");
  });

  test("should paginate results", async () => {
    const response = await fetch("/api/team?pageSize=10&page=2");
    const data = await response.json();

    expect(data.pagination.pageSize).toBe(10);
    expect(data.pagination.page).toBe(2);
    expect(data.team.length).toBeLessThanOrEqual(10);
  });

  test("should filter by store", async () => {
    const response = await fetch("/api/team?storeId=1");
    const data = await response.json();

    // All members should be in store 1
    for (const member of data.team) {
      expect(member.stores).toContain(1);
    }
  });

  test("should filter by role", async () => {
    const response = await fetch("/api/team?role=OPS_AGENT");
    const data = await response.json();

    // All members should be OPS_AGENT
    for (const member of data.team) {
      expect(member.role).toBe("OPS_AGENT");
    }
  });

  test("should return correct format", async () => {
    const response = await fetch("/api/team");
    const data = await response.json();

    // Verify response schema
    const memberSchema = {
      id: "number",
      userId: "number",
      name: "string",
      email: "string",
      role: "string",
      storeId: "number",
      maxConcurrentTasks: "number",
      orderTypes: "array",
      orderTypeCount: "number",
      skills: "array",
      taskStats: "object",
      rosterStatus: "string",
      currentLoad: "number",
    };

    for (const [key, type] of Object.entries(memberSchema)) {
      expect(data.team[0]).toHaveProperty(key);
      expect(typeof data.team[0][key]).toBe(type);
    }
  });
});
```

---

## Error Handling & Edge Cases

### Edge Case 1: Member Deleted While Round-Robin State References Them

**Scenario**: 
- Round-robin state has `lastAssignedMemberId = 5`
- Member 5 is deleted
- Next assignment tries to find member 5 in round-robin

**Handling**:
```typescript
// In applyRoundRobin():
const currentIndex = candidateIds.indexOf(state.lastAssignedMemberId || -1);
if (currentIndex === -1) {
  // Member not found in candidates, restart rotation
  nextIndex = 0;
} else {
  nextIndex = (currentIndex + 1) % candidateIds.length;
}
```

### Edge Case 2: All Members Deleted for Order Type

**Scenario**:
- Order type allocations exist
- All members with that order type are deleted
- New task tries to assign

**Handling**:
- `pickAssignee()` returns null
- Engine logs warning
- Task stays in CREATED status (not assigned)
- Escalation chain triggered (if configured)

### Edge Case 3: Roster Status Changes During Assignment

**Scenario**:
- Member filtered as ACTIVE
- Status changes to OFF before assignment completes
- Task still assigned to OFF member

**Handling**:
- Check roster status is fresh (not stale)
- Small race condition window acceptable
- Member can manually reassign if needed
- Roster updates are infrequent (daily)

### Edge Case 4: Invalid OrderType in Assignment Call

**Scenario**:
- taskCreator calls `pickAssignee()` with invalid OrderType
- Validation missed

**Handling**:
```typescript
// At start of pickAssignee():
const validOrderTypes = ["HOME_SAMPLE", "CENTER_VISIT", "INJECTION"];
if (!validOrderTypes.includes(orderType)) {
  logger.error(`Invalid orderType: ${orderType}`);
  return null;
}
```

### Edge Case 5: No Allocation Data After Schema Migration

**Scenario**:
- System upgraded with new schema
- No order type allocations created yet
- Tasks still need assignment

**Handling**:
- `checkOrderTypeAllocations()` returns false
- System operates in "flexible mode"
- Assigns to any qualified member
- No breaking changes to existing functionality

---

## Performance Considerations

### Query Optimization

**Indexes Required**:
```sql
-- TeamMemberOrderType
CREATE INDEX idx_team_member_order_types_member_id 
  ON team_member_order_types(team_member_id);
CREATE INDEX idx_team_member_order_types_order_type 
  ON team_member_order_types(order_type);

-- Task table (for stats aggregation)
CREATE INDEX idx_tasks_assigned_to_id_created_at 
  ON tasks(assigned_to_id, created_at);

-- RoundRobinState
CREATE INDEX idx_round_robin_state_order_type 
  ON round_robin_state(order_type);
```

### Expected Performance

| Operation | Query Time | Notes |
|-----------|-----------|-------|
| pickAssignee() | <100ms | Simple queries with indexes |
| GET /api/team (25 members) | <500ms | Includes stats aggregation |
| POST /api/team/[id]/order-types | <50ms | Single insert |
| DELETE /api/team/[id]/order-types | <50ms | Single delete |
| getMemberStats() | <200ms | Group by with indexes |

---

## Monitoring & Logging

### Key Metrics to Track

1. **Assignment Success Rate**
   - % of tasks that get assigned
   - Goal: >98%

2. **Round-Robin Distribution**
   - Verify equal distribution of tasks across tied members
   - Track per order type

3. **Order Type Coverage**
   - % of order types with at least one qualified member
   - Alert if <80%

4. **Member Utilization**
   - Average load per member
   - Identify overloaded members

### Logging Points

```typescript
// In pickAssignee():
- Assignment: "Task assigned to member X (load: Y)"
- No candidates: "No eligible members for orderType=X, skills=Y"
- Errors: Include full context for debugging
- Round-robin: "Using round-robin, selected member X from pool of Y"

// In APIs:
- Order type assignment: "Member X assigned to order type Y by user Z"
- Deletion: "Order type assignment removed: member X, orderType Y"
```

---

## Summary for Mayur

**Total Implementation Effort**: 22 engineering days (3-4 weeks)

**Key Deliverables**:
1. Database schema changes + migration
2. 5 new API endpoints (GET/POST/DELETE for order types, GET for stats, GET for valid types)
3. Modified assignment logic with order type filtering and round-robin
4. UI components for order type assignment
5. Performance metrics display
6. Comprehensive test coverage

**Critical Path**: 
- Days 1-2: Schema
- Days 3-7: APIs (parallel)
- Days 8-12: Assignment logic & stats (parallel)
- Days 13-17: Frontend (parallel)
- Days 18-22: Testing & deployment

**Success Criteria**:
- Order types assigned to members persist and affect task assignments
- Round-robin distributes tasks fairly
- Performance metrics accurate
- All tests pass
- No regressions in existing functionality

You have all specifications, code examples, test cases, and implementation guidance. Start with database schema and APIs in parallel, then integrate assignment logic. Good luck! 🚀

