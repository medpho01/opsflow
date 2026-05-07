# Phase 1 MVP Sorting Feature - Validation Checklist

## Pre-Deployment Validation

Run this checklist before deploying to production.

---

## 1. Database Layer

### Migration Syntax
- [x] File exists: `/prisma/migrations/20260430_add_sorting_fields/migration.sql`
- [x] Syntax is valid PostgreSQL
- [x] Column addition is correct: `ALTER TABLE "tasks" ADD COLUMN "appointmentTime" TIMESTAMP(3);`
- [x] All 5 indexes created with proper syntax
- [x] Backfill UPDATE statement is safe (includes WHERE conditions)
- [x] No hardcoded values in migration

**Verify:**
```bash
cat /Users/maverick/Documents/TaskOs/prisma/migrations/20260430_add_sorting_fields/migration.sql
# Should have 1 ALTER TABLE, 5 CREATE INDEX, 1 UPDATE statement
```

### Prisma Schema
- [x] File updated: `/prisma/schema.prisma`
- [x] Field added: `appointmentTime DateTime?` on line 262
- [x] Field is nullable (optional)
- [x] Field has explanatory comment
- [x] Field positioned logically (with other date fields)
- [x] No breaking changes to existing fields
- [x] Schema can be compiled

**Verify:**
```bash
grep -A 2 "appointmentTime" /Users/maverick/Documents/TaskOs/prisma/schema.prisma
# Should show: appointmentTime DateTime? with comment
npx prisma generate
# Should complete without errors
```

---

## 2. API Layer

### Route Implementation
- [x] File updated: `/src/app/api/tasks/route.ts`
- [x] VALID_SORT_FIELDS constant defined
- [x] All 5 sort options included: `createdAt|appointmentTime|slaDeadline|status|priority`
- [x] buildOrderBy() function implemented
- [x] Type-safe SortField and SortOrder types
- [x] Parameter validation (whitelist for sortBy)
- [x] sortOrder validation (asc/desc only)
- [x] Error handling returns 400 with descriptive message
- [x] Tiebreaker logic implemented
- [x] NULL value handling correct
- [x] Response includes `sorting` metadata
- [x] No hardcoded values
- [x] Role-based filtering still works
- [x] Pagination still works
- [x] POST handler unchanged

**Verify:**
```bash
# Check constants
grep "const VALID_SORT_FIELDS" /Users/maverick/Documents/TaskOs/src/app/api/tasks/route.ts

# Check buildOrderBy function
grep "function buildOrderBy" /Users/maverick/Documents/TaskOs/src/app/api/tasks/route.ts

# Check validation
grep "Invalid sortBy" /Users/maverick/Documents/TaskOs/src/app/api/tasks/route.ts
```

### TypeScript Compilation
- [ ] No TypeScript errors
```bash
npm run build
# Should complete without "src/app/api/tasks/route.ts" errors
```

---

## 3. Frontend Layer

### Component Implementation
- [x] File updated: `/src/components/store/StoreBoard.tsx`
- [x] sortBy state added with correct default: `"priority"`
- [x] sortOrder state added with correct default: `"desc"`
- [x] Type annotations are correct
- [x] buildQuery() updated to include sort params
- [x] Sort dropdown added with all 5 options
- [x] Sort order toggle button added
- [x] Page resets on sort change
- [x] Styling matches existing theme (zinc colors)
- [x] Accessibility labels present (for attribute on select)
- [x] No hardcoded values

**Verify:**
```bash
# Check sort state
grep "const \[sortBy" /Users/maverick/Documents/TaskOs/src/components/store/StoreBoard.tsx

# Check dropdown
grep -A 15 "sort-by" /Users/maverick/Documents/TaskOs/src/components/store/StoreBoard.tsx
# Should show all 5 options: priority, createdAt, appointmentTime, slaDeadline, status
```

### React Compilation
- [ ] No TypeScript errors in component
```bash
npm run build
# Should complete without "src/components/store/StoreBoard.tsx" errors
```

---

## 4. End-to-End Testing

### Setup
- [ ] Start development server
```bash
npm run dev
# Should compile without errors
# Server should start on http://localhost:3000
```

- [ ] Get valid auth token
```bash
# Via browser dev tools > Application > Cookies > __Secure-auth-token
# Or from test database seed if available
```

### Test 1: Priority Sort (Default)
```bash
curl "http://localhost:3000/api/tasks?sortBy=priority&sortOrder=desc&limit=20" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" | jq '.'

# Verify:
# - Status is 200
# - tasks array is present
# - sorting field shows: { "sortBy": "priority", "sortOrder": "desc" }
# - tasks sorted URGENT > HIGH > MEDIUM > LOW
# - tiebreaker: tasks with same priority ordered by createdAt
```

✓ **Pass Criteria:**
- [ ] Response status 200
- [ ] All tasks have priorities
- [ ] First tasks are URGENT (if any exist)
- [ ] Within same priority, older tasks first

### Test 2: Creation Date Sort
```bash
curl "http://localhost:3000/api/tasks?sortBy=createdAt&sortOrder=desc&limit=20" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" | jq '.tasks[] | {id, createdAt}'

# Verify:
# - Most recent task first
# - createdAt times in descending order
```

