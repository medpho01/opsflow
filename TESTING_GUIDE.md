# OpsFlow Testing Guide - Complete End-to-End Validation

## Quick Start

The testing infrastructure is now ready. You have three ways to run tests:

### Option 1: Web Dashboard (Easiest)
```
1. Go to: http://localhost:3000/admin/tests
2. Click "Create All Test Data"
3. Click "Run Archive Job"
4. Review the validation report
```

### Option 2: SQL Fixtures (Direct Database)
```bash
# Load test data directly
psql postgresql://maverick@localhost:5432/labstack < tests/fixtures/test-orders.sql

# Verify creation
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT COUNT(*), COUNT(*) FILTER (WHERE \"isArchived\" = true) 
  FROM taskos.tasks WHERE \"entityId\" >= 50000;
"

# Run archive
curl -X POST http://localhost:3000/api/tasks/archive

# Check results
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT \"entityId\", \"isArchived\", 
    EXTRACT(DAY FROM NOW() - (metadata->>'appointmentTime')::timestamp) as days_old
  FROM taskos.tasks WHERE \"entityId\" >= 50000
  ORDER BY \"entityId\";
"
```

### Option 3: API Endpoint (Programmatic)
```bash
# Create test data
curl -X POST http://localhost:3000/api/tests/validate \
  -H "Content-Type: application/json" \
  -d '{"scenario":"all"}'

# Get validation report
curl http://localhost:3000/api/tests/validate?full=true | jq .

# Run archive (separate call)
curl -X POST http://localhost:3000/api/tasks/archive
```

---

## What Gets Tested

### Test Scenarios Created

1. **Old Injections (25 days ago)** ✓
   - Expected: Tasks archived after archive job
   - Files: Order IDs 50000, 50001

2. **Recent Injections (2 days ago)** ✓
   - Expected: Tasks remain active
   - Files: Order ID 50002

3. **Other Services (22 days ago)** ✓
   - Expected: Tasks archived
   - Files: Order ID 50003

4. **Boundary Case (10 days ago)** ✓
   - Expected: Should archive (exactly at threshold)
   - Files: Order ID 50004

---

## Files Created

### Documentation
- **`TEST_PLAN.md`** - Comprehensive test plan with all scenarios and validation criteria
- **`TESTING_GUIDE.md`** - This file

### Test Code
- **`tests/fixtures/test-orders.sql`** - SQL fixtures to populate test data
- **`src/app/api/tests/validate/route.ts`** - Validation API endpoint (GET/POST)
- **`src/components/admin/TestDashboard.tsx`** - Interactive test control dashboard
- **`src/app/admin/tests/page.tsx`** - Page to access test dashboard

---

## Step-by-Step Test Execution

### Phase 1: Baseline (5 minutes)

```bash
# 1. Check task rules exist
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT name, \"slaMinutes\", priority 
  FROM taskos.task_rules 
  WHERE name LIKE '%Injection%' OR name LIKE '%Other%'
  ORDER BY name;
"

# Expected output: 6 rules (3 for Injection, 3 for Other Services)
```

### Phase 2: Create Test Data (2 minutes)

**Option A: Using Dashboard**
1. Navigate to http://localhost:3000/admin/tests
2. Click "Create All Test Data"
3. Wait for success message

**Option B: Using SQL**
```bash
psql postgresql://maverick@localhost:5432/labstack < tests/fixtures/test-orders.sql
```

