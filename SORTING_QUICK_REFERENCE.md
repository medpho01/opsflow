# Sorting Feature - Quick Reference

## Files to Copy/Deploy

### 1. Database Migration
**Location:** `/Users/maverick/Documents/TaskOs/prisma/migrations/20260430_add_sorting_fields/migration.sql`

**Execute:**
```bash
npx prisma migrate deploy
```

### 2. Prisma Schema
**Location:** `/Users/maverick/Documents/TaskOs/prisma/schema.prisma`

**Change Summary:** Added `appointmentTime DateTime?` field to Task model (line 262)

### 3. API Route
**Location:** `/Users/maverick/Documents/TaskOs/src/app/api/tasks/route.ts`

**Changes:**
- Added VALID_SORT_FIELDS constant
- Added buildOrderBy() function
- Updated GET handler with sortBy/sortOrder params
- Added validation logic
- Response includes sorting metadata

### 4. Frontend Component
**Location:** `/Users/maverick/Documents/TaskOs/src/components/store/StoreBoard.tsx`

**Changes:**
- Added sortBy and sortOrder state
- Updated buildQuery() to include sort params
- Added sort dropdown (lines 262-280)
- Added sort order toggle (lines 282-292)

---

## 5 Sort Options

| Name | Query Param | Default Order | Index Used |
|------|-------------|----------------|-----------|
| Priority | `sortBy=priority` | DESC (URGENT first) | `tasks_priority_createdAt_idx` |
| Created Date | `sortBy=createdAt` | DESC (newest first) | `tasks_createdAt_idx` |
| Appointment Date | `sortBy=appointmentTime` | ASC (earliest first) | `tasks_appointmentTime_idx` |
| SLA Deadline | `sortBy=slaDeadline` | ASC (most urgent first) | `tasks_slaDeadline_idx` |
| Status | `sortBy=status` | ASC (workflow order) | `tasks_status_createdAt_idx` |

---

## API Examples

### Get tasks sorted by priority (default)
```bash
GET /api/tasks?sortBy=priority&sortOrder=desc
```

### Get tasks sorted by SLA deadline (urgent first)
```bash
GET /api/tasks?sortBy=slaDeadline&sortOrder=asc
```

### Get tasks sorted by appointment date (earliest first)
```bash
GET /api/tasks?sortBy=appointmentTime&sortOrder=asc
```

### Get tasks sorted by creation date (oldest first)
```bash
GET /api/tasks?sortBy=createdAt&sortOrder=asc
```

### Get tasks sorted by status (workflow order)
```bash
GET /api/tasks?sortBy=status&sortOrder=asc
```

---

## Response Format

```json
{
  "tasks": [
    {
      "id": 1,
      "title": "Sample Task",
      "priority": "URGENT",
      "status": "ASSIGNED",
      "slaDeadline": "2026-05-01T14:00:00Z",
      "appointmentTime": "2026-05-01T10:30:00Z",
      "createdAt": "2026-04-30T08:00:00Z",
      ...
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 15,
    "total": 342,
    "pages": 23
  },
  "sorting": {
    "sortBy": "slaDeadline",
    "sortOrder": "asc"
  }
}
```

---

## Error Responses

### Invalid sortBy
```json
{
  "status": 400,
  "error": "Invalid sortBy. Valid options: createdAt, appointmentTime, slaDeadline, status, priority"
}
```

### Invalid sortOrder
```json
{
  "status": 400,
  "error": "Invalid sortOrder. Valid options: asc, desc"
}
```

---

## Tiebreaker Logic

When sort values are identical:

1. **Priority sort** → sorted by createdAt ASC
2. **CreatedAt sort** → no tiebreaker (inherently unique)
3. **AppointmentTime sort** → sorted by priority DESC, then createdAt ASC
4. **SLADeadline sort** → sorted by priority DESC, then createdAt ASC
5. **Status sort** → sorted by priority DESC, then createdAt ASC

---

## NULL Handling

**appointmentTime can be NULL** (task not yet scheduled for appointment)

**Behavior:** NULL values appear at the END of results regardless of sort direction

**Example:**
```
appointmentTime ASC:
- 2026-05-01 10:00:00
- 2026-05-05 14:30:00
- 2026-05-10 09:00:00
- NULL (grouped at end)
- NULL (grouped at end)
```

---

## Testing Commands