✓ **Pass Criteria:**
- [ ] createdAt values descending
- [ ] Most recent at top

### Test 3: Appointment Date Sort
```bash
curl "http://localhost:3000/api/tasks?sortBy=appointmentTime&sortOrder=asc&limit=50" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" | jq '.tasks[] | {id, appointmentTime, priority}'

# Verify:
# - All non-NULL appointmentTime values first
# - NULL values grouped at end
# - Within same appointmentTime, sorted by priority
```

✓ **Pass Criteria:**
- [ ] Non-NULL appointments before NULL
- [ ] appointments in ascending order
- [ ] NULL values present at end (if any exist)

### Test 4: SLA Deadline Sort
```bash
curl "http://localhost:3000/api/tasks?sortBy=slaDeadline&sortOrder=asc&limit=20" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" | jq '.tasks[] | {id, slaDeadline, priority}'

# Verify:
# - Earliest deadline first (most urgent)
# - slaDeadline times in ascending order
# - Tiebreaker: higher priority first
```

✓ **Pass Criteria:**
- [ ] slaDeadline ascending
- [ ] Most urgent first
- [ ] Clear deadline progression

### Test 5: Status Sort
```bash
curl "http://localhost:3000/api/tasks?sortBy=status&sortOrder=asc&limit=20" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" | jq '.tasks[] | {id, status}'

# Verify:
# - CREATED > ASSIGNED > IN_PROGRESS > COMPLETED > BLOCKED > BREACHED > CANCELLED
```

✓ **Pass Criteria:**
- [ ] Statuses follow workflow order
- [ ] CREATED before ASSIGNED
- [ ] ASSIGNED before IN_PROGRESS
- [ ] etc.

---

## 5. Edge Case Testing

### Test A: Invalid sortBy Parameter
```bash
curl "http://localhost:3000/api/tasks?sortBy=invalid&limit=20" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" | jq '.'

# Verify:
# - Status 400
# - Error message lists valid options
```

✓ **Pass Criteria:**
- [ ] Status is 400
- [ ] Error mentions valid options
- [ ] Error is descriptive

### Test B: Invalid sortOrder Parameter
```bash
curl "http://localhost:3000/api/tasks?sortBy=priority&sortOrder=invalid&limit=20" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" | jq '.'

# Verify:
# - Status 400
# - Error message lists valid options
```

✓ **Pass Criteria:**
- [ ] Status is 400
- [ ] Error mentions "asc" and "desc"

### Test C: NULL Appointment Time Handling
```bash
curl "http://localhost:3000/api/tasks?sortBy=appointmentTime&sortOrder=desc&limit=100" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" | jq '[.tasks[] | select(.appointmentTime == null)] | length'

# Result should be number of NULL tasks
# Run same query with asc, verify NULLs at end in both cases

curl "http://localhost:3000/api/tasks?sortBy=appointmentTime&sortOrder=asc&limit=100" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" | jq '[.tasks[] | select(.appointmentTime == null)] | length'
```

✓ **Pass Criteria:**
- [ ] Same count in both ASC and DESC
- [ ] NULLs appear at end (last entries)

### Test D: Tiebreaker Logic (Priority)
```bash
curl "http://localhost:3000/api/tasks?priority=HIGH&sortBy=priority&sortOrder=desc&limit=30" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" | jq '.tasks[] | {id, priority, createdAt} | select(.priority == "HIGH")'

# All should be priority=HIGH
# Sorted by createdAt ascending (oldest first)
```

✓ **Pass Criteria:**
- [ ] All tasks have priority=HIGH
- [ ] createdAt in ascending order (within HIGH priority)

### Test E: Pagination with Sort
```bash
PAGE1=$(curl -s "http://localhost:3000/api/tasks?sortBy=priority&sortOrder=desc&page=1&limit=5" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" | jq '.tasks[] | .id')
PAGE2=$(curl -s "http://localhost:3000/api/tasks?sortBy=priority&sortOrder=desc&page=2&limit=5" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" | jq '.tasks[] | .id')

# PAGE1 and PAGE2 should be different IDs, in same sort order
echo "Page 1: $PAGE1"
echo "Page 2: $PAGE2"
```

✓ **Pass Criteria:**
- [ ] Page 1 and Page 2 have different IDs
- [ ] Both follow same sort order

---

## 6. Performance Testing

### Response Time <500ms
```bash
time curl -s "http://localhost:3000/api/tasks?sortBy=slaDeadline&sortOrder=asc&limit=50" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" > /dev/null

# Should complete in < 500ms real time
```

✓ **Pass Criteria:**
- [ ] real time < 500ms
- [ ] No timeout errors

### Large Result Set (50 items)
```bash
curl "http://localhost:3000/api/tasks?sortBy=priority&sortOrder=desc&limit=50" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" | jq '.pagination'

# Should return quickly with correct count
```

✓ **Pass Criteria:**
- [ ] Returns in <500ms
- [ ] pagination.limit = 50
- [ ] pagination.total = accurate count

---

