# Roster Feature - Testing Plan

**Feature**: Weekly Schedule Management & Daily Roster Exceptions  
**Version**: 1.0  
**Status**: Testing Strategy  
**Last Updated**: May 3, 2026

---

## Testing Overview

The Roster feature requires comprehensive testing across three layers:
1. **API Layer** - Schedule and exception management endpoints
2. **Database Layer** - Schema, migrations, queries, and data integrity
3. **UI Layer** - Components, state management, and user interactions
4. **Integration Layer** - Task engine interactions and roster display logic

---

## Unit Tests

### API Endpoints

#### GET /api/roster/schedule/:userId

**Test Cases:**

1. ✅ **GET Schedule - Valid User**
   - Setup: Create user with team member record
   - Action: GET /api/roster/schedule/1
   - Expected: Returns 7 days of WeeklySchedule (one per day of week)
   - Assertions:
     - Status 200
     - Response includes all 7 days (0=Sunday through 6=Saturday)
     - Each day has: dayOfWeek, isWorking, startTime (if working), endTime (if working), breakStart?, breakEnd?

2. ✅ **GET Schedule - Non-existent User**
   - Setup: None
   - Action: GET /api/roster/schedule/99999
   - Expected: User not found or no schedule records
   - Assertions:
     - Status 404 or empty array []
     - Error message: "User not found" or similar

3. ✅ **GET Schedule - Partial Schedule**
   - Setup: Create user with only 5 days configured (Mon-Fri, Sat-Sun OFF)
   - Action: GET /api/roster/schedule/1
   - Expected: Returns 5 configured days + 2 OFF days
   - Assertions:
     - Status 200
     - 7 records returned
     - Saturday & Sunday have isWorking=false

4. ✅ **GET Schedule - Break Times**
   - Setup: User with break on Mon (13:00-14:00), no break on Tue
   - Action: GET /api/roster/schedule/1
   - Expected: Monday includes breakStart=13:00, breakEnd=14:00. Tuesday has null breaks.
   - Assertions:
     - Monday: breakStart="13:00", breakEnd="14:00"
     - Tuesday: breakStart=null, breakEnd=null

---

#### POST /api/roster/schedule/:userId

**Test Cases:**

1. ✅ **POST Schedule - Create Valid Schedule**
   - Setup: User with empty schedule
   - Action: POST /api/roster/schedule/1
     ```json
     {
       "schedule": [
         { "dayOfWeek": 1, "isWorking": true, "startTime": "09:00", "endTime": "17:00", "breakStart": "13:00", "breakEnd": "14:00" },
         { "dayOfWeek": 2, "isWorking": true, "startTime": "09:00", "endTime": "17:00", "breakStart": null, "breakEnd": null },
         { "dayOfWeek": 6, "isWorking": false },
         { "dayOfWeek": 0, "isWorking": false }
       ]
     }
     ```
   - Expected: Schedule saved successfully
   - Assertions:
     - Status 201
     - All 7 days saved (or as provided)
     - Can retrieve via GET and matches posted data

2. ✅ **POST Schedule - Invalid Time Format**
   - Setup: User ID valid
   - Action: POST with startTime="9:00" (not 24-hour HH:MM format)
   - Expected: Validation error
   - Assertions:
     - Status 400
     - Error message: "Invalid time format. Use HH:MM (24-hour)"
     - Data not saved

3. ✅ **POST Schedule - End Time Before Start Time**
   - Setup: User ID valid
   - Action: POST with startTime="17:00", endTime="09:00"
   - Expected: Validation error
   - Assertions:
     - Status 400
     - Error message: "End time must be after start time"
     - Data not saved

4. ✅ **POST Schedule - Break Overlaps Work Hours**
   - Setup: Valid work hours 09:00-17:00, break 08:00-09:00
   - Action: POST with overlapping break
   - Expected: Validation error
   - Assertions:
     - Status 400
     - Error message: "Break times must be within work hours"

5. ✅ **POST Schedule - Break Start After Break End**
   - Setup: breakStart="14:00", breakEnd="13:00"
   - Action: POST schedule
   - Expected: Validation error
   - Assertions:
     - Status 400
     - Error message: "Break end time must be after break start time"

