# Teams Feature - Technical Specification

**Feature**: Comprehensive Team Member Management  
**Version**: 2.0 (Complete Implementation)  
**Status**: ✅ Fully Implemented  
**Last Updated**: May 3, 2026

---

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [Database Schema](#database-schema)
3. [API Endpoints](#api-endpoints)
4. [React Components](#react-components)
5. [Data Flow](#data-flow)
6. [Performance](#performance)
7. [Error Handling](#error-handling)
8. [Bug Fixes](#bug-fixes)
9. [Integration Points](#integration-points)

---

## Architecture Overview

```
React Frontend (TeamPanel + EditDrawer + ScheduleTab)
        ↓ HTTP/JSON
Next.js API Routes
        ├─ /api/team/* (CRUD operations)
        ├─ /api/roster/schedule/* (Weekly schedule)
        └─ /api/roster/exception/* (Daily overrides)
        ↓ SQL/ORM
Prisma ORM (TypeScript type-safe)
        ↓ SQL
PostgreSQL Database
        ├─ User table
        ├─ TeamMember table
        ├─ TeamMemberOrderType junction
        ├─ StoreAssignment junction
        ├─ WeeklySchedule table
        └─ RosterException table
```

---

## Database Schema

### Existing Models (Used)
- **User**: Authentication and basic profile (email, password hash, role)
- **TeamMember**: Team-specific attributes (maxConcurrentTasks, skills, etc.)
- **Store**: Store information (storeName, city, etc.)

### New Models (Added for Roster)

#### WeeklySchedule
```prisma
model WeeklySchedule {
  id        Int    @id @default(autoincrement())
  
  teamMemberId Int
  teamMember   TeamMember @relation(fields: [teamMemberId], references: [id], onDelete: Cascade)
  
  dayOfWeek     Int      // 0=Sunday, 1=Monday, ..., 6=Saturday
  isWorking     Boolean  // true = working, false = day off
  startTime     String?  // "09:00" format (HH:MM)
  endTime       String?  // "17:00" format (HH:MM)
  breakStart    String?  // Optional break start
  breakEnd      String?  // Optional break end
  
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  
  @@unique([teamMemberId, dayOfWeek])
  @@index([teamMemberId])
  @@index([dayOfWeek])
}
```

#### RosterException
```prisma
model RosterException {
  id        Int    @id @default(autoincrement())
  
  teamMemberId Int
  teamMember   TeamMember @relation(fields: [teamMemberId], references: [id], onDelete: Cascade)
  
  date      DateTime  // UTC date (2026-05-03T00:00:00Z)
  status    String    // "ACTIVE" | "OFF" | "ON_LEAVE" | "SICK"
  note      String?   // Optional notes
  createdBy Int       // User ID of creator
  
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  
  @@unique([teamMemberId, date])  // One exception per day per member
  @@index([teamMemberId])
  @@index([date])
}
```

#### TeamMemberOrderType (Existing)
```prisma
model TeamMemberOrderType {
  id        Int    @id @default(autoincrement())
  
  teamMemberId Int
  teamMember   TeamMember @relation(fields: [teamMemberId], references: [id], onDelete: Cascade)
  
  orderType    String
  assignedAt   DateTime @default(now())
  assignedBy   Int?
  
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  
  @@unique([teamMemberId, orderType])
  @@index([teamMemberId])
}
```

---

## API Endpoints

### Team Management

#### GET /api/team
List all team members with full details and stats

```typescript
GET /api/team

Response (200):
{
  members: [
    {
      id: 1,                                 // teamMember.id
      userId: 2,                             // user.id
      name: "Abhishek Rajpoot",
      email: "abhishek@labstack.in",
      role: "OPS_AGENT" | "STORE_ADMIN",
      storeId: 7,
      maxConcurrentTasks: 5,
      isActive: true,
      createdAt: "2026-04-25T07:45:17.525Z",
      
      orderTypes: [
        { orderType: "HOME_SAMPLE", assignedAt: "2026-05-03T07:48:08.195Z" },
        { orderType: "CENTER_VISIT", assignedAt: "2026-05-03T07:48:10.766Z" }
      ],
      orderTypeCount: 2,
      
      stores: [7, 39, 19, 51],
      storeCount: 4,
      
      currentLoad: 3,
      maxConcurrentTasks: 5,
      
      taskStats: {
        thisMonth: { assigned: 25, completed: 24, slaCompliance: 96.8 },
        thisWeek: { assigned: 5, completed: 5, slaCompliance: 100 }
      },
      
      rosterStatus: "ACTIVE",                // Calculated: Exception > Schedule > Time
      hasException: false                    // True if exception exists for today
    },
    ...
  ]
}
```

**Status Calculation Logic:**
1. If exception exists for today → return exception.status
2. Else if no weekly schedule → return "OFF"
3. Else if current time within working hours (not break) → return "ACTIVE"
4. Else → return "OFF"

**File**: `/src/app/api/team/route.ts`

#### POST /api/team
Create new team member

```typescript
POST /api/team

Body:
{
  name: string,                    // Required
  email: string,                   // Required, must be unique
  password: string,                // Required, min 8 chars
  role: "OPS_AGENT" | "STORE_ADMIN",  // Required
  storeIds?: number[],             // Optional
  skillTagIds?: number[]           // Optional
}

Response (201):
{
  user: {
    id: number,
    name: string,
    email: string,
    role: string
  }
}

Errors:
- 400: Missing required fields
- 409: Email already exists
```

**File**: `/src/app/api/team/route.ts`

#### PATCH /api/team/{userId}
Update team member profile

```typescript
PATCH /api/team/{userId}

Body (all optional):
{
  name?: string,
  phone?: string,
  role?: "OPS_AGENT" | "STORE_ADMIN",
  isActive?: boolean,
  maxConcurrentTasks?: number,  // 1-20
  resetPassword?: string        // min 8 chars
}

Response (200):
{
  user: { id, name, email, role, phone, isActive, createdAt, ... }
}

Errors:
- 400: Validation error
- 401: Unauthorized
- 403: Forbidden (must be OPS_HEAD)
- 404: User not found
```

**File**: `/src/app/api/team/[id]/route.ts`

### Order Types

#### POST /api/team/{userId}/order-types
Assign order type to team member

```typescript
POST /api/team/{userId}/order-types

Body:
{
  orderType: "HOME_SAMPLE" | "CENTER_VISIT" | "INJECTION"
}

Response (201):
{
  id: number,
  teamMemberId: number,
  memberName: string,
  orderType: string,
  assignedAt: datetime,
  assignedBy: number
}

Errors:
- 400: Invalid order type
- 401: Unauthorized
- 403: Forbidden
- 404: Member not found
- 409: Order type already assigned (DUPLICATE_ASSIGNMENT)
```

**File**: `/src/app/api/team/[id]/order-types/route.ts`

#### DELETE /api/team/{userId}/order-types/{orderType}
Remove order type assignment

```typescript
DELETE /api/team/{userId}/order-types/{orderType}

Response (200):
{
  success: true
}

Errors:
- 401: Unauthorized
- 403: Forbidden
- 404: Assignment not found
```

**File**: `/src/app/api/team/[id]/order-types/[orderType]/route.ts`

### Store Assignments

#### POST /api/team/{userId}/stores
Assign store to team member

```typescript
POST /api/team/{userId}/stores

Body:
{
  storeId: number
}

Response (201):
{
  assignment: { teamMemberId, storeId }
}

Errors:
- 400: storeId required
- 401: Unauthorized
- 403: Forbidden
- 404: Member not found
```

**File**: `/src/app/api/team/[id]/stores/route.ts`

#### DELETE /api/team/{userId}/stores
Remove store assignment

```typescript
DELETE /api/team/{userId}/stores

Body:
{
  storeId: number
}

Response (200):
{
  success: true
}

Errors:
- 400: storeId required
- 401: Unauthorized
- 403: Forbidden
- 404: Member not found
```

**File**: `/src/app/api/team/[id]/stores/route.ts`

### Schedule Management

#### GET /api/roster/schedule/{userId}
Get weekly schedule for team member

```typescript
GET /api/roster/schedule/{userId}

Response (200):
{
  schedule: [
    {
      dayOfWeek: 0,        // Sunday
      isWorking: false,
      startTime: null,
      endTime: null
    },
    {
      dayOfWeek: 1,        // Monday
      isWorking: true,
      startTime: "09:00",
      endTime: "17:00",
      breakStart: "13:00",
      breakEnd: "14:00"
    },
    ...
  ],
  userId: number
}

Errors:
- 401: Unauthorized
- 404: User not found
```

**File**: `/src/app/api/roster/[userId]/schedule/route.ts`

#### POST /api/roster/schedule/{userId}
Create/update weekly schedule

```typescript
POST /api/roster/schedule/{userId}

Body:
{
  schedule: [
    {
      dayOfWeek: 0,
      isWorking: boolean,
      startTime?: "HH:MM",
      endTime?: "HH:MM",
      breakStart?: "HH:MM",
      breakEnd?: "HH:MM"
    },
    ... (7 days total)
  ]
}

Response (201):
{
  schedule: [...],
  createdAt: datetime,
  updatedAt: datetime
}

Errors:
- 400: Invalid time format or validation error
- 401: Unauthorized
- 404: User not found
```

**Validation:**
- Time format: HH:MM (00:00 to 23:59)
- Break times must be within working hours
- End time must be after start time

**File**: `/src/app/api/roster/[userId]/schedule/route.ts`

### Roster Exceptions

#### POST /api/roster/exception
Create daily roster exception

```typescript
POST /api/roster/exception

Body:
{
  userId: number,
  date: "YYYY-MM-DD",
  status: "ACTIVE" | "OFF" | "ON_LEAVE" | "SICK",
  note?: string
}

Response (201):
{
  id: number,
  teamMemberId: number,
  userId: number,
  name: string,
  date: "YYYY-MM-DD",
  status: string,
  note: string | null,
  createdBy: number,
  createdAt: datetime
}

Errors:
- 400: Invalid date or missing fields
- 401: Unauthorized
- 403: Forbidden
- 404: Team member not found
- 409: Exception already exists (DUPLICATE_ASSIGNMENT)
```

**Valid Statuses:**
- `ACTIVE`: Override OFF schedule to mark as active
- `OFF`: Override ACTIVE schedule to mark as off
- `ON_LEAVE`: Team member on approved leave
- `SICK`: Team member unavailable due to illness

**File**: `/src/app/api/roster/exception/route.ts`

#### GET /api/roster/exception
Query roster exceptions

```typescript
GET /api/roster/exception?userId=3&start=2026-05-01&end=2026-05-31

Query Parameters:
- userId (optional): Filter to specific user
- start (optional): Start date YYYY-MM-DD
- end (optional): End date YYYY-MM-DD

Response (200):
{
  exceptions: [
    {
      id: number,
      teamMemberId: number,
      userId: number,
      name: string,
      date: "YYYY-MM-DD",
      status: string,
      note: string | null,
      createdBy: number,
      createdAt: datetime,
      updatedAt: datetime
    },
    ...
  ],
  count: number
}
```

**File**: `/src/app/api/roster/exception/route.ts`

#### DELETE /api/roster/exception/{userId}/{date}
Remove roster exception

```typescript
DELETE /api/roster/exception/{userId}/{date}

Example: DELETE /api/roster/exception/3/2026-05-03

Response (200):
{
  success: true,
  message: "Exception removed"
}

Errors:
- 400: Invalid date format
- 401: Unauthorized
- 403: Forbidden (OPS_HEAD only)
- 404: Exception not found
```

**File**: `/src/app/api/roster/exception/[userId]/[date]/route.ts`

---

## React Components

### TeamPanel.tsx

**Location**: `/src/components/head/TeamPanel.tsx`

**Purpose**: Main team management interface

**Key State:**
```typescript
const [members, setMembers] = useState<TeamMember[]>([]);
const [stores, setStores] = useState<Store[]>([]);
const [editMember, setEditMember] = useState<TeamMember | null>(null);
const [selectedForException, setSelectedForException] = useState<{
  member: TeamMember;
  action: "leave" | "sick" | "off"
} | null>(null);
const [exceptionNote, setExceptionNote] = useState("");
```

**Key Functions:**
- `fetchAll()`: GET /api/team + /api/stores
- `handleAddMember()`: POST /api/team
- `onSaved()`: Refresh after edits
- `handleMarkActive()`: POST exception with status ACTIVE
- `handleCreateException()`: POST exception with status OFF
- `handleRemoveException()`: DELETE exception

**Features:**
- Displays member grid with responsive layout
- Shows roster analytics (Active/Off counts)
- Three-case status override buttons
- Add member form with validation
- Opens EditDrawer for detailed editing

### EditDrawer.tsx (Nested in TeamPanel)

**Purpose**: Detailed member editing interface

**Tabs:**
1. **Profile**: Name, phone, role, max tasks, account status, password
2. **Order Types**: Toggle assignments (HOME_SAMPLE, CENTER_VISIT, INJECTION)
3. **Stores**: Checkbox list of store assignments
4. **Schedule**: Weekly schedule configuration via ScheduleTab component

**Key State:**
```typescript
const [activeTab, setActiveTab] = useState<"profile" | "order-types" | "stores" | "schedule">("profile");
const [form, setForm] = useState({
  name, email, phone, role, isActive, maxConcurrentTasks
});
const [assignedStoreIds, setAssignedStoreIds] = useState<Set<number>>();
const [assignedOrderTypes, setAssignedOrderTypes] = useState<Set<string>>();
const [currentSchedule, setCurrentSchedule] = useState<any[]>([]);
```

**Save Logic:**
```typescript
async saveProfile() {
  1. PATCH /api/team/{userId} - profile changes
  2. For each new store: POST /api/team/{userId}/stores
  3. For each removed store: DELETE /api/team/{userId}/stores
  4. For each new order type: POST /api/team/{userId}/order-types
  5. For each removed order type: DELETE /api/team/{userId}/order-types
  6. POST /api/roster/schedule/{userId} - schedule changes
}
```

**Auto-dismiss Notification:**
```typescript
useEffect(() => {
  if (success) {
    const timeout = setTimeout(() => setSuccess(""), 2500);
    return () => clearTimeout(timeout);
  }
}, [success]);
```

### ScheduleTab.tsx

**Location**: `/src/components/roster/ScheduleTab.tsx`

**Purpose**: Configure weekly schedule

**Features:**
- 7-day schedule grid
- Toggle working/off per day
- Time inputs for start/end/break times
- Copy schedule button with modal
- Validation for time format

**Key State:**
```typescript
const [schedule, setSchedule] = useState<ScheduleDay[]>([]);
const [copyDialog, setCopyDialog] = useState<{
  isOpen: boolean;
  targetDay: number | null
}>();
```

**Data Structure:**
```typescript
interface ScheduleDay {
  dayOfWeek: number;      // 0-6
  isWorking: boolean;
  startTime?: string;     // "HH:MM"
  endTime?: string;       // "HH:MM"
  breakStart?: string;    // "HH:MM"
  breakEnd?: string;      // "HH:MM"
}
```

---

## Data Flow

### Edit Member Complete Flow
```
1. User opens EditDrawer and makes changes
   - Profile tab: edit name, phone, role, etc.
   - Order Types tab: toggle order types
   - Stores tab: check/uncheck stores
   - Schedule tab: set weekly times

2. User clicks "Save Changes"

3. Frontend validates all inputs

4. Sequential API calls:
   a. PATCH /api/team/{userId}
      Body: name, phone, role, isActive, maxConcurrentTasks, resetPassword
      Response: updated user object
      
   b. Sync Order Types:
      - Get current assignments from member data
      - For new assignments: POST /api/team/{userId}/order-types
      - For removed assignments: DELETE /api/team/{userId}/order-types/{type}
      
   c. Sync Stores:
      - Get current stores from member data
      - For new stores: POST /api/team/{userId}/stores
      - For removed stores: DELETE /api/team/{userId}/stores
      
   d. Save Schedule:
      - POST /api/roster/schedule/{userId}
      Body: { schedule: [...] }
      
5. On success:
   - Show success message (2.5s auto-dismiss)
   - Refresh member data via GET /api/team
   - Update EditDrawer with fresh data

6. On error:
   - Show error message
   - Revert optimistic UI updates
   - Allow user to retry
```

### Roster Override Flow
```
Case 1: Schedule OFF → "Mark Active" clicked
   1. Confirm dialog
   2. POST /api/roster/exception
      Body: { userId, date, status: "ACTIVE", note: "Marked as active" }
   3. fetchAll() to refresh grid
   4. hasException becomes true
   5. Button becomes "Revert Exception"

Case 2: Schedule ACTIVE → "Mark Off" clicked
   1. Opens exception dialog
   2. User enters optional note
   3. POST /api/roster/exception
      Body: { userId, date, status: "OFF", note }
   4. fetchAll() to refresh grid
   5. hasException becomes true
   6. Button becomes "Revert Exception"

Case 3: Exception exists → "Revert Exception" clicked
   1. Confirm dialog
   2. DELETE /api/roster/exception/{userId}/{date}
   3. fetchAll() to refresh grid
   4. hasException becomes false
   5. Button shows based on schedule (Mark Active or Mark Off)
```

---

## Performance

### Query Performance
- GET /api/team: ~100ms (all members + stats)
- PATCH /api/team: ~150ms
- POST/DELETE order-types: ~100ms
- POST/DELETE stores: ~100ms
- POST/DELETE exceptions: ~100ms

### Optimization Strategies
- Batch operations in single save
- Optimistic UI updates
- Efficient Prisma queries with select/include
- Indexed database fields (teamMemberId, date, etc.)

---

## Error Handling

### Standard Error Response
```json
{
  "error": "Human-readable message",
  "code": "ERROR_CODE",
  "details": { /* optional context */ }
}
```

### Common Errors

| Status | Code | Cause | Solution |
|--------|------|-------|----------|
| 400 | INVALID_INPUT | Bad format or validation | Fix input and retry |
| 401 | UNAUTHORIZED | No valid session | User must login |
| 403 | FORBIDDEN | Insufficient permissions | Only OPS_HEAD can modify |
| 404 | NOT_FOUND | Resource doesn't exist | Verify user/member ID |
| 409 | DUPLICATE_ASSIGNMENT | Assignment already exists | Delete first then recreate |

---

## Bug Fixes

### Bug #1: ID Confusion (FIXED)
**Issue**: Endpoints treated `id` parameter as teamMemberId instead of userId
**Fix**: All endpoints now use userId → lookup teamMember → get teamMemberId
**File**: `/src/app/api/team/[id]/order-types/route.ts`

### Bug #2: Wrong Update ID in Frontend (FIXED)
**Issue**: EditDrawer used member.id (teamMember.id) instead of member.userId
**Fix**: PATCH calls now use member.userId
**File**: `/src/components/head/TeamPanel.tsx` line 114

### Bug #3: Status Code 204 with JSON (FIXED)
**Issue**: NextResponse.json() doesn't support 204 status
**Fix**: DELETE endpoints return 200 with { success: true }
**File**: All DELETE endpoints

### Bug #4: Data Structure Mismatch (FIXED)
**Issue**: UI expected nested member.teamMember but API returned flattened
**Fix**: Updated TeamMember interface with flattened fields
**File**: `/src/components/head/TeamPanel.tsx`

### Bug #5: State Not Syncing (FIXED)
**Issue**: After saving, drawer didn't show updated data
**Fix**: Added useEffect to sync state when member prop changes
**File**: `/src/components/head/TeamPanel.tsx` line 84-89

### Bug #6: Timezone Mismatch in Exception Queries (FIXED)
**Issue**: Exceptions stored as UTC dates, queries used local time ranges
**Root Cause**: hasException flag returning false incorrectly
**Fix**: Changed /api/team to use UTC dates consistently
**Impact**: Status override buttons now display correctly
**File**: `/src/app/api/team/route.ts` line 65-68

---

## Integration Points

### Task Assignment Engine
- Verifies member has required order type before assignment
- Checks member's roster status (must be ACTIVE)
- Respects maxConcurrentTasks limit
- Filters eligible members from /api/team response

### Task Statistics
- currentLoad: Count of non-completed, non-cancelled tasks
- taskStats: Aggregated from Task table (assigned, completed, slaCompliance)
- Updated when member list is fetched

### Schedule System
- WeeklySchedule is template for daily status
- RosterException overrides schedule for specific dates
- Roster status calculated: Exception > Schedule > CurrentTime

---

**Last Updated**: May 3, 2026  
**Version**: 2.0 - Complete Technical Implementation

See Also: [Product Specification](FEATURE_SPEC.md)