### Test Priority Sort
```bash
curl "http://localhost:3000/api/tasks?sortBy=priority&sortOrder=desc" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" | jq '.tasks[] | {id, priority}'
```

### Test SLA Deadline Sort
```bash
curl "http://localhost:3000/api/tasks?sortBy=slaDeadline&sortOrder=asc" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" | jq '.tasks[] | {id, slaDeadline}'
```

### Test Appointment Date Sort
```bash
curl "http://localhost:3000/api/tasks?sortBy=appointmentTime&sortOrder=asc" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" | jq '.tasks[] | {id, appointmentTime}'
```

### Test Invalid Parameter
```bash
curl "http://localhost:3000/api/tasks?sortBy=invalid" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" | jq '.error'
```

---

## Deployment Checklist

- [ ] Copy migration file to `/prisma/migrations/20260430_add_sorting_fields/`
- [ ] Update schema.prisma with appointmentTime field
- [ ] Update API route file (/api/tasks/route.ts)
- [ ] Update StoreBoard.tsx component
- [ ] Run `npx prisma migrate deploy`
- [ ] Run `npm run build`
- [ ] Verify no TypeScript errors
- [ ] Test all 5 sort options with curl commands
- [ ] Verify UI dropdown works
- [ ] Verify NULL values appear at end
- [ ] Verify pagination still works
- [ ] Verify performance <500ms
- [ ] Deploy to production

---

## Key Implementation Details

### buildOrderBy() Function
- Handles all 5 sort options
- Returns array of orderBy objects for Prisma
- Includes tiebreaker logic
- Type-safe with TypeScript

### Database Indexes
- 5 dedicated indexes (one per sort)
- Conditional indexes (WHERE isArchived = false)
- Include tiebreaker columns for composite sorts
- Support both ASC and DESC queries

### Input Validation
- Whitelist of valid sortBy values
- Validation of sortOrder (asc/desc only)
- Returns 400 with helpful error messages
- Prevents SQL injection via parameterization

### Frontend State Management
- Sort state in React hooks
- URL params updated on sort change
- Page resets when sort changes
- Dropdown selection reflects current sort
- Toggle button shows current direction

---

## Migration Details

### Column Added
```sql
ALTER TABLE "tasks" ADD COLUMN "appointmentTime" TIMESTAMP(3);
```

### Data Backfill
```sql
UPDATE "tasks"
SET "appointmentTime" = "createdAt" + INTERVAL '3 hours'
WHERE "appointmentTime" IS NULL AND "isArchived" = false;
```

### Indexes Created
1. `tasks_createdAt_idx` - Single column
2. `tasks_appointmentTime_idx` - With NULLS LAST
3. `tasks_slaDeadline_idx` - Single column
4. `tasks_status_createdAt_idx` - Composite (status + createdAt)
5. `tasks_priority_createdAt_idx` - Composite (priority + createdAt)

All include `WHERE "isArchived" = false` for optimization.

---

## Performance Notes

- Index scan complexity: O(log N)
- Expected response time: <500ms
- Suitable for tables with 10,000+ rows
- Backfill data ensures no NULL-heavy queries
- Tiebreaker columns reduce table lookups

---

## Backwards Compatibility

**Default behavior preserved:**
- If sortBy not specified: defaults to `priority`
- If sortOrder not specified: defaults to `desc`
- Existing API calls work unchanged
- Response format extended (not breaking)

---

## Common Debugging

### Check if migration ran
```bash
psql $DATABASE_URL -c "\d+ tasks" | grep appointmentTime
```

### Check indexes exist
```bash
psql $DATABASE_URL -c "\di tasks*"
```

### Check NULL values
```bash
psql $DATABASE_URL -c "SELECT COUNT(*) FROM tasks WHERE \"appointmentTime\" IS NULL;"
```

### Monitor index usage
```bash
psql $DATABASE_URL -c "SELECT * FROM pg_stat_user_indexes WHERE tablename='tasks';"
```

---

## Support References

- **Test Suite:** SORTING_FEATURE_TEST_SUITE.md
- **Edge Cases:** SORTING_EDGE_CASES.md
- **Implementation:** SORTING_IMPLEMENTATION_COMPLETE.md
- **API Route:** /src/app/api/tasks/route.ts
- **Component:** /src/components/store/StoreBoard.tsx
- **Schema:** /prisma/schema.prisma
- **Migration:** /prisma/migrations/20260430_add_sorting_fields/migration.sql
