# Sorting Feature: Edge Cases & Production Considerations

## 1. NULL Appointment Time Handling

**Scenario:** Some tasks have `appointmentTime = NULL` (not yet scheduled for appointment).

**Behavior:**
- When sorting by `appointmentTime`, NULL values appear **at the end** regardless of sort direction (asc or desc).
- This is achieved via the Prisma orderBy clause which naturally handles NULLs at end.
- Tiebreaker: tasks with same appointment time sorted by `priority DESC` (URGENT first).

**Why:** Users expect scheduled appointments first, with unscheduled tasks grouped at the end.

**Database Index Optimization:**
```sql
CREATE INDEX "tasks_appointmentTime_idx" ON "tasks"(
  "appointmentTime" DESC NULLS LAST
) WHERE "isArchived" = false;
```

---

## 2. Tiebreaker Hierarchy

When multiple tasks have identical sort values, they're ordered by:

| Sort Field | Primary Tiebreaker | Secondary Tiebreaker |
|------------|-------------------|----------------------|
| `createdAt` | None | N/A |
| `appointmentTime` | `priority DESC` | `createdAt ASC` |
| `slaDeadline` | `priority DESC` | `createdAt ASC` |
| `status` | `priority DESC` | `createdAt ASC` |
| `priority` | `createdAt ASC` | N/A |

**Rationale:** 
- `createdAt` as secondary tiebreaker (FIFO principle for same-priority tasks).
- `priority` as primary tiebreaker for date-based sorts (URGENT tasks bubble up even if dates match).

---

## 3. Enum Ordering (Status Sort)

TaskStatus enum defines this order in PostgreSQL:
```
CREATED → ASSIGNED → IN_PROGRESS → COMPLETED → BLOCKED → BREACHED → CANCELLED
```

When sorting by `status ASC`, tasks appear in this workflow order. This is natural because the enum is defined in this sequence in schema.prisma.

**SQL Verification:**
```sql
SELECT * FROM "tasks" 
WHERE "isArchived" = false 
ORDER BY status ASC, "createdAt" ASC 
LIMIT 20;
```

---

## 4. Role-Based Filtering + Sorting

Sorting applies **after** role-based filtering:

```javascript
// Role filtering (where clause)
const where = { ...roleBasedWhere, isArchived: false };

// Sorting (orderBy clause) - independent of role
const orderBy = buildOrderBy(sortBy, sortOrder);

// Query applies both
prisma.task.findMany({ where, orderBy });
```

**Implication:** 
- OPS_AGENT (assigned tasks only) will see their assigned tasks sorted by the requested field.
- STORE_ADMIN will see only their store's tasks, sorted.
- OPS_HEAD sees all tasks, sorted.

No cross-role data leakage occurs.

---

## 5. Pagination Ordering

Pagination correctly applies **after** sorting:

```javascript
const skip = (page - 1) * limit;
const take = limit;

prisma.task.findMany({ 
  where, 
  orderBy,    // Sort first
  skip,       // Then paginate
  take 
});
```

**Example:** 
- Page 1: Tasks 1-15 in sorted order
- Page 2: Tasks 16-30 in same sorted order (not reordered per page)

---

## 6. Handling Archive Exclusion

The query always excludes archived tasks:
```javascript
where.isArchived = false;
```

This applies regardless of sort field. Archived tasks never appear in results.

---

## 7. Index Strategy for Performance

Five indexes support the 5 sorts:

```sql
-- Index 1: createdAt ascending (for Creation Date sort)
CREATE INDEX "tasks_createdAt_idx" ON "tasks"("createdAt" ASC) 
WHERE "isArchived" = false;

-- Index 2: appointmentTime for Appointment Date sort
CREATE INDEX "tasks_appointmentTime_idx" ON "tasks"("appointmentTime" DESC NULLS LAST) 
WHERE "isArchived" = false;

-- Index 3: slaDeadline for SLA Deadline sort
CREATE INDEX "tasks_slaDeadline_idx" ON "tasks"("slaDeadline" ASC) 
WHERE "isArchived" = false;

-- Index 4: status for Status sort with tiebreaker
CREATE INDEX "tasks_status_createdAt_idx" ON "tasks"("status", "createdAt" ASC) 
WHERE "isArchived" = false;

-- Index 5: priority for Priority sort with tiebreaker
CREATE INDEX "tasks_priority_createdAt_idx" ON "tasks"("priority" DESC, "createdAt" ASC) 
WHERE "isArchived" = false;
```

All include `WHERE "isArchived" = false` to optimize for active (non-archived) tasks.

**Performance Target:** < 500ms for queries with limit=50.

---

## 8. Default Sort Behavior

When `sortBy` and `sortOrder` are **not** provided:

```javascript
const sortByParam = searchParams.get("sortBy") ?? "priority";      // DEFAULT
const sortOrderParam = searchParams.get("sortOrder") ?? "desc";    // DEFAULT
```

**Default Behavior:**
- Sorts by: `priority DESC, slaDeadline ASC` (tiebreaker)
- Matches the existing behavior before sorting was added.
- Maintains backwards compatibility.

---

## 9. Input Validation

**Valid sortBy values:**
```
["createdAt", "appointmentTime", "slaDeadline", "status", "priority"]
```

**Valid sortOrder values:**
```
["asc", "desc"]
```

Invalid values return **400 Bad Request** with error message listing valid options:
```json
{
  "error": "Invalid sortBy. Valid options: createdAt, appointmentTime, slaDeadline, status, priority"
}
```

