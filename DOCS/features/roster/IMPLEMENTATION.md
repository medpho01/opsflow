# Roster Feature - Technical Specification

**Feature**: Weekly Schedule Management & Daily Roster Exceptions  
**Version**: 1.0  
**Status**: Design  
**Last Updated**: May 3, 2026

---

## Architecture Overview

```
React Frontend (Schedule UI, Daily Roster Page)
        ↓ HTTP/JSON
Next.js API Routes (/api/roster/*)
        ↓ SQL/ORM
Prisma ORM (database queries)
        ↓ SQL
PostgreSQL (two new tables)
```

---

## Database Schema

### WeeklySchedule Table

```prisma
model WeeklySchedule {
  id              Int       @id @default(autoincrement())
  teamMemberId    Int
  dayOfWeek       Int       // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  isWorking       Boolean   @default(true)
  startTime       String?   // Format: "HH:MM" (e.g., "09:00")
  endTime         String?   // Format: "HH:MM" (e.g., "17:00")
  breakStartTime  String?   // Format: "HH:MM", optional
  breakEndTime    String?   // Format: "HH:MM", optional
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  member TeamMember @relation(fields: [teamMemberId], references: [id], onDelete: Cascade)

  @@unique([teamMemberId, dayOfWeek])
  @@index([teamMemberId])
  @@index([dayOfWeek])
  @@map("weekly_schedules")
}
```

### RosterException Table

```prisma
model RosterException {
  id              Int       @id @default(autoincrement())
  teamMemberId    Int
  date            DateTime  @db.Date  // YYYY-MM-DD format
  status          String    // "ON_LEAVE" | "SICK" | "OFF"
  note            String?
  createdBy       Int?      // User ID who created the exception
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  member TeamMember @relation(fields: [teamMemberId], references: [id], onDelete: Cascade)

  @@unique([teamMemberId, date])
  @@index([teamMemberId])
  @@index([date])
  @@map("roster_exceptions")
}
```

### Updates to TeamMember

```prisma
model TeamMember {
  // ... existing fields ...
  
  // Add relations
  weeklySchedules WeeklySchedule[]
  rosterExceptions RosterException[]
}
```

### Migration File

**File**: `prisma/migrations/20260503_add_roster_tables.sql`

```sql
-- Create weekly_schedules table
CREATE TABLE "taskos"."weekly_schedules" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "teamMemberId" INTEGER NOT NULL,
  "dayOfWeek" INTEGER NOT NULL,
  "isWorking" BOOLEAN NOT NULL DEFAULT true,
  "startTime" TEXT,
  "endTime" TEXT,
  "breakStartTime" TEXT,
  "breakEndTime" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  FOREIGN KEY ("teamMemberId") REFERENCES "taskos"."team_members"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "weekly_schedules_teamMemberId_dayOfWeek_key" 
  ON "taskos"."weekly_schedules"("teamMemberId", "dayOfWeek");
CREATE INDEX "weekly_schedules_teamMemberId_idx" 
  ON "taskos"."weekly_schedules"("teamMemberId");
CREATE INDEX "weekly_schedules_dayOfWeek_idx" 
  ON "taskos"."weekly_schedules"("dayOfWeek");

-- Create roster_exceptions table
CREATE TABLE "taskos"."roster_exceptions" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "teamMemberId" INTEGER NOT NULL,
  "date" DATE NOT NULL,
  "status" TEXT NOT NULL,
  "note" TEXT,
  "createdBy" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  FOREIGN KEY ("teamMemberId") REFERENCES "taskos"."team_members"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "roster_exceptions_teamMemberId_date_key" 
  ON "taskos"."roster_exceptions"("teamMemberId", "date");
CREATE INDEX "roster_exceptions_teamMemberId_idx" 
  ON "taskos"."roster_exceptions"("teamMemberId");
CREATE INDEX "roster_exceptions_date_idx" 
  ON "taskos"."roster_exceptions"("date");
```