6. ✅ **POST Schedule - Unauthorized User**
   - Setup: OPS_AGENT trying to edit another user's schedule
   - Action: POST /api/roster/schedule/2 (different user)
   - Expected: Authorization error
   - Assertions:
     - Status 403
     - Error message: "Forbidden. Can only edit own schedule or users must be OPS_HEAD"

7. ✅ **POST Schedule - Upsert (Replace Existing)**
   - Setup: User with existing schedule Mon-Fri
   - Action: POST new schedule with only Tue, Wed, Thu
   - Expected: Old schedule replaced with new one
   - Assertions:
     - Status 200/201
     - GET returns only Tue, Wed, Thu (or all 7 if upsert fills blanks)

---

#### GET /api/roster/daily/:date

**Test Cases:**

1. ✅ **GET Daily Roster - Valid Date**
   - Setup: Multiple users with schedules, some with exceptions
   - Action: GET /api/roster/daily/2026-05-06 (Monday)
   - Expected: All team members with their scheduled times or exception status
   - Assertions:
     - Status 200
     - Returns array of members
     - Each member includes: userId, name, role, scheduled (from WeeklySchedule), exception (if exists)
     - Example response:
       ```json
       {
         "roster": [
           {
             "userId": 1,
             "name": "Abhishek",
             "role": "OPS_AGENT",
             "scheduled": { "startTime": "09:00", "endTime": "17:00", "breakStart": "13:00", "breakEnd": "14:00" },
             "exception": null,
             "status": "ACTIVE"
           },
           {
             "userId": 2,
             "name": "Datha",
             "role": "OPS_AGENT",
             "scheduled": { "startTime": "09:00", "endTime": "17:00" },
             "exception": { "status": "ON_LEAVE", "note": "Vacation" },
             "status": "ON_LEAVE"
           }
         ]
       }
       ```

2. ✅ **GET Daily Roster - Past Date**
   - Setup: Date is 2020-01-01
   - Action: GET /api/roster/daily/2020-01-01
   - Expected: Historical roster data (if available)
   - Assertions:
     - Status 200 (allow historical lookups for reporting)
     - Returns roster based on schedules that were active then

3. ✅ **GET Daily Roster - Future Date**
   - Setup: Date is 2030-12-31
   - Action: GET /api/roster/daily/2030-12-31
   - Expected: Projected roster based on current schedules
   - Assertions:
     - Status 200
     - Uses current WeeklySchedule template

4. ✅ **GET Daily Roster - Invalid Date Format**
   - Setup: None
   - Action: GET /api/roster/daily/05-06-2026 (wrong format)
   - Expected: Validation error
   - Assertions:
     - Status 400
     - Error message: "Invalid date format. Use YYYY-MM-DD"

5. ✅ **GET Daily Roster - Weekend**
   - Setup: Saturday (no users scheduled)
   - Action: GET /api/roster/daily/2026-05-04 (Saturday)
   - Expected: Users scheduled OFF
   - Assertions:
     - All users have scheduled.isWorking=false
     - No exceptions needed for normal OFF days

---

#### POST /api/roster/exception

**Test Cases:**

1. ✅ **POST Exception - Create Leave**
   - Setup: User with valid schedule
   - Action: POST with { "userId": 1, "date": "2026-05-06", "status": "ON_LEAVE", "note": "Vacation" }
   - Expected: Exception created
   - Assertions:
     - Status 201
     - Returns: { id, userId, date, status, note, createdAt, createdBy }
     - Daily roster shows exception for that date

2. ✅ **POST Exception - Create Sick**
   - Setup: User ID valid, date in future
   - Action: POST with status="SICK", note="Fever"
   - Expected: Exception created
   - Assertions:
     - Status 201
     - Daily roster shows SICK status

3. ✅ **POST Exception - Create Off**
   - Setup: User ID valid
   - Action: POST with status="OFF", no note
   - Expected: Exception created
   - Assertions:
     - Status 201
     - note field can be null

4. ✅ **POST Exception - Invalid Status**
   - Setup: User ID valid
   - Action: POST with status="PENDING" (invalid)
   - Expected: Validation error
   - Assertions:
     - Status 400
     - Error: "Invalid status. Must be ON_LEAVE, SICK, or OFF"

5. ✅ **POST Exception - Duplicate Exception**
   - Setup: Exception already exists for 2026-05-06
   - Action: POST another exception for same date/user
   - Expected: Duplicate error or upsert
   - Assertions:
     - Status 409 (Conflict) OR 200 (if upsert behavior)
     - Clear behavior documented

