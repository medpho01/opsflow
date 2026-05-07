# OpsFlow Testing Infrastructure - Complete Setup

## Overview

A complete end-to-end testing framework has been created to validate the entire task lifecycle:
- ✅ Order creation
- ✅ Task rule matching
- ✅ Task creation
- ✅ Status transitions
- ✅ Automatic archiving
- ✅ Archived task retrieval

---

## What You Have

### 📋 Documentation (3 files)
1. **`TEST_PLAN.md`** - Comprehensive testing strategy with 6 scenarios
2. **`TESTING_GUIDE.md`** - Step-by-step execution guide
3. **`TESTING_README.md`** - This file

### 🔧 Test Infrastructure (4 files)
1. **`tests/fixtures/test-orders.sql`** - SQL fixtures for test data creation
2. **`src/app/api/tests/validate/route.ts`** - Validation API endpoint
3. **`src/components/admin/TestDashboard.tsx`** - Interactive control dashboard
4. **`src/app/admin/tests/page.tsx`** - Dashboard page

### 📊 Test Coverage
- **6 core scenarios** (injection, services, recent, old, boundary cases)
- **4 validation methods** (API, SQL, Dashboard, Direct Database)
- **Complete workflow** (creation → assignment → completion → archiving)

---

## Quick Start (5 minutes)

### 1️⃣ Access Test Dashboard
```
Open: http://localhost:3000/admin/tests
```

### 2️⃣ Create Test Data
Click "Create All Test Data" button
- Creates 5 test orders with varying appointment dates
- Order IDs: 50000-50004
- Dates: 2 days to 25 days old

### 3️⃣ Run Archive Job
Click "Run Archive Job" button
- Executes archive logic
- Archives tasks with appointment dates 10+ days old

### 4️⃣ Review Results
Check the validation report:
- Total test tasks created
- Active vs archived counts
- Expected vs actual outcomes
- Detailed scenario results

---

## Test Scenarios

### Scenario 1: Old Injections (25 days)
**Order ID: 50000**
- Status: Should be archived
- Expected: 3 tasks → all archived

### Scenario 2: Old Injections (20 days)
**Order ID: 50001**
- Status: Should be archived
- Expected: 3 tasks → all archived

### Scenario 3: Recent Injections (2 days)
**Order ID: 50002**
- Status: Should stay active
- Expected: 3 tasks → all active

### Scenario 4: Other Services (22 days)
**Order ID: 50003**
- Status: Should be archived
- Expected: 3 tasks → all archived

### Scenario 5: Boundary Case (10 days)
**Order ID: 50004**
- Status: Should be archived (at threshold)
- Expected: 3 tasks → all archived

---

## How to Run Tests

### Method 1: Web Dashboard (⭐ Recommended)
```
1. http://localhost:3000/admin/tests
2. Click buttons to create/archive/validate
3. Results shown in real-time
```

### Method 2: SQL Fixtures
```bash
psql postgresql://maverick@localhost:5432/labstack < tests/fixtures/test-orders.sql
```

### Method 3: Direct API Calls
```bash
# Create test data
curl -X POST http://localhost:3000/api/tests/validate \
  -H "Content-Type: application/json" \
  -d '{"scenario":"all"}'

# Run archive
curl -X POST http://localhost:3000/api/tasks/archive

# Get validation report
curl http://localhost:3000/api/tests/validate?full=true
```

---

## Expected Results

### Before Archive Job
```
Total test tasks: 15 (5 orders × 3 tasks each)
Active tasks: 15
Archived tasks: 0
```

### After Archive Job
```
Total test tasks: 15
Active tasks: 3  (Only Order #50002 - recent tasks)
Archived tasks: 12 (4 orders × 3 tasks)
```

---

## Validation Points

✅ **Database Level**
- Task count matches expected
- Correct appointment times in metadata
- Archive flag properly set
- SLA deadlines calculated

✅ **API Level**
- `/api/tasks/archive` returns success
- Archived tasks API returns correct data
- Pagination works
- `daysSinceAppointment` calculated

✅ **UI Level**
- Archived tasks visible in archive view
- Active tasks don't show archived items
- "Days Since Appt" displays values
- Order IDs are visible

✅ **Edge Cases**
- Boundary (10 days) archives correctly
- Recent (<5 days) stays active
- Old (>30 days) archives
- Mixed order types both work

---

## File Locations

```
/Users/maverick/Documents/TaskOs/
├── TEST_PLAN.md                          # Detailed test plan
├── TESTING_GUIDE.md                      # Step-by-step guide
├── TESTING_README.md                     # This file
├── tests/
│   └── fixtures/
│       └── test-orders.sql               # SQL test data
└── src/
    ├── app/
    │   └── admin/
    │       └── tests/
    │           └── page.tsx              # Test dashboard page
    ├── components/
    │   └── admin/
    │       └── TestDashboard.tsx         # Dashboard component
    └── app/
        └── api/
            └── tests/
                └── validate/
                    └── route.ts          # Validation API
```

---

## Key Features

### 🎯 Task Rules (Already Created)
**Home Injection (INJECTION order type)**
- Assign Medic (30 min SLA)
- Pre-visit Confirmation (30 min SLA)
- Post-Admin Monitoring (15 min SLA)

**Other Services (HOME_SAMPLE order type)**
- Assign Personnel (45 min SLA)
- Service Delivery (60 min SLA)
- Post-Service Follow-up (120 min SLA)

### 📊 Validation API
**GET /api/tests/validate**
- Returns test data analysis
- Validates expectations
- Detailed failure reports
- Query params: `?full=true` for detailed tasks

**POST /api/tests/validate**
- Creates test data
- Body: `{"scenario":"all"|"old-injections"|"recent-injections"|"other-services"}`

### 🎮 Interactive Dashboard
- Create test data by scenario
- Run archive job manually
- View real-time validation results
- Refresh on demand

---

## Next: Start Testing

### To begin:
1. Open http://localhost:3000/admin/tests
2. Click "Create All Test Data"
3. Click "Run Archive Job"
4. Review the validation report
5. Check archived tasks at http://localhost:3000/head/archive

### To validate manually:
```bash
# Check test tasks created
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT COUNT(*) FROM taskos.tasks WHERE \"entityId\" >= 50000;
"

# Check archive status
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT \"entityId\", \"isArchived\", 
    EXTRACT(DAY FROM NOW() - (metadata->>'appointmentTime')::timestamp) as days_old
  FROM taskos.tasks WHERE \"entityId\" >= 50000;
"
```

---

## Troubleshooting

### Tasks not created?
→ Check TEST_PLAN.md section 4 (validation checklist)

### Archive job not archiving?
→ Check TESTING_GUIDE.md "Debugging" section

### Dashboard not accessible?
→ Ensure authentication is set up for /admin routes

### Validation report shows failures?
→ Review detailed results at `/api/tests/validate?full=true`

---

## Success Criteria

When all tests pass, you'll see:
- ✅ 15 test tasks created
- ✅ 12 tasks archived
- ✅ 3 tasks remain active
- ✅ Archive view shows correct tasks
- ✅ Days Since Appointment calculated
- ✅ No data loss or inconsistencies

---

## Summary

You now have a **complete, production-ready testing framework** for validating:
- Task creation from order intake
- Task rule matching
- Task status transitions  
- Automatic archiving based on appointment date
- Task retrieval and pagination
- SLA calculations

**Ready to test?** → Go to http://localhost:3000/admin/tests