---

## API Endpoints

**Base Path**: `/api/roster`

### 1. Get Weekly Schedule for a User

```
GET /api/roster/{userId}/schedule

Response (200):
{
  userId: number,
  weeklySchedule: [
    {
      dayOfWeek: 0,
      dayName: "Sunday",
      isWorking: false,
      startTime: null,
      endTime: null,
      breakStartTime: null,
      breakEndTime: null
    },
    {
      dayOfWeek: 1,
      dayName: "Monday",
      isWorking: true,
      startTime: "09:00",
      endTime: "17:00",
      breakStartTime: "13:00",
      breakEndTime: "14:00"
    },
    ...
  ]
}

Errors:
- 400: Invalid userId format
- 401: Unauthorized
- 404: User or team member not found
```

**File**: `/src/app/api/roster/[userId]/schedule/route.ts`

---

### 2. Create/Update Weekly Schedule

```
POST /api/roster/{userId}/schedule

Body:
{
  schedules: [
    {
      dayOfWeek: 1,  // Monday
      isWorking: true,
      startTime: "09:00",
      endTime: "17:00",
      breakStartTime: "13:00",
      breakEndTime: "14:00"
    },
    {
      dayOfWeek: 6,  // Saturday
      isWorking: false,
      startTime: null,
      endTime: null,
      breakStartTime: null,
      breakEndTime: null
    },
    ...
  ]
}

Response (200):
{
  userId: number,
  weeklySchedule: [ /* updated schedule */ ]
}

Errors:
- 400: Invalid time format or validation error
- 401: Unauthorized
- 403: Forbidden (user not OPS_HEAD)
- 404: User not found
```

**File**: `/src/app/api/roster/[userId]/schedule/route.ts`

**Validation**:
- startTime must be before endTime
- breakStartTime must be before breakEndTime
- breakStartTime must be >= startTime and <= endTime
- Time format: "HH:MM" (00:00 - 23:59)
- dayOfWeek must be 0-6

---

### 3. Get Daily Roster for a Date

```
GET /api/roster?date=2026-05-05

Query Parameters:
- date: YYYY-MM-DD (defaults to today)

Response (200):
{
  date: "2026-05-05",
  dayOfWeek: 1,  // Monday
  dayName: "Monday",
  roster: [
    {
      id: 1,
      userId: 2,
      teamMemberId: 1,
      name: "Abhishek Rajpoot",
      email: "abhishek@labstack.in",
      role: "OPS_AGENT",
      scheduled: {
        isWorking: true,
        startTime: "09:00",
        endTime: "17:00",
        breakStartTime: "13:00",
        breakEndTime: "14:00"
      },
      exception: {
        status: "ON_LEAVE",
        note: "Vacation",
        createdAt: "2026-05-03T10:00:00Z"
      }
    },
    {
      id: 2,
      userId: 3,
      teamMemberId: 2,
      name: "Datha",
      email: "datha@labstack.in",
      role: "OPS_AGENT",
      scheduled: {
        isWorking: true,
        startTime: "09:00",
        endTime: "17:00",
        breakStartTime: "13:00",
        breakEndTime: "14:00"
      },
      exception: null
    }
  ]
}

Errors:
- 400: Invalid date format
- 401: Unauthorized
```

**File**: `/src/app/api/roster/route.ts`

---

### 4. Create Roster Exception

```
POST /api/roster/{userId}/exceptions

Body:
{
  date: "2026-05-05",  // YYYY-MM-DD
  status: "ON_LEAVE",  // "ON_LEAVE" | "SICK" | "OFF"
  note: "Vacation approved"
}

Response (201):
{
  id: 42,
  teamMemberId: 1,
  date: "2026-05-05",
  status: "ON_LEAVE",
  note: "Vacation approved",
  createdAt: "2026-05-03T14:30:00Z"
}

Errors:
- 400: Invalid date format or status
- 401: Unauthorized
- 403: Forbidden (user cannot mark others)
- 404: User not found
- 409: Exception already exists for this date
```

