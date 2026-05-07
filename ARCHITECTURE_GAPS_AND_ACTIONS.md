# Teams Feature - Implementation Gap Analysis & Action Points

**Date**: May 3, 2026  
**For**: Manjul (Tech Architect)  
**Purpose**: Deep architecture design for Teams feature based on current codebase analysis

---

## Executive Summary

The TaskOS system has **80% of the infrastructure** needed for the Teams feature. The core assignment logic, database models, APIs, and UI exist. However, **member→orderType allocation is completely missing**.

**Key Findings:**
- ✅ User and TeamMember models exist
- ✅ OrderType enum defined (HOME_SAMPLE, CENTER_VISIT, INJECTION)
- ✅ Load-balanced task assignment exists
- ✅ Team management APIs and UI exist
- ❌ **Gap**: No way to assign members to specific order types
- ❌ **Gap**: No APIs for managing order type allocations
- ❌ **Gap**: No UI for orderType assignment
- ❌ **Gap**: Assignment logic doesn't filter by member's order types

---

## Current Implementation Details

### Database Models (Prisma Schema)

**User Model** (`/prisma/schema.prisma:70-90`)
```
- id (Int, PK)
- name, email, phone, passwordHash
- role (enum: OPS_HEAD, STORE_ADMIN, OPS_AGENT)
- isActive (Boolean, default: true)
- Relations: teamMember (1:1), assignedTasks (1:n), skills, ruleAudits
```

**TeamMember Model** (`/prisma/schema.prisma:125-140`)
```
- id (Int, PK)
- userId (Int, unique FK to User)
- maxConcurrentTasks (Int, default: 5)
- isActive (Boolean)
- createdAt, updatedAt
- Relations: user (1:1), skills (1:n), storeAssignments (1:n), dailyRosters (1:n), assignedTasks (1:n)
```

**OrderType Enum** (`/prisma/schema.prisma:43-47`)
```
HOME_SAMPLE, CENTER_VISIT, INJECTION
```

**DailyRoster Model** (`/prisma/schema.prisma:176-189`)
```
- id (Int, PK)
- teamMemberId (Int, FK)
- date (Date)
- status (enum: ACTIVE, ON_FIELD, ON_LEAVE, OFF)
- note (String, optional)
- unique constraint: (teamMemberId, date)
```

**Task Model** (relevant fields)
```
- assignedToId (Int, FK to User)
- orderType (OrderType enum)
- status (CREATED, ASSIGNED, IN_PROGRESS, COMPLETED, CANCELLED, ARCHIVED)
- assignmentMethod ("auto" | "manual")
- assignmentRuleId (String, if auto-assigned)
- assignedAt (DateTime)
```

**TaskRule Model** (`/prisma/schema.prisma:230-251`)
```
- id (String, cuid)
- name (String)
- orderType (OrderType - specifies which order type this rule handles)
- triggerType (STATUS or TIME)
- triggerCondition (Json - complex trigger logic)
- requiredSkills (TaskRuleSkill[])
- taskTypeId (Int)
- slaMinutes (Int)
- priority (TaskPriority)
- isActive (Boolean)
```

---

## Gap #1: No Member → OrderType Allocation

### Current State
- Members can have **skills** assigned (TeamMemberSkill model)
- But there's **NO way to assign specific order types** to members
- Assignment logic (`pickAssignee()`) doesn't check member's order type capabilities
- No database table/model for this relationship

### What's Needed
A junction table to map members to order types:

```prisma
model TeamMemberOrderType {
  id                Int         @id @default(autoincrement())
  teamMemberId      Int
  teamMember        TeamMember  @relation("orderTypes", fields: [teamMemberId], references: [id], onDelete: Cascade)
  orderType         OrderType   // HOME_SAMPLE, CENTER_VISIT, INJECTION
  assignedAt        DateTime    @default(now())
  
  @@unique([teamMemberId, orderType])
  @@index([teamMemberId])
  @@index([orderType])
}

// Add this to TeamMember model:
model TeamMember {
  ...existing fields...
  orderTypes        TeamMemberOrderType[] @relation("orderTypes")
}
```