**Verify Creation:**
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT 
    COUNT(*) as total,
    COUNT(*) FILTER (WHERE \"isArchived\" = false) as active,
    COUNT(*) FILTER (WHERE \"isArchived\" = true) as archived
  FROM taskos.tasks
  WHERE \"entityId\" >= 50000;
"

# Expected: Should show test tasks created
```

### Phase 3: Run Archive Job (1 minute)

**Option A: Using Dashboard**
1. Click "Run Archive Job" button
2. Wait for success

**Option B: Using API**
```bash
curl -X POST http://localhost:3000/api/tasks/archive
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Archive job executed successfully"
}
```

### Phase 4: Validate Results (3 minutes)

**Using Validation Report:**
```bash
# Get full report
curl http://localhost:3000/api/tests/validate?full=true | jq .
```

**Check Archive Status by Hand:**
```bash
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
-- Show what got archived
SELECT
  "entityId",
  title,
  "isArchived",
  EXTRACT(DAY FROM NOW() - (metadata->>'appointmentTime')::timestamp) as days_old,
  CASE
    WHEN "isArchived" THEN '✓ ARCHIVED'
    ELSE '✗ STILL ACTIVE'
  END as status
FROM taskos.tasks
WHERE "entityId" >= 50000
ORDER BY "entityId";
EOF
```

**Expected Results:**

| entityId | days_old | Status | Expected |
|----------|----------|--------|----------|
| 50000 | 25 | ✓ ARCHIVED | ✓ CORRECT |
| 50001 | 20 | ✓ ARCHIVED | ✓ CORRECT |
| 50002 | 2 | ✗ ACTIVE | ✓ CORRECT |
| 50003 | 22 | ✓ ARCHIVED | ✓ CORRECT |
| 50004 | 10 | ✓ ARCHIVED | ✓ CORRECT |

### Phase 5: Verify UI (2 minutes)

1. Navigate to http://localhost:3000/head/archive
2. Verify test tasks appear in archived list
3. Check that "Days Since Appt" column shows values (should be ~10-25 days)
4. Verify pagination works
5. Check that active tasks view doesn't show archived test tasks

---

## Validation Checklist

### Database Level
- [ ] Test tasks created with correct entityId (50000+)
- [ ] Task rules matched and tasks generated
- [ ] Appointment times stored in metadata correctly
- [ ] SLA deadlines calculated correctly
- [ ] Archive job runs without errors
- [ ] Only 10+ day old tasks are archived
- [ ] Archived tasks have `isArchived = true`

### API Level
- [ ] `/api/tasks/archive` POST works
- [ ] `/api/tasks/archive` GET returns archived tasks
- [ ] Pagination returns correct data
- [ ] `daysSinceAppointment` calculated correctly
- [ ] Response formatting converts BigInt properly

### UI Level
- [ ] Archived tasks view loads
- [ ] Pagination controls work
- [ ] Order IDs visible and clickable
- [ ] "Days Since Appt" column displays values
- [ ] Active tasks don't show archived orders
- [ ] Archive count matches database

### Edge Cases
- [ ] Boundary: 10-day old tasks archive correctly
- [ ] Recent tasks (< 5 days) remain active
- [ ] Old tasks (> 30 days) archive correctly
- [ ] Mixed order types (INJECTION + HOME_SAMPLE) both archive

---

## Debugging

### Problem: No test tasks created

**Check:**
```bash
# Verify task rules exist
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT id, name FROM taskos.task_rules WHERE name LIKE '%Injection%';
"

# Should return 3 injection rules
```

**Fix:**
1. Recreate task rules via dashboard: Task Rules section
2. Ensure INJ_ASSIGN_MEDIC, INJ_PRE_VISIT_CONFIRM, INJ_POST_ADMIN_MONITOR task types exist

### Problem: Archive job doesn't archive old tasks

**Check:**
```bash
# Verify appointment times are correct
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT id, (metadata->>'appointmentTime')::timestamp as appt_time,
    NOW() - INTERVAL '10 days' as cutoff_date,
    (metadata->>'appointmentTime')::timestamp < (NOW() - INTERVAL '10 days') as should_archive
  FROM taskos.tasks WHERE \"entityId\" >= 50000;
"

# All old appointments should have should_archive = true
```

**Check taskArchiver logs:**
```bash
# Look at server output for [TaskArchiver] messages
# Should show: "[TaskArchiver] Archived X old tasks"
```

### Problem: Dashboard not showing test tasks

**Check:**
1. Are test tasks created? (entityId >= 50000)
2. Is the validation API returning data?
   ```bash
   curl http://localhost:3000/api/tests/validate | jq .summary
   ```
3. Try refreshing the dashboard

### Problem: Days Since Appointment showing empty

**Check:**
1. Is `appointmentTime` in metadata?
   ```bash
   psql postgresql://maverick@localhost:5432/labstack -c "
     SELECT id, metadata->>'appointmentTime' as appt
     FROM taskos.tasks WHERE \"entityId\" >= 50000;
   "
   ```
2. Are the values valid ISO 8601 timestamps?
3. Try the /api/tasks/archive endpoint directly to check calculation

---

## Performance Notes

- **Archive Job**: Should complete < 5 seconds for 320+ tasks
- **Test Data Creation**: < 1 second
- **Validation Report**: < 1 second
- **Dashboard Load**: < 2 seconds

If archive job is slow:
- Check if database indexes are being used
- Verify no locking issues
- Check PostgreSQL query performance

---

## Cleanup

### Remove Test Data
```bash
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
DELETE FROM taskos.task_history 
WHERE "taskId" IN (SELECT id FROM taskos.tasks WHERE "entityId" >= 50000);

DELETE FROM taskos.tasks WHERE "entityId" >= 50000;

SELECT COUNT(*) as remaining_test_tasks FROM taskos.tasks WHERE "entityId" >= 50000;
EOF
```

### Reset Archive Status
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  UPDATE taskos.tasks SET \"isArchived\" = false WHERE \"entityId\" >= 50000;
"
```

---

## Next Steps After Testing

1. ✅ **Validate the entire flow works end-to-end**
2. 📊 **Review test results and fix any failures**
3. 🚀 **Deploy to production with confidence**
4. 📈 **Monitor live task creation and archiving**
5. 🔄 **Set up automated testing in CI/CD**

---

## Support

If you encounter issues:

1. Check TEST_PLAN.md for detailed test scenarios
2. Review the task archiver logs in server output
3. Check database directly with SQL queries provided above
4. Review the validation report at `/api/tests/validate?full=true`