**File**: `/src/app/api/roster/[userId]/exceptions/route.ts`

**Validation**:
- Date must be in YYYY-MM-DD format
- Status must be one of: ON_LEAVE, SICK, OFF
- Date cannot be in the past (optional - allow past dates for admin)
- Only one exception per user per date

---

### 5. Get Roster Exceptions for a User

```
GET /api/roster/{userId}/exceptions?startDate=2026-05-01&endDate=2026-05-31

Query Parameters:
- startDate: YYYY-MM-DD (optional)
- endDate: YYYY-MM-DD (optional)

Response (200):
{
  userId: number,
  exceptions: [
    {
      id: 42,
      date: "2026-05-05",
      status: "ON_LEAVE",
      note: "Vacation approved",
      createdAt: "2026-05-03T14:30:00Z"
    },
    {
      id: 43,
      date: "2026-05-10",
      status: "SICK",
      note: "Fever",
      createdAt: "2026-05-10T08:00:00Z"
    }
  ]
}

Errors:
- 400: Invalid date format
- 401: Unauthorized
- 404: User not found
```

**File**: `/src/app/api/roster/[userId]/exceptions/route.ts`

---

### 6. Delete Roster Exception

```
DELETE /api/roster/{userId}/exceptions/{date}

Route Parameters:
- userId: number
- date: YYYY-MM-DD

Response (200):
{
  success: true,
  message: "Exception removed"
}

Errors:
- 400: Invalid date format
- 401: Unauthorized
- 404: Exception not found
```

**File**: `/src/app/api/roster/[userId]/exceptions/route.ts`

---

## React Components

### 1. ScheduleTab.tsx (in EditDrawer)

**Location**: `/src/components/roster/ScheduleTab.tsx`

**Props**:
```typescript
interface ScheduleTabProps {
  userId: number;
  onSave: () => void;
}
```

**State**:
```typescript
const [schedule, setSchedule] = useState<WeeklyScheduleRecord[]>([]);
const [loading, setLoading] = useState(false);
const [error, setError] = useState("");
const [success, setSuccess] = useState("");

interface WeeklyScheduleRecord {
  dayOfWeek: number;
  isWorking: boolean;
  startTime: string;
  endTime: string;
  breakStartTime: string;
  breakEndTime: string;
}
```

**Key Functions**:
- `loadSchedule()`: Fetch current schedule from API
- `handleToggleWorking(dayOfWeek)`: Toggle working/off
- `handleTimeChange(dayOfWeek, field, value)`: Update time
- `saveSchedule()`: POST to /api/roster/{userId}/schedule
- `validateTimes()`: Ensure times are valid

**Validation Logic**:
```typescript
function validateSchedule(schedule: WeeklyScheduleRecord[]): string[] {
  const errors: string[] = [];
  
  schedule.forEach((day) => {
    if (!day.isWorking) return;
    
    if (!day.startTime || !day.endTime) {
      errors.push(`Day ${getDayName(day.dayOfWeek)}: Start and end times required`);
    }
    
    if (day.startTime >= day.endTime) {
      errors.push(`Day ${getDayName(day.dayOfWeek)}: Start time must be before end time`);
    }
    
    if (day.breakStartTime && day.breakEndTime) {
      if (day.breakStartTime >= day.breakEndTime) {
        errors.push(`Day ${getDayName(day.dayOfWeek)}: Break start must be before break end`);
      }
      if (day.breakStartTime < day.startTime || day.breakEndTime > day.endTime) {
        errors.push(`Day ${getDayName(day.dayOfWeek)}: Break times must be within working hours`);
      }
    }
  });
  
  return errors;
}
```