---

## 10. Frontend State Management

**Recommended Implementation:**
```javascript
// Store sort state in URL parameters for:
// 1. Deep linking (shareable URLs)
// 2. Browser history navigation
// 3. Session persistence across page refreshes

const sortBy = new URLSearchParams(window.location.search).get("sortBy") ?? "priority";
const sortOrder = new URLSearchParams(window.location.search).get("sortOrder") ?? "desc";

// When sort changes, update URL
window.history.replaceState({}, "", `?sortBy=${sortBy}&sortOrder=${sortOrder}`);
```

---

## 11. NULL Appointment Time Edge Case Example

**Scenario:** User has 5 tasks, 2 with appointmentTime, 3 without.

**Database state:**
```
id | title         | appointmentTime       | priority
1  | Task A        | 2026-05-05T10:00:00Z  | HIGH
2  | Task B        | 2026-05-10T14:30:00Z  | URGENT
3  | Task C        | NULL                  | MEDIUM
4  | Task D        | NULL                  | LOW
5  | Task E        | NULL                  | URGENT
```

**Query:** `GET /api/tasks?sortBy=appointmentTime&sortOrder=asc`

**Result (expected):**
```json
{
  "tasks": [
    { "id": 1, "title": "Task A", "appointmentTime": "2026-05-05T10:00:00Z", "priority": "HIGH" },
    { "id": 2, "title": "Task B", "appointmentTime": "2026-05-10T14:30:00Z", "priority": "URGENT" },
    { "id": 5, "title": "Task E", "appointmentTime": null, "priority": "URGENT" },     // NULL at end
    { "id": 3, "title": "Task C", "appointmentTime": null, "priority": "MEDIUM" },    // NULL at end
    { "id": 4, "title": "Task D", "appointmentTime": null, "priority": "LOW" }        // NULL at end
  ]
}
```

Note: Tasks 5, 3, 4 have NULL appointmentTime, sorted by priority DESC (URGENT, MEDIUM, LOW).

---

## 12. Query Plan Analysis

**Sample Query:**
```sql
SELECT * FROM "tasks"
WHERE "isArchived" = false
ORDER BY "priority" DESC, "createdAt" ASC
LIMIT 20;
```

**Efficient Plan (with index):**
```
Index Scan using tasks_priority_createdAt_idx (cost=0.42..5.32 rows=20)
  Index Cond: (isArchived = false)
  Limit: 20
```

Without index, would require full table scan (expensive).

---

## 13. Backwards Compatibility

**Existing Code:**
```javascript
// Old API calls without sortBy/sortOrder still work
GET /api/tasks?status=OPEN&limit=20
// Defaults to: sortBy=priority, sortOrder=desc (previous behavior)
```

**No Breaking Changes:**
- All existing queries continue to work
- Default sort maintains previous behavior
- New parameters are optional

---

## 14. Error Responses

**400 Bad Request Examples:**

Invalid sortBy:
```json
{ "error": "Invalid sortBy. Valid options: createdAt, appointmentTime, slaDeadline, status, priority" }
```

Invalid sortOrder:
```json
{ "error": "Invalid sortOrder. Valid options: asc, desc" }
```

Unauthorized (no auth token):
```json
{ "error": "Unauthorized" }
```

---

## 15. Response Format

**Successful Response:**
```json
{
  "tasks": [ { ... }, { ... } ],
  "pagination": {
    "page": 1,
    "limit": 15,
    "total": 342,
    "pages": 23
  },
  "sorting": {
    "sortBy": "priority",
    "sortOrder": "desc"
  }
}
```

The `sorting` field echoes back the applied sort parameters for UI state synchronization.

---

## 16. Migration Backfill Logic

**Migration SQL:**
```sql
UPDATE "tasks"
SET "appointmentTime" = "createdAt" + INTERVAL '3 hours'
WHERE "appointmentTime" IS NULL AND "isArchived" = false;
```

**Rationale:**
- Backfills NULL appointmentTime with a sensible default (3 hours from task creation).
- Prevents NULL-heavy result sets in early queries.
- Can be overwritten when actual appointment is scheduled.

**Verification:**
```sql
SELECT COUNT(*) FROM "tasks" WHERE "appointmentTime" IS NULL;
-- Should return 0 or very low number after migration
```

---

## 17. Monitoring & Observability

**Metrics to track:**
1. Query execution time (target: <500ms)
2. Index usage (verify indexes are being used)
3. NULL handling accuracy (verify NULLs appear at end)
4. Invalid sort parameter requests (should be rare after UI validation)

**Database Query to Verify Index Usage:**
```sql
EXPLAIN ANALYZE 
SELECT * FROM "tasks"
WHERE "isArchived" = false
ORDER BY "appointmentTime" DESC NULLS LAST, "priority" DESC, "createdAt" ASC
LIMIT 20;
```

Should show `Index Scan using tasks_appointmentTime_idx`.

---

## Summary

**Key Production Considerations:**
1. NULL values handled gracefully (appear at end)
2. Tiebreakers ensure consistent, predictable ordering
3. Five optimized indexes support fast queries
4. Role-based filtering independent of sorting
5. Pagination works correctly with sorting
6. Default behavior maintains backwards compatibility
7. URL parameters enable deep linking and state persistence
8. Comprehensive error messages for invalid parameters
9. Migration backfills NULL values sensibly
10. Performance target of <500ms is achievable with indexes