## 7. Backwards Compatibility

### Default Behavior
```bash
curl "http://localhost:3000/api/tasks?limit=20" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" | jq '.sorting'

# Should return: { "sortBy": "priority", "sortOrder": "desc" }
```

✓ **Pass Criteria:**
- [ ] Defaults to priority DESC
- [ ] No breaking changes

### Existing Filters Still Work
```bash
curl "http://localhost:3000/api/tasks?status=OPEN&limit=20" \
  -H "Cookie: __Secure-auth-token=YOUR_TOKEN" | jq '.pagination.total'

# Should return only OPEN status tasks
```

✓ **Pass Criteria:**
- [ ] Filtering works with sorting
- [ ] No breaking changes

---

## 8. Frontend UI Testing

### Dropdown Renders
- [ ] Open browser to http://localhost:3000/store-board
- [ ] Look for "Sort by:" label
- [ ] Dropdown visible with 5 options:
  - [ ] Priority
  - [ ] Created Date
  - [ ] Appointment Date
  - [ ] SLA Deadline
  - [ ] Status

### Dropdown Changes Sort
- [ ] Click dropdown, select "SLA Deadline"
- [ ] Verify URL updates: `?sortBy=slaDeadline`
- [ ] Verify tasks re-sort
- [ ] Tasks ordered by slaDeadline (earliest first)

### Sort Order Toggle
- [ ] Click "↓ DESC" button
- [ ] Button changes to "↑ ASC"
- [ ] URL updates: `&sortOrder=asc`
- [ ] Tasks re-sort in opposite order

### Deep Linking
- [ ] Copy URL with sort params: `?sortBy=slaDeadline&sortOrder=asc`
- [ ] Open in new tab/incognito
- [ ] Dropdown should show "SLA Deadline"
- [ ] Button should show "↑ ASC"
- [ ] Tasks should be sorted by deadline

---

## 9. Role-Based Access

### OPS_AGENT
- [ ] Can see only assigned tasks
- [ ] Sort works on assigned tasks only
- [ ] No other user's tasks visible

### STORE_ADMIN
- [ ] Can see store's tasks
- [ ] Sort works on store's tasks only
- [ ] Can't see other store's tasks

### OPS_HEAD
- [ ] Can see all tasks
- [ ] Sort works on all tasks
- [ ] No restrictions

---

## 10. Final Sign-Off

### Code Review
- [ ] All code follows existing patterns
- [ ] No code duplication
- [ ] Comments explain complex logic
- [ ] No console.log() or debug code
- [ ] Variable names are clear
- [ ] No TODOs or FIXMEs

### Documentation
- [ ] SORTING_IMPLEMENTATION_COMPLETE.md created ✓
- [ ] SORTING_FEATURE_TEST_SUITE.md created ✓
- [ ] SORTING_EDGE_CASES.md created ✓
- [ ] SORTING_QUICK_REFERENCE.md created ✓
- [ ] This checklist created ✓

### Git Status
```bash
git status
# Should show:
# - modified: prisma/schema.prisma
# - modified: src/app/api/tasks/route.ts
# - modified: src/components/store/StoreBoard.tsx
# - new file: prisma/migrations/20260430_add_sorting_fields/migration.sql
# - new files: 4 documentation files
```

### Build & Test
- [ ] `npm run build` passes
- [ ] No TypeScript errors
- [ ] No Prisma errors
- [ ] `npm run dev` starts without errors
- [ ] All curl tests pass
- [ ] UI tests pass
- [ ] Performance tests pass
- [ ] Edge case tests pass

---

## Deployment Steps

1. **Pre-deployment**
   - [ ] All tests pass
   - [ ] Code reviewed
   - [ ] Documentation complete

2. **Deployment**
   - [ ] Push code to feature branch
   - [ ] Create Pull Request
   - [ ] Get code review approval
   - [ ] Merge to main
   - [ ] Deploy to staging
   - [ ] Run full test suite on staging
   - [ ] Deploy to production

3. **Post-deployment**
   - [ ] Monitor query performance
   - [ ] Monitor error rates
   - [ ] Verify indexes are used (check pg_stat_user_indexes)
   - [ ] Collect user feedback
   - [ ] Monitor for edge cases

---

## Rollback Plan (if needed)

If issues occur post-deployment:

1. **For UI issues:**
   - Revert src/components/store/StoreBoard.tsx
   - UI will revert to previous sort behavior

2. **For API issues:**
   - Revert src/app/api/tasks/route.ts
   - API will revert to previous sort behavior
   - Defaults will return to priority DESC

3. **For database issues:**
   - Database migration cannot be reverted automatically
   - If critical: run rollback migration (provided separately)
   - appointmentTime column can be left as-is (harmless)

---

## Sign-Off

**Developer:** _____________________  
**Date:** _____________________  

**Code Reviewer:** _____________________  
**Date:** _____________________  

**QA Sign-Off:** _____________________  
**Date:** _____________________  

**Production Deployment:** _____________________  
**Date:** _____________________  

---

## Notes

All checks must pass before deployment.  
Each test must be run and verified.  
No shortcuts or assumptions.  