**Render**:
```
┌─────────────────────────────────────┐
│ Weekly Schedule                     │
├─────────────────────────────────────┤
│ [For each day 0-6]                  │
│ {dayName}                           │
│ ☑ Working                           │
│ Start: [09:00]  End: [17:00]        │
│ Break: [13:00] - [14:00]            │
│                         [Save]      │
└─────────────────────────────────────┘
```

---

### 2. DailyRosterPage.tsx

**Location**: `/src/components/roster/DailyRosterPage.tsx`

**Props**: None (uses route params)

**State**:
```typescript
const [date, setDate] = useState<Date>(new Date());
const [roster, setRoster] = useState<RosterEntry[]>([]);
const [loading, setLoading] = useState(false);
const [error, setError] = useState("");

interface RosterEntry {
  userId: number;
  teamMemberId: number;
  name: string;
  role: string;
  scheduled: {
    isWorking: boolean;
    startTime?: string;
    endTime?: string;
    breakStartTime?: string;
    breakEndTime?: string;
  };
  exception?: {
    status: string;
    note?: string;
    createdAt: string;
  };
}
```

**Key Functions**:
- `loadRoster(date)`: Fetch roster for a date
- `markException(userId, status, note)`: Create exception
- `removeException(userId)`: Delete exception
- `getDisplayStatus(entry)`: Determine what to show (exception or schedule)

**Helper Function**:
```typescript
function getDisplayStatus(entry: RosterEntry) {
  if (entry.exception) {
    return {
      status: entry.exception.status,
      type: "exception",
      times: null
    };
  }
  
  if (!entry.scheduled.isWorking) {
    return {
      status: "OFF",
      type: "scheduled",
      times: null
    };
  }
  
  return {
    status: "ACTIVE",
    type: "scheduled",
    times: {
      start: entry.scheduled.startTime,
      end: entry.scheduled.endTime,
      breakStart: entry.scheduled.breakStartTime,
      breakEnd: entry.scheduled.breakEndTime
    }
  };
}
```

---

### 3. ExceptionDialog.tsx

**Location**: `/src/components/roster/ExceptionDialog.tsx`

**Props**:
```typescript
interface ExceptionDialogProps {
  userId: number;
  userName: string;
  date: Date;
  scheduledTime: { start: string; end: string };
  status: "ON_LEAVE" | "SICK" | "OFF";
  onConfirm: (status, note) => Promise<void>;
  onCancel: () => void;
}
```

**State**:
```typescript
const [note, setNote] = useState("");
const [saving, setSaving] = useState(false);
const [error, setError] = useState("");
```

**Render**:
```
┌──────────────────────────────────────┐
│ Mark as [Status]                     │
├──────────────────────────────────────┤
│ {userName}                           │
│ {formattedDate}                      │
│ Scheduled: {scheduledTime}           │
│                                      │
│ Add note (optional):                 │
│ [________________]                   │
│                                      │
│ [Cancel]  [Confirm]                  │
└──────────────────────────────────────┘
```

---

## Utility Functions

### Date & Time Helpers

**File**: `/src/lib/roster/utils.ts`

```typescript
// Get day of week name
function getDayName(dayOfWeek: number): string {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return days[dayOfWeek];
}

// Get day of week from date
function getDayOfWeek(date: Date): number {
  return date.getDay(); // 0-6
}

// Format time to HH:MM
function formatTime(time: string): string {
  // Convert "09:00" to "9:00 AM"
  const [hour, minute] = time.split(":");
  const h = parseInt(hour);
  const ampm = h >= 12 ? "PM" : "AM";
  const displayHour = h > 12 ? h - 12 : h || 12;
  return `${displayHour}:${minute} ${ampm}`;
}

// Validate time format
function isValidTimeFormat(time: string): boolean {
  return /^([0-1]\d|2[0-3]):[0-5]\d$/.test(time);
}

// Check if time1 is before time2
function isTimeBefore(time1: string, time2: string): boolean {
  return time1 < time2;
}
```

