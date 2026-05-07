# Phase 1 MVP Sorting Feature - Test Suite

## Overview
This test suite validates all 5 core sorting options with curl commands. Run against a real instance with sample data.

## Prerequisites
- Running TaskOS server (default: http://localhost:3000)
- Valid auth token (replace `YOUR_TOKEN` with actual session token)
- Sample tasks with various creation dates, appointment times, SLA deadlines, statuses, and priorities

## Test Variables
```bash
# Set these before running tests
BASE_URL="http://localhost:3000"
AUTH_COOKIE="your_session_id_here"  # From browser dev tools
STORE_ID="1"                         # Adjust to your store
```

---

## Test Suite: 5 Core Sorts

### 1. PRIORITY SORT (Default)
Priority sorts from URGENT → HIGH → MEDIUM → LOW with createdAt tiebreaker.

```bash
# Descending (URGENT first) - DEFAULT BEHAVIOR
curl -X GET "${BASE_URL}/api/tasks?sortBy=priority&sortOrder=desc&limit=20" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.tasks[] | {id, title, priority, createdAt}'

# Ascending (LOW first)
curl -X GET "${BASE_URL}/api/tasks?sortBy=priority&sortOrder=asc&limit=20" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.tasks[] | {id, title, priority, createdAt}'
```

**Expected Output:**
- DESC: URGENT tasks first, then HIGH, then MEDIUM, then LOW
- ASC: LOW tasks first, reversed order
- Tiebreaker: Tasks with same priority ordered by createdAt (older first)

---

### 2. CREATION DATE SORT
Sorts by task creation time with desc (newest first) or asc (oldest first).

```bash
# Descending (newest tasks first) - DEFAULT
curl -X GET "${BASE_URL}/api/tasks?sortBy=createdAt&sortOrder=desc&limit=20" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.tasks[] | {id, title, createdAt}'

# Ascending (oldest tasks first)
curl -X GET "${BASE_URL}/api/tasks?sortBy=createdAt&sortOrder=asc&limit=20" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.tasks[] | {id, title, createdAt}'
```

**Expected Output:**
- DESC: Most recent tasks first
- ASC: Oldest tasks first
- All timestamps should be in descending/ascending order

---

### 3. APPOINTMENT DATE SORT
Sorts by appointmentTime (visit/appointment date). NULL values appear at end.

```bash
# Ascending (earliest appointment first) - DEFAULT
curl -X GET "${BASE_URL}/api/tasks?sortBy=appointmentTime&sortOrder=asc&limit=20" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.tasks[] | {id, title, appointmentTime, priority}'

# Descending (latest appointment first)
curl -X GET "${BASE_URL}/api/tasks?sortBy=appointmentTime&sortOrder=desc&limit=20" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.tasks[] | {id, title, appointmentTime, priority}'
```

**Expected Output:**
- ASC: Earliest appointments first, NULL values at end
- DESC: Latest appointments first, NULL values at end
- Tiebreaker: Tasks with same appointment time ordered by priority (URGENT first)

**NULL Handling Test:**
```bash
# Verify NULL values appear at the end regardless of sort direction
curl -X GET "${BASE_URL}/api/tasks?sortBy=appointmentTime&sortOrder=desc&limit=50" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.tasks[] | select(.appointmentTime == null) | {id, title}'
# Should only appear in last few results
```

---

### 4. SLA DEADLINE SORT
Sorts by SLA deadline (most urgent/earliest deadline first in ASC).

```bash
# Ascending (most urgent deadline first) - DEFAULT
curl -X GET "${BASE_URL}/api/tasks?sortBy=slaDeadline&sortOrder=asc&limit=20" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.tasks[] | {id, title, slaDeadline, priority, status}'

# Descending (furthest deadline first)
curl -X GET "${BASE_URL}/api/tasks?sortBy=slaDeadline&sortOrder=desc&limit=20" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.tasks[] | {id, title, slaDeadline, priority, status}'
```

**Expected Output:**
- ASC: Closest deadline first (most urgent tasks)
- DESC: Furthest deadline first
- Tiebreaker: Tasks with same deadline ordered by priority (URGENT first)

---

### 5. STATUS SORT
Sorts by task status (CREATED → ASSIGNED → IN_PROGRESS → COMPLETED → etc.).

```bash
# Ascending (workflow order)
curl -X GET "${BASE_URL}/api/tasks?sortBy=status&sortOrder=asc&limit=20" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.tasks[] | {id, title, status, createdAt}'

# Descending (reverse order)
curl -X GET "${BASE_URL}/api/tasks?sortBy=status&sortOrder=desc&limit=20" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.tasks[] | {id, title, status, createdAt}'
```

**Expected Output:**
- ASC: CREATED tasks first, then ASSIGNED, IN_PROGRESS, COMPLETED, BREACHED, BLOCKED, CANCELLED
- DESC: Reverse of ASC
- Tiebreaker: Tasks with same status ordered by createdAt (older first)

---

## Edge Case Tests

### Test A: Invalid Sort Parameter
Should return 400 with clear error message.

```bash
curl -X GET "${BASE_URL}/api/tasks?sortBy=invalid&limit=20" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.error'

# Expected: "Invalid sortBy. Valid options: createdAt, appointmentTime, slaDeadline, status, priority"
```

### Test B: Invalid Sort Order
Should return 400 with clear error message.

```bash
curl -X GET "${BASE_URL}/api/tasks?sortBy=priority&sortOrder=invalid&limit=20" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.error'

# Expected: "Invalid sortOrder. Valid options: asc, desc"
```

### Test C: Response Includes Sort Metadata
Verify the API echoes back the applied sort parameters.

```bash
curl -X GET "${BASE_URL}/api/tasks?sortBy=priority&sortOrder=desc&limit=5" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.sorting'

# Expected: { "sortBy": "priority", "sortOrder": "desc" }
```

### Test D: Pagination Works With Sorting
Verify pagination applies after sorting (not before).

```bash
# Get page 1
curl -X GET "${BASE_URL}/api/tasks?sortBy=priority&sortOrder=desc&page=1&limit=5" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.pagination'

# Get page 2
curl -X GET "${BASE_URL}/api/tasks?sortBy=priority&sortOrder=desc&page=2&limit=5" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.pagination'

# Verify page 2 starts after page 1 in the sorted order
```

### Test E: Role-Based Filtering Still Works
Verify sort params don't break existing role-based filtering.

```bash
# OPS_AGENT should only see their assigned tasks, sorted
curl -X GET "${BASE_URL}/api/tasks?sortBy=priority&sortOrder=desc&limit=20" \
  -H "Cookie: __Secure-auth-token=${AGENT_AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.tasks[] | {id, assignedToId}'

# All should have same assignedToId (the agent's ID)
```

### Test F: URL Parameter Persistence for Deep Linking
Test that sort state persists in URL for shareable links.

```bash
# Create a shareable link with sort params
SHARE_URL="${BASE_URL}/api/tasks?status=OPEN&sortBy=slaDeadline&sortOrder=asc&storeId=${STORE_ID}"
echo "Share this URL: ${SHARE_URL}"

# Another user clicks it and should get same sorted results
curl -X GET "${SHARE_URL}" \
  -H "Cookie: __Secure-auth-token=${OTHER_AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.sorting'

# Should return: { "sortBy": "slaDeadline", "sortOrder": "asc" }
```

---

## Performance Tests

### Test G: Response Time < 500ms
Verify the API responds quickly even with 50 tasks.

```bash
time curl -s -X GET "${BASE_URL}/api/tasks?sortBy=slaDeadline&sortOrder=asc&limit=50" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" > /dev/null

# Expected: real 0m0.3XX (< 500ms)
```

### Test H: Large Result Set (50 items)
Verify sorting performance with maximum limit.

```bash
curl -X GET "${BASE_URL}/api/tasks?sortBy=priority&sortOrder=desc&limit=50" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.pagination'

# Should return quickly with total count accurate
```

---

## Data Validation Tests

### Test I: Verify Tiebreaker Logic (Priority)
When two tasks have same priority, should be ordered by createdAt.

```bash
curl -X GET "${BASE_URL}/api/tasks?priority=HIGH&sortBy=priority&sortOrder=desc&limit=20" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.tasks[] | {id, priority, createdAt}'

# All should have priority=HIGH, ordered by createdAt ASC
```

### Test J: Verify Tiebreaker Logic (SLA Deadline)
When two tasks have same deadline, should be ordered by priority.

```bash
curl -X GET "${BASE_URL}/api/tasks?sortBy=slaDeadline&sortOrder=asc&limit=30" \
  -H "Cookie: __Secure-auth-token=${AUTH_COOKIE}" \
  -H "Content-Type: application/json" | jq '.tasks[] | {id, slaDeadline, priority} | group_by(.slaDeadline) | .[] | .[0:2]'

# For tasks with same slaDeadline, should be ordered: URGENT, HIGH, MEDIUM, LOW
```

---

## Test Results Template

```
Test Date: ____________________
Environment: ___________________
Sample Data: ___________________

✓ Test 1: Priority Sort DESC
✓ Test 2: Priority Sort ASC
✓ Test 3: Creation Date Sort DESC
✓ Test 4: Creation Date Sort ASC
✓ Test 5: Appointment Date Sort ASC
✓ Test 6: Appointment Date Sort DESC
✓ Test 7: Appointment Date NULL Handling
✓ Test 8: SLA Deadline Sort ASC
✓ Test 9: SLA Deadline Sort DESC
✓ Test 10: Status Sort ASC
✓ Test 11: Status Sort DESC
✓ Test A: Invalid Sort Parameter
✓ Test B: Invalid Sort Order
✓ Test C: Response Includes Sort Metadata
✓ Test D: Pagination Works With Sorting
✓ Test E: Role-Based Filtering Still Works
✓ Test F: URL Parameter Persistence
✓ Test G: Response Time < 500ms
✓ Test H: Large Result Set (50 items)
✓ Test I: Tiebreaker Logic (Priority)
✓ Test J: Tiebreaker Logic (SLA Deadline)

Notes: _______________________________
```

---

## Debugging Commands

### Check Database Indexes
```sql
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename = 'tasks' AND indexname LIKE 'tasks_%idx';
```

### Verify appointmentTime Field
```sql
SELECT id, title, "appointmentTime", "createdAt" 
FROM tasks 
ORDER BY "appointmentTime" DESC NULLS LAST 
LIMIT 10;
```

### Check for NULL Values
```sql
SELECT COUNT(*) as total_null_appointment_times
FROM tasks
WHERE "appointmentTime" IS NULL AND "isArchived" = false;
```

---

## Notes

1. **NULL Handling**: appointmentTime may be NULL for existing tasks that haven't been assigned an appointment. These should appear at the END of results regardless of sort direction.

2. **Tiebreakers**: When multiple tasks have the same sort value (e.g., same priority), they are sorted by:
   - createdAt (ascending, oldest first) as primary tiebreaker
   - For some sorts, priority (descending) as secondary tiebreaker

3. **Performance**: With proper indexing, all sorts should respond in <500ms for up to 50 items.

4. **URL State**: Sort parameters are included in URLs for deep linking and bookmarking. Frontend can persist sort state via URL parameters.

5. **Backwards Compatibility**: The default sort is still priority DESC with slaDeadline ASC (tiebreaker), maintaining existing behavior when sortBy/sortOrder aren't specified.