### Action Points for Manjul

**A1.1 - Database Schema Migration**
- [ ] Add `TeamMemberOrderType` model to `/prisma/schema.prisma`
- [ ] Add relation `orderTypes` to `TeamMember` model
- [ ] Create Prisma migration: `npx prisma migrate dev --name add_member_order_types`
- [ ] Document the unique constraint: (teamMemberId, orderType)
- [ ] Plan indexes: one on `teamMemberId` for fast member lookup, one on `orderType` for analytics

---

## Gap #2: Assignment Logic Doesn't Filter by Order Types

### Current State

**Location**: `/src/lib/engine/taskCreator.ts`, lines 231-280

Current `pickAssignee()` function:
```typescript
async function pickAssignee(
  skillIds: number[],
  storeId: number
): Promise<number | null> {
  // Gets all users with required skills
  const eligibleUsers = await db.user.findMany({
    where: {
      teamMember: { skills: { some: { skillId: { in: skillIds } } } },
      storeAssignments: { some: { storeId } }
    },
    include: { assignedTasks: { where: { status: { not: "COMPLETED" } } } }
  });
  
  // Sorts by current load (fewest open tasks) - LOAD BALANCING
  // Returns user with minimum task count
}
```

**Problems with Current Logic:**
1. ✅ Filters by skills (correct)
2. ✅ Filters by store (correct)
3. ✅ Filters by roster status (correct)
4. ✅ Load-balances (picks least busy member)
5. ❌ **Doesn't filter by member's assigned order types**
6. ❌ **No round-robin for ties** (picks first in sorted list)

### What's Needed

Modify assignment logic to:
1. Check if member has the required order type assigned
2. If not, either:
   - Skip that member (if strict allocation is enforced)
   - Still allow assignment (if allocation is optional)
3. Implement round-robin for tied members (same current load)
4. Track which member should get next task (round-robin pointer)

### Action Points for Manjul

**A2.1 - Modify Assignment Logic**
- [ ] Update `pickAssignee()` function signature to include `orderType: OrderType`
- [ ] Add order type filtering:
  ```
  Check if system has ANY member→orderType allocations for this orderType
  If yes: Only consider members with this orderType assigned
  If no: Consider all eligible members (backward compatible)
  ```