---

## Error Handling

### Standard Error Responses

All endpoints return errors in this format:

```json
{
  "error": "Human-readable message",
  "code": "ERROR_CODE",
  "details": { /* optional */ }
}
```

### Common Errors

| Status | Code | Cause | Action |
|--------|------|-------|--------|
| 400 | INVALID_TIME_FORMAT | Time not in HH:MM format | Use HH:MM format |
| 400 | INVALID_TIME_RANGE | Start >= End time | Fix time range |
| 400 | BREAK_OUTSIDE_HOURS | Break not within working hours | Adjust break times |
| 400 | INVALID_STATUS | Status not in enum | Use valid status |
| 401 | UNAUTHORIZED | No valid session | User must login |
| 403 | FORBIDDEN | Insufficient permissions | Check user role |
| 404 | NOT_FOUND | User/exception not found | Verify ID |
| 409 | DUPLICATE_EXCEPTION | Exception already exists | Remove first then recreate |

---

## Performance Characteristics

- **GET /api/roster/{userId}/schedule**: ~20ms (simple join)
- **POST /api/roster/{userId}/schedule**: ~50ms (upsert 7 records)
- **GET /api/roster?date=X**: ~100ms (joins + exception lookup)
- **POST /api/roster/{userId}/exceptions**: ~30ms (unique constraint check)
- **GET /api/roster/{userId}/exceptions**: ~40ms (date range filter)

---

## Security & Authorization

### Access Control

- **View own schedule**: User can view their own / OPS_HEAD can view any
- **Edit own schedule**: User can set their own / OPS_HEAD can set any
- **Create exception**: User can create for self / OPS_HEAD can create for any
- **Edit exception**: User can edit their own / OPS_HEAD can edit any
- **Delete exception**: User can delete their own / OPS_HEAD can delete any

### Implementation

```typescript
// Check authorization in API endpoints
if (userId !== session.userId && session.role !== "OPS_HEAD") {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}
```

---

## Database Indexes

**Queries and their indexes**:

1. Get schedule for user + day: `(teamMemberId, dayOfWeek)`
2. Get all exceptions for user: `(teamMemberId)` + date range
3. Get all exceptions for date: `(date)` + user filter
4. Check if exception exists: `UNIQUE (teamMemberId, date)`

All indexes already defined in Prisma schema.

---

## Integration with Task Engine

### Task Assignment Logic

When assigning a task to an agent, check:

```typescript
async function canAssignTask(
  userId: number,
  taskTime: Date // When task is scheduled
): Promise<boolean> {
  // Get day of week
  const dayOfWeek = taskTime.getDay();
  
  // Get scheduled time
  const scheduled = await getWeeklySchedule(userId, dayOfWeek);
  if (!scheduled.isWorking) return false;
  
  // Check for exceptions
  const exception = await getRosterException(userId, taskTime);
  if (exception && ["ON_LEAVE", "SICK", "OFF"].includes(exception.status)) {
    return false;
  }
  
  // Check if task time is within scheduled hours
  const taskHour = formatTimeToComparable(taskTime);
  if (taskHour < scheduled.startTime || taskHour > scheduled.endTime) {
    return false;
  }
  
  // Check if task time is during break
  if (scheduled.breakStartTime && scheduled.breakEndTime) {
    if (taskHour >= scheduled.breakStartTime && taskHour <= scheduled.breakEndTime) {
      return false;
    }
  }
  
  return true;
}
```

---

## Migration & Deployment

### Pre-Deployment

1. Create migration file
2. Run migration in staging
3. Verify data integrity
4. Test all API endpoints
5. Deploy code changes

### Zero-Downtime Deployment

1. Create tables (non-breaking)
2. Deploy new API endpoints
3. Deploy new UI components
4. Populate initial WeeklySchedule (optional)
5. Activate feature flag