6. ✅ **POST Exception - Past Date**
   - Setup: Date is 2020-01-01
   - Action: POST exception for past date
   - Expected: Allowed (for retroactive records)
   - Assertions:
     - Status 201
     - Can be used for historical record-keeping

7. ✅ **POST Exception - Far Future Date**
   - Setup: Date is 2099-12-31
   - Action: POST exception
   - Expected: Allowed
   - Assertions:
     - Status 201
     - No artificial date limits

8. ✅ **POST Exception - User Not Found**
   - Setup: None
   - Action: POST with userId=99999
   - Expected: User not found error
   - Assertions:
     - Status 404
     - Error: "User not found"

9. ✅ **POST Exception - Unauthorized**
   - Setup: OPS_AGENT trying to mark another user as SICK
   - Action: POST for different user
   - Expected: Authorization check depends on policy
   - Assertions:
     - Either 403 (OPS_AGENT can't mark others)
     - Or 201 (OPS_AGENT can mark others - business rule)
     - Document which is correct policy

---

#### GET /api/roster/exception/:userId

**Test Cases:**

1. ✅ **GET Exceptions - All for User**
   - Setup: User with 3 exceptions (May 1, 5, 10)
   - Action: GET /api/roster/exception/1
   - Expected: Array of 3 exceptions
   - Assertions:
     - Status 200
     - Returns all exceptions for user
     - Each has: id, userId, date, status, note, createdAt

2. ✅ **GET Exceptions - User with No Exceptions**
   - Setup: User with no exceptions
   - Action: GET /api/roster/exception/1
   - Expected: Empty array
   - Assertions:
     - Status 200
     - Returns []

3. ✅ **GET Exceptions - Query by Date Range**
   - Setup: User with exceptions on May 1, 5, 10, 15
   - Action: GET /api/roster/exception/1?start=2026-05-05&end=2026-05-15
   - Expected: Only May 5, 10, 15 (within range)
   - Assertions:
     - Status 200
     - Filters to date range
     - Returns 3 exceptions

---

#### DELETE /api/roster/exception/:userId/:date

**Test Cases:**

1. ✅ **DELETE Exception - Valid**
   - Setup: Exception exists for user on date
   - Action: DELETE /api/roster/exception/1/2026-05-06
   - Expected: Exception deleted
   - Assertions:
     - Status 200
     - Returns { success: true }
     - GET /api/roster/exception/1/2026-05-06 returns 404

2. ✅ **DELETE Exception - Not Found**
   - Setup: No exception for this date/user
   - Action: DELETE /api/roster/exception/1/2026-05-06
   - Expected: Not found or already deleted
   - Assertions:
     - Status 404 or 200 (idempotent)
     - Clear error message if 404

3. ✅ **DELETE Exception - Unauthorized**
   - Setup: OPS_AGENT trying to delete another user's exception
   - Action: DELETE for different user
   - Expected: Authorization check
   - Assertions:
     - Status 403 if restricted
     - Status 200 if allowed (policy dependent)

---

### Database & ORM Tests

#### WeeklySchedule Model

1. ✅ **Create Schedule - Valid Record**
   - Test: Create 7 WeeklySchedule records (one per day)
   - Verify: All saved correctly
   - Assertions:
     - 7 records in database
     - Each has unique (teamMemberId, dayOfWeek) pair
     - startTime/endTime/breakStart/breakEnd saved in HH:MM format

2. ✅ **Unique Constraint - One Schedule Per Day**
   - Test: Try to create two schedules for same user on same day
   - Expected: Database unique constraint violation
   - Assertions:
     - Second insert fails
     - Error includes: "Unique constraint failed on (teamMemberId, dayOfWeek)"

3. ✅ **Index Performance - Query by teamMemberId**
   - Test: Query all schedules for user
   - Expected: Uses index on teamMemberId
   - Assertions:
     - Query plan uses index
     - <10ms execution time

4. ✅ **Cascade Delete - Remove User**
   - Test: Delete team member with schedules
   - Expected: Schedules cascade delete
   - Assertions:
     - All WeeklySchedule records for user deleted
     - No orphaned records

---

#### RosterException Model

1. ✅ **Create Exception - Valid Record**
   - Test: Create exception with all fields
   - Verify: Saved correctly
   - Assertions:
     - Record in database
     - Composite key (teamMemberId, date) unique
     - status is one of: ON_LEAVE, SICK, OFF
     - createdAt and updatedAt set automatically

2. ✅ **Allow Multiple Exceptions - Different Dates**
   - Test: Create 3 exceptions for same user on different dates
   - Expected: All saved
   - Assertions:
     - 3 records exist
     - No unique constraint violation

3. ✅ **Prevent Duplicate - Same Date**
   - Test: Try to create two exceptions for same user/date
   - Expected: Violation
   - Assertions:
     - Second insert fails
     - Unique constraint error

4. ✅ **Index Performance - Query by Date Range**
   - Test: Query exceptions between date1 and date2
   - Expected: Uses index on (teamMemberId, date)
   - Assertions:
     - Query <20ms
     - Index used in query plan

5. ✅ **Cascade Delete - Remove User**
   - Test: Delete user with exceptions
   - Expected: Exceptions cascade delete
   - Assertions:
     - No orphaned exception records

---

### Utility Function Tests

#### Time Validation

1. ✅ **isValidTimeFormat()**
   - Test cases:
     - "09:00" → true
     - "17:30" → true
     - "00:00" → true
     - "23:59" → true
     - "24:00" → false (invalid hour)
     - "09:60" → false (invalid minute)
     - "9:00" → false (not zero-padded)
     - "9AM" → false (not 24-hour)

2. ✅ **isTimeAfter()**
   - Test cases:
     - isTimeAfter("17:00", "09:00") → true
     - isTimeAfter("09:00", "17:00") → false
     - isTimeAfter("09:00", "09:00") → false (equal)

3. ✅ **isTimeWithin(time, start, end)**
   - Test cases:
     - isTimeWithin("12:00", "09:00", "17:00") → true
     - isTimeWithin("08:00", "09:00", "17:00") → false
     - isTimeWithin("18:00", "09:00", "17:00") → false

---

#### Daily Roster Calculation

1. ✅ **calculateDailyRoster(date)**
   - Setup: Multiple users with schedules and exceptions
   - Test: Calculate roster for 2026-05-06 (Monday)
   - Expected:
     - For user 1 (Mon working 09:00-17:00, no exception): status=ACTIVE, scheduled shown
     - For user 2 (Mon working 09:00-17:00, exception ON_LEAVE): status=ON_LEAVE, exception shown
     - For user 3 (Sat OFF): status=OFF, scheduled.isWorking=false
   - Assertions:
     - Correct number of users returned
     - Schedule correctly pulled from WeeklySchedule
     - Exception correctly overrides schedule
     - Break times included if present

2. ✅ **getDayOfWeek(date)**
   - Test cases:
     - 2026-05-04 (Monday) → 1 (or 0 if Sunday-based)
     - 2026-05-05 (Tuesday) → 2
     - 2026-05-03 (Sunday) → 0
   - Assertions:
     - Correct day of week returned
     - Matches database storage format

---

## Integration Tests

### Schedule + Daily Roster Flow

1. ✅ **End-to-End: Create Schedule, Then View Roster**
   - Setup: Fresh database
   - Steps:
     1. Create user with team member
     2. POST schedule (Mon-Fri 09:00-17:00, Sat-Sun OFF)
     3. GET /api/roster/daily for Monday
   - Expected: Roster shows user as 09:00-17:00
   - Assertions:
     - Schedule saved correctly
     - Daily roster calculation uses schedule
     - No exceptions, so schedule is displayed

2. ✅ **Schedule + Exception Flow**
   - Setup: User with schedule (Mon 09:00-17:00)
   - Steps:
     1. POST exception (Mon, ON_LEAVE)
     2. GET /api/roster/daily for Monday
   - Expected: Roster shows ACTIVE_LEAVE, not schedule
   - Assertions:
     - Exception correctly overrides schedule
     - Both schedule and exception in response (one marked active)

3. ✅ **Multiple Users with Mixed Statuses**
   - Setup: 5 users with different schedules and exceptions
   - Steps:
     1. User 1: Mon-Fri 09-17
     2. User 2: Mon-Fri 09-17 + exception (Leave)
     3. User 3: Tue-Thu 10-18
     4. User 4: Sat OFF
     5. User 5: No schedule
   - Action: GET daily roster for Monday
   - Expected:
     - User 1: Scheduled 09-17
     - User 2: Exception Leave
     - User 3: OFF (not scheduled)
     - User 4: OFF
     - User 5: No schedule
   - Assertions:
     - All correctly displayed
     - Status calculation accurate for each

---

### Task Assignment Integration

1. ✅ **Prevent Assignment to OFF Users**
   - Setup: User marked OFF or exception SICK
   - Action: Try to assign task for that day
   - Expected: Assignment validation rejects
   - Assertions:
     - GET /api/roster/daily shows OFF/SICK
     - Task engine checks roster before assigning
     - Task is not assigned to unavailable user

2. ✅ **Allow Assignment to ACTIVE Users**
   - Setup: User with schedule (working today) and no exception
   - Action: Try to assign task
   - Expected: Assignment allowed
   - Assertions:
     - GET /api/roster/daily shows ACTIVE
     - Task can be assigned

3. ✅ **Respect Schedule Times**
   - Setup: User working Mon-Thu only, not Friday
   - Action: Try to assign task for Friday
   - Expected: Validation considers roster
   - Assertions:
     - GET /api/roster/daily/Friday shows OFF
     - Task assignment respects this

---

## UI Component Tests

### ScheduleTab Component

#### Unit Tests

1. ✅ **Render Schedule Form**
   - Setup: Mount component with userId
   - Expected: Form with 7 day sections
   - Assertions:
     - All 7 days displayed (Monday-Sunday)
     - Each day has toggle "Working/Off"
     - Working days show time inputs

2. ✅ **Load Existing Schedule**
   - Setup: User with existing schedule
   - Action: Mount component
   - Expected: Form pre-filled with saved data
   - Assertions:
     - Mon toggle is ON, times are 09:00 and 17:00
     - Sat toggle is OFF
     - Break times shown if present

3. ✅ **Toggle Day Working/Off**
   - Setup: Component mounted
   - Action: Click Mon toggle OFF
   - Expected: Time inputs disabled
   - Assertions:
     - startTime/endTime inputs become disabled
     - Break inputs become disabled

4. ✅ **Time Input Validation**
   - Setup: Component mounted
   - Action: Type "9:00" in startTime (invalid format)
   - Expected: Real-time validation
   - Assertions:
     - Error message shown: "Use HH:MM format"
     - Save button disabled

5. ✅ **Break Time Optional**
   - Setup: Mon working 09:00-17:00
   - Action: Leave break fields empty
   - Expected: Valid
   - Assertions:
     - No error message
     - Save button enabled
     - Submitted data has breakStart=null, breakEnd=null

6. ✅ **Save Schedule**
   - Setup: Valid form filled
   - Action: Click Save
   - Expected: POST /api/roster/schedule
   - Assertions:
     - Loading indicator shown
     - Success message after save
     - Component re-renders with saved data

7. ✅ **Save Error Handling**
   - Setup: API returns 400 error
   - Action: Click Save with invalid data
   - Expected: Error displayed
   - Assertions:
     - Red error banner shown
     - Error message displays
     - Data not cleared (allows retry)

---

### DailyRosterPage Component

#### Unit Tests

1. ✅ **Render Daily Roster**
   - Setup: Mount with date 2026-05-06
   - Expected: List of team members
   - Assertions:
     - Date shown as "Monday, May 6, 2026"
     - All team members listed
     - Each shows: name, role, scheduled times, status

2. ✅ **Load Roster Data**
   - Setup: API has 3 users with mixed statuses
   - Action: Mount component for Monday
   - Expected: All 3 users shown
   - Assertions:
     - User 1: Scheduled 09:00-17:00, ACTIVE
     - User 2: Exception LEAVE shown, button says [Remove Leave]
     - User 3: Scheduled OFF, [Override - Mark Working] button shown

3. ✅ **Date Navigation**
   - Setup: Component on 2026-05-06
   - Action: Click next day arrow
   - Expected: Loads Tuesday (2026-05-07)
   - Assertions:
     - Title updates to Tuesday
     - Data refreshes for new date
     - Previous state cleared

4. ✅ **Date Picker**
   - Setup: Component mounted
   - Action: Click date picker, select 2026-05-15
   - Expected: Jumps to May 15
   - Assertions:
     - Roster data loads for new date
     - URL updated (or state)

---

### ExceptionDialog Component

#### Unit Tests

1. ✅ **Render Dialog - No Exception**
   - Setup: User with no exception for date
   - Action: Click [Mark as Leave] button
   - Expected: Dialog opens
   - Assertions:
     - Dialog title: "Mark as Leave"
     - User name shown
     - Date shown
     - Optional note field empty
     - [Mark as Leave] and [Cancel] buttons shown

2. ✅ **Render Dialog - With Exception**
   - Setup: User with SICK exception for date
   - Action: Click member with exception
   - Expected: Dialog shows exception details
   - Assertions:
     - Title: "Update Exception" or "Exception Details"
     - Current status shown: SICK
     - Note field pre-filled
     - [Update], [Remove], [Cancel] buttons

3. ✅ **Create Exception**
   - Setup: Dialog open for Leave
   - Action: Enter note "Vacation planned", click [Mark as Leave]
   - Expected: Exception created
   - Assertions:
     - API POST called with correct data
     - Dialog closes
     - Roster updates to show LEAVE status
     - Note visible in roster

4. ✅ **Update Exception**
   - Setup: SICK exception exists, dialog open
   - Action: Change note to "Headache", click [Update]
   - Expected: Exception updated
   - Assertions:
     - API PATCH/PUT called
     - Note updated in roster display
     - Status unchanged

5. ✅ **Remove Exception**
   - Setup: LEAVE exception exists
   - Action: Click [Remove Leave] or [Remove Exception]
   - Expected: Exception deleted
   - Assertions:
     - API DELETE called
     - Dialog closes
     - Roster reverts to schedule
     - Status changes from LEAVE to ACTIVE

6. ✅ **Cancel Dialog**
   - Setup: Dialog open with unsaved note
   - Action: Click [Cancel]
   - Expected: Dialog closes, no API call
   - Assertions:
     - No changes made
     - Roster unchanged

---

## Validation Tests

### Time Format Validation

1. ✅ **Valid Formats**
   - "00:00", "09:00", "12:30", "17:45", "23:59" → All accepted

2. ✅ **Invalid Formats**
   - "9:00" → Missing zero-padding
   - "09:0" → Single digit minute
   - "09:00:00" → Seconds included
   - "9AM" → 12-hour format
   - "25:00" → Invalid hour
   - "09:60" → Invalid minute

---

### Business Logic Validation

1. ✅ **Work Hours Validation**
   - Test: startTime before endTime
   - Test: startTime = endTime (invalid)
   - Test: endTime before startTime (invalid)

2. ✅ **Break Time Validation**
   - Test: Break within work hours (valid)
   - Test: Break starts before work (invalid)
   - Test: Break ends after work (invalid)
   - Test: Break with zero duration (breakStart = breakEnd, invalid)
   - Test: Break span more than 2 hours (business rule check)

3. ✅ **Date Validation**
   - Test: Valid YYYY-MM-DD format
   - Test: Invalid formats: YYYY/MM/DD, MM-DD-YYYY, DD-MM-YYYY
   - Test: Invalid dates: 2026-02-30 (Feb 30), 2026-13-01 (month 13)

---

## Authorization & Security Tests

### Role-Based Access Control

1. ✅ **OPS_HEAD**
   - Can: View all schedules, create/edit own, edit any team member
   - Test: Create, read, update schedules for other users → 200 OK
   - Assertions: All operations succeed

2. ✅ **OPS_AGENT**
   - Can: View own schedule only, request exceptions (?) 
   - Test: Try to read other user's schedule → 403 Forbidden
   - Test: Try to edit own schedule → 200 OK
   - Test: Try to edit other user's schedule → 403 Forbidden
   - Assertions: Correct permissions enforced

3. ✅ **STORE_ADMIN**
   - Can: View and manage schedules for store members
   - Test: Manage users in assigned store → 200 OK
   - Test: Manage users in other store → 403 Forbidden
   - Assertions: Store-scoped permissions enforced

---

### Data Security

1. ✅ **No Sensitive Data Leakage**
   - Test: Schedule response doesn't include passwords, auth tokens
   - Assertions: Only necessary fields returned

2. ✅ **Exception Audit Trail**
   - Test: createdBy and createdAt fields recorded
   - Assertions: All exceptions traceable to who created them

---

## Edge Cases & Error Scenarios

### Date/Time Edge Cases

1. ✅ **Daylight Saving Time**
   - Test: Schedule spanning DST transition (if applicable in timezone)
   - Expected: Times stored as absolute values, no automatic adjustment
   - Assertions: Time values remain consistent

2. ✅ **Leap Year**
   - Test: Create exception for Feb 29 in leap year
   - Expected: Allowed
   - Assertions: Stored and retrieved correctly

3. ✅ **Midnight Shifts**
   - Test: startTime=23:00, endTime=01:00 (next day?)
   - Expected: Validation error or special handling
   - Assertions: Clear error or documented behavior

4. ✅ **Very Long Work Days**
   - Test: startTime=06:00, endTime=22:00 (16 hours)
   - Expected: Allowed (business rule dependent)
   - Assertions: Saved and displayed correctly

5. ✅ **Concurrent Exception Updates**
   - Test: Two requests trying to create exception simultaneously
   - Expected: One succeeds, one gets conflict
   - Assertions: No duplicate exceptions, race condition handled

---

### Data Integrity

1. ✅ **Partial Schedule Update**
   - Test: POST update with only 3 of 7 days
   - Expected: Clear behavior (replace all or merge?)
   - Assertions: Documented and consistent

2. ✅ **Delete User with Schedule & Exceptions**
   - Test: Delete team member
   - Expected: Cascade delete schedules and exceptions
   - Assertions: No orphaned records remain

3. ✅ **Invalid Data in Database**
   - Test: Manually insert invalid data (invalid time format)
   - Expected: API queries still work, return error or fix
   - Assertions: Graceful handling, no crashes

---

## Performance Tests

### Load Testing

1. ✅ **GET Daily Roster - Many Users**
   - Test: 1000 team members, get daily roster
   - Expected: <500ms response
   - Assertions: Completes within timeout, index usage verified

2. ✅ **GET Schedule History - Large Date Range**
   - Test: Query exceptions for 365 days for one user
   - Expected: <100ms
   - Assertions: Index on (teamMemberId, date) used

3. ✅ **POST Exception - Bulk Create**
   - Test: Create 100 exceptions in rapid succession
   - Expected: All created, no race conditions
   - Assertions: All 100 exist in database

---

## Testing Infrastructure

### Test Database Setup

```typescript
// beforeEach: Reset database to clean state
beforeEach(async () => {
  await prisma.rosterException.deleteMany({});
  await prisma.weeklySchedule.deleteMany({});
  await prisma.teamMember.deleteMany({});
  await prisma.user.deleteMany({});
});

// afterAll: Clean up
afterAll(async () => {
  await prisma.$disconnect();
});
```

### Seed Data

```typescript
const seedTestData = async () => {
  // Create users
  const user1 = await prisma.user.create({
    data: { email: "user1@test.com", role: "OPS_AGENT" }
  });
  
  // Create team members
  const tm1 = await prisma.teamMember.create({
    data: { userId: user1.id, maxConcurrentTasks: 5 }
  });
  
  // Create schedules
  await prisma.weeklySchedule.create({
    data: {
      teamMemberId: tm1.id,
      dayOfWeek: 1,
      isWorking: true,
      startTime: "09:00",
      endTime: "17:00"
    }
  });
};
```

---

## Test Coverage Goals

| Component | Unit | Integration | E2E | Target |
|-----------|------|-------------|-----|--------|
| API Endpoints | 85% | 90% | 80% | 90%+ |
| Database Queries | 80% | 95% | - | 90%+ |
| React Components | 75% | 85% | 70% | 85%+ |
| Validation Logic | 95% | 95% | - | 95%+ |
| **Overall** | | | | **85%+** |

---

## Testing Timeline

- **Phase 1 (Day 1)**: Set up test infrastructure, seed data, run unit tests
- **Phase 2 (Day 2)**: Integration tests, component tests, fix failures
- **Phase 3 (Day 3)**: Edge cases, performance tests, security tests
- **Phase 4 (Day 4)**: End-to-end flows, regression tests, documentation

---

**See Also**: [Feature Specification](FEATURE_SPEC.md) | [Technical Specification](TECHNICAL_SPEC.md)