- [ ] Add order type validation (ensure it's valid: HOME_SAMPLE, CENTER_VISIT, INJECTION)
- [ ] Location: `/src/lib/engine/taskCreator.ts`, lines 231-280

**A2.2 - Implement Round-Robin for Ties**
- [ ] Identify how to track round-robin state:
  - Option 1: Store in database (RoundRobinState table with lastAssignedMemberId per orderType)
  - Option 2: Store in Redis (faster, requires Redis setup)
  - Option 3: Simple in-memory counter (loses state on restart, okay for MVP)
- [ ] Document decision with reasoning
- [ ] Implement tie-breaking: if two members have same load, pick next in rotation
- [ ] Location: `/src/lib/engine/taskCreator.ts`

**A2.3 - Update Task Creation Flow**
- [ ] Pass `orderType` from rule to `pickAssignee()` function call
- [ ] Line: `/src/lib/engine/taskCreator.ts`, line 307 (where `pickAssignee()` is called)
- [ ] Add error handling if no eligible members for order type
- [ ] Log assignment reason (skill match, load balance, round robin state)

**A2.4 - Backward Compatibility**
- [ ] If no members have order type allocations for a given orderType:
  - System should still work (assign from all eligible members)
  - This allows gradual rollout of order type specialization
- [ ] Document this behavior clearly for operations team

---

## Gap #3: Missing APIs for Order Type Assignment

### Current State

**Existing APIs:**
- `GET /api/team` - List team members with skills (no order types)
- `POST /api/team` - Create member (no order type specification)
- `PATCH /api/team/[id]` - Update member (no order type logic)
- `GET/POST /api/team/[id]/skills` - Skill management (different from order types)

**Missing APIs:**
- ❌ `GET /api/team/[id]/order-types` - Get member's assigned order types
- ❌ `POST /api/team/[id]/order-types` - Assign order type to member
- ❌ `DELETE /api/team/[id]/order-types/[orderType]` - Remove order type
- ❌ `GET /api/order-type-assignments` - List all member→orderType mappings
- ❌ `GET /api/order-types` - List all valid order types
- ❌ Enhanced `GET /api/team` to include orderTypeAssignments

### Action Points for Manjul

**A3.1 - Create API Route: Get Member's Order Types**
- [ ] Create: `/src/app/api/team/[id]/order-types/route.ts` (GET only)
- [ ] Response format:
  ```json
  [
    { orderType: "HOME_SAMPLE", assignedAt: "2026-05-01T10:00:00Z" },
    { orderType: "CENTER_VISIT", assignedAt: "2026-04-15T10:00:00Z" }
  ]
  ```
- [ ] Validation:
  - [ ] Member exists
  - [ ] User has OPS_HEAD role
  - [ ] Member is in same store as user (if STORE_ADMIN)

**A3.2 - Create API Route: Assign Order Type to Member**
- [ ] Create: `/src/app/api/team/[id]/order-types/route.ts` (POST)
- [ ] Request body: `{ orderType: "HOME_SAMPLE" }`
- [ ] Response: `{ teamMemberId, orderType, assignedAt }`
- [ ] Validation:
  - [ ] Member exists
  - [ ] OrderType is valid (HOME_SAMPLE, CENTER_VISIT, INJECTION)
  - [ ] Not already assigned (unique constraint)
  - [ ] User has OPS_HEAD role

**A3.3 - Create API Route: Remove Order Type from Member**
- [ ] Create: `/src/app/api/team/[id]/order-types/[orderType]/route.ts` (DELETE)
- [ ] Response: 204 No Content
- [ ] Validation:
  - [ ] Member exists
  - [ ] OrderType assignment exists
  - [ ] User has OPS_HEAD role

**A3.4 - Create API Route: Get All Valid Order Types**
- [ ] Create: `/src/app/api/order-types/route.ts` (GET)
- [ ] Response:
  ```json
  {
    orderTypes: [
      { id: 1, name: "HOME_SAMPLE", label: "Home Sample" },
      { id: 2, name: "CENTER_VISIT", label: "Center Visit" },
      { id: 3, name: "INJECTION", label: "Injection" }
    ]
  }
  ```
- [ ] Note: These come from the OrderType enum; determine how to expose as JSON

**A3.5 - Enhance GET /api/team Response**
- [ ] Modify: `/src/app/api/team/route.ts` (GET endpoint)
- [ ] Add to each member object: `orderTypes: ["HOME_SAMPLE", "CENTER_VISIT"]`
- [ ] Include count: `orderTypeCount: number`
- [ ] This is the "list view" that shows overview

**A3.6 - Document All APIs**
- [ ] Create `/DOCS/features/teams/API_ENDPOINTS.md`
- [ ] Include request/response examples for each endpoint
- [ ] Include error codes and messages
- [ ] Include role-based access control matrix

---

## Gap #4: Missing UI for Order Type Assignment

### Current State

**Existing UI:**
- `/head/team` - Shows team members in grid (TeamPanel.tsx, 614 lines)
  - Shows skills per member
  - Edit drawer for each member
  - Skill assignment (add/remove)
  - Store assignment
  - Max concurrent tasks
- `/head/rules` - Task rules panel (TaskRulesPanel.tsx, 1084 lines)
  - Shows order type for each rule (but not which members handle it)

**Missing UI:**
- ❌ Section in team member detail showing assigned order types
- ❌ UI to assign/remove order types from members
- ❌ View showing which members handle which order types (matrix view)
- ❌ Dashboard showing order type coverage

### Action Points for Manjul

**A4.1 - Add Order Type Section to Member Detail Drawer**
- [ ] File: `/src/components/head/TeamPanel.tsx`
- [ ] Find: Edit drawer for member (currently shows skills, stores)
- [ ] Add section: "Order Types Can Handle"
  - Display list of assigned order types with Remove button
  - Show "+ Assign New Order Type" button
  - On click, show modal with checkboxes for all available order types
  - Show already-assigned as disabled/checked

**A4.2 - Create Order Type Assignment Modal**
- [ ] Create: `/src/components/head/OrderTypeAssignmentModal.tsx`
- [ ] Shows all valid order types (HOME_SAMPLE, CENTER_VISIT, INJECTION)
- [ ] Checkboxes for each order type
- [ ] Pre-checked for already-assigned order types
- [ ] On submit: POST to `/api/team/[id]/order-types` for each newly-checked
- [ ] On uncheck: DELETE from `/api/team/[id]/order-types/[orderType]` for each unchecked

**A4.3 - Add Member Performance Display**
- [ ] File: `/src/components/head/TeamPanel.tsx` or new component
- [ ] Show for each member:
  - Tasks assigned this month
  - Tasks completed this month
  - SLA compliance % this month
  - Avg completion time
- [ ] Source: Aggregate from Task table with stats
- [ ] Consider pagination for large teams

**A4.4 - Optional: Order Type Coverage Dashboard**
- [ ] New page: `/head/teams/coverage` (optional, Phase 2)
- [ ] Shows which members handle which order types
- [ ] Matrix view: Members × Order Types with checkmarks
- [ ] Color-coded: Green (assigned), Red (not assigned)
- [ ] Shows "coverage gaps" - order types with no members
- [ ] Shows "overloaded" - order types with too few members

**A4.5 - Update Existing Pages**
- [ ] `/head/team` (list page): Add orderType count to member cards
- [ ] `/head/rules` (rules page): Show "can be handled by X members" for each rule
- [ ] Update component props and interfaces as needed

---

## Gap #5: Missing Type Definitions

### Current State

**Location**: `/src/types/index.ts`

Current types include:
- User, TeamMember, Task, TaskRule interfaces
- OrderType enum
- TriggerCondition, MetadataCondition
- TaskStatus, TaskPriority enums

**Missing Types:**
- ❌ TeamMemberOrderType interface
- ❌ OrderTypeAssignment response format
- ❌ Member performance metrics interface

### Action Points for Manjul

**A5.1 - Add Type Definitions**
- [ ] File: `/src/types/index.ts`
- [ ] Add interface:
  ```typescript
  interface TeamMemberOrderType {
    id?: number;
    teamMemberId: number;
    orderType: OrderType;
    assignedAt: DateTime;
  }
  ```
- [ ] Add response interface:
  ```typescript
  interface TeamMemberWithOrderTypes extends TeamMember {
    orderTypes: TeamMemberOrderType[];
    orderTypeCount: number;
  }
  ```
- [ ] Add performance interface:
  ```typescript
  interface MemberPerformanceStats {
    memberId: number;
    tasksAssignedThisMonth: number;
    tasksCompletedThisMonth: number;
    slaCompliancePercent: number;
    avgCompletionTimeHours: number;
  }
  ```

---

## Gap #6: Performance Metrics Query

### Current State

**Location**: No centralized performance query exists

Current queries scattered:
- Task counts in various endpoints
- No aggregation by member and time period

**Needed For Feature:**
- Dashboard showing "assigned, completed, SLA%" per member
- This requires aggregating Task data by assignedToId

### Action Points for Manjul

**A6.1 - Create Performance Metrics Query Function**
- [ ] Create: `/src/lib/performance.ts` (new file)
- [ ] Function: `getMemberStats(memberId: number, period: "week" | "month" | "alltime")`
- [ ] Returns:
  ```typescript
  {
    memberId: number,
    tasksAssigned: number,
    tasksCompleted: number,
    tasksCancelled: number,
    slaBreaches: number,
    slaCompliancePercent: number,
    avgCompletionTimeMinutes: number,
    period: string
  }
  ```
- [ ] Query: Group tasks by `assignedToId`, filter by `createdAt` date range
- [ ] Handle: Null assignments (unassigned tasks)
- [ ] Optimize: Add database indexes if needed on `assignedToId` and `createdAt`

**A6.2 - Create Team-Wide Stats Query**
- [ ] Function: `getTeamStats(teamMembers: number[], period: "week" | "month")`
- [ ] Returns aggregated stats for team
- [ ] Used in TeamPanel for overview

**A6.3 - Add Caching Layer**
- [ ] Consider caching stats (regenerated every 1 hour)
- [ ] Or query on-demand if performance acceptable
- [ ] Document decision

---

## Summary: What Needs to Be Built

| Component | Type | Location | Priority | Effort |
|-----------|------|----------|----------|--------|
| TeamMemberOrderType model | Schema | schema.prisma | P0 | 1 day |
| Prisma migration | DB | prisma/migrations/ | P0 | 1 day |
| Modify pickAssignee() | Logic | taskCreator.ts | P0 | 3 days |
| Round-robin implementation | Logic | taskCreator.ts | P0 | 2 days |
| GET /api/team/[id]/order-types | API | api/team/.../route.ts | P0 | 1 day |
| POST /api/team/[id]/order-types | API | api/team/.../route.ts | P0 | 1 day |
| DELETE /api/team/[id]/order-types | API | api/team/.../route.ts | P0 | 0.5 day |
| GET /api/order-types | API | api/order-types/route.ts | P0 | 0.5 day |
| Enhance GET /api/team | API | api/team/route.ts | P0 | 1 day |
| Type definitions | Types | types/index.ts | P0 | 0.5 day |
| Performance query function | Util | lib/performance.ts | P1 | 1 day |
| Order type section in drawer | UI | components/TeamPanel.tsx | P0 | 2 days |
| Order type assignment modal | UI | components/OrderTypeAssignment... | P0 | 1 day |
| Performance metrics display | UI | components/TeamPanel.tsx | P1 | 1.5 days |
| Order type coverage dashboard | UI | app/(app)/head/teams/coverage | P2 | 2 days |
| API documentation | Docs | DOCS/features/teams/API_ENDPOINTS.md | P0 | 1 day |
| **TOTAL** | | | | **~22 days** |

---

## Recommended Implementation Order

### **Phase A: Foundation** (Days 1-4)
1. Add TeamMemberOrderType model + migration (2 days)
2. Create all APIs (4 days) - can be done in parallel
3. Add type definitions (0.5 days)
4. Total: ~6 days

### **Phase B: Assignment Logic** (Days 5-8)
5. Modify pickAssignee() function (3 days)
6. Implement round-robin (2 days)
7. Update task creation flow (1 day)
8. Total: ~6 days

### **Phase C: Frontend** (Days 9-14)
9. Add UI components to TeamPanel (3 days)
10. Create OrderTypeAssignmentModal (1 day)
11. Add performance metrics display (1.5 days)
12. Total: ~5.5 days

### **Phase D: Polish & Documentation** (Days 15-16)
13. API documentation (1 day)
14. Testing & fixes (1 day)
15. Total: ~2 days

---

## Architecture Decisions Needed from Manjul

1. **Round-Robin State Storage**
   - Database table? Redis? In-memory?
   - Scope: Per orderType or global?

2. **Order Type Allocation: Strict vs Flexible**
   - If member has no order type assignments, should they still receive tasks?
   - Recommendation: Flexible (backward compatible)

3. **Performance Metrics: Real-time vs Cached**
   - Query on-demand or cache?
   - If cache: Invalidation strategy?

4. **OrderType Enum to JSON**
   - How to expose OrderType enum values as JSON API response?
   - Map to database table or hardcode?

5. **Error Handling for Allocation Conflicts**
   - What if rule specifies orderType but no members handle it?
   - Escalate? Skip task? Log?

---

## Next Steps for Manjul

1. **Review** this document and current codebase
2. **Make decisions** on architectural questions above
3. **Create detailed design document** covering:
   - Schema changes with exact SQL
   - API request/response contracts with examples
   - Algorithm for updated pickAssignee() with pseudocode
   - Round-robin state management strategy
   - Error handling and edge cases
   - Data migration strategy (if needed)
4. **Review with dev team** for feasibility feedback
5. **Hand off to implementation team** with clear specs

---

**Document Status**: Ready for Architecture Review  
**Next Owner**: Manjul (Tech Architect)  
**Estimated Architecture Design Time**: 3-5 days

