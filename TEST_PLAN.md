# OpsFlow Task Management - Order-Driven End-to-End Test Plan

## Executive Summary
This test plan validates the **complete order-to-archive workflow**:
- Orders created in labstack public schema
- Poller detects and matches task rules
- Validates correct tasks are generated from orders
- Confirms proper task archiving based on appointment date
- Verifies task lifecycle and data integrity

---

## 1. TEST OBJECTIVES

### Primary Goals
✓ Validate task rules trigger correctly when orders are created
✓ Verify task creation follows SOP requirements
✓ Confirm task status transitions work as expected
✓ Validate task archiving based on appointment date (10+ days old)
✓ Ensure task reassignment and status updates persist correctly

### Scope
- **In Scope**: Order creation, task generation, status updates, archiving
- **Out of Scope**: Patient data validation, phlebotomist assignment, actual sample collection

---

## 2. TEST SCENARIOS

### Scenario 1: Home Injection - Complete Happy Path
**Objective**: Validate full injection workflow from order creation to completion

**Steps**:
1. Create a HOME INJECTION order with appointment date 15+ days ago
2. Verify 3 tasks are created:
   - `Assign Medic - Injection` (30 min SLA)
   - `Pre-visit Confirmation - Injection` (30 min SLA)
   - `Post-Admin Monitoring` (15 min SLA)
3. Update task 1: Mark as "Assigned" with medic details
4. Update task 2: Mark as "Confirmed"
5. Update task 3: Mark as "Completed"
6. Run archive job manually
7. Verify order tasks are now archived (isArchived = true)

**Expected Outcomes**:
- ✓ 3 tasks created with correct IDs, titles, SLA deadlines
- ✓ Task statuses transition correctly
- ✓ All 3 tasks archived after 10-day threshold
- ✓ Tasks visible in archived view with proper metadata

---

### Scenario 2: Other Services - Partial Flow
**Objective**: Validate other services workflow and status changes

**Steps**:
1. Create a HOME_SAMPLE order (other service) with appointment 12+ days ago
2. Verify 3 tasks are created:
   - `Assign Personnel - Other Services` (45 min SLA)
   - `Service Delivery - Other Services` (60 min SLA)
   - `Post-Service Follow-up` (120 min SLA)
3. Update task 1: Mark as "Assigned"
4. Update task 2: Mark as "In Progress" → "Completed"
5. Leave task 3 pending
6. Run archive job
7. Verify tasks are archived even with pending task 3

**Expected Outcomes**:
- ✓ 3 tasks created for other services
- ✓ Tasks archive regardless of individual task completion status
- ✓ Completed and pending tasks both archived

---

### Scenario 3: Recent Order (Should NOT Archive)
**Objective**: Validate that recent orders are not archived prematurely

**Steps**:
1. Create an INJECTION order with appointment date TODAY
2. Create 3 tasks as expected
3. Update task statuses to "Completed"
4. Run archive job immediately
5. Verify tasks are NOT archived (isArchived = false)

**Expected Outcomes**:
- ✓ Tasks remain active despite completion
- ✓ Tasks NOT archived until 10+ days pass
- ✓ Dashboard shows them in active tasks

---

### Scenario 4: Bulk Orders (Load Test)
**Objective**: Validate system handles multiple orders correctly

**Steps**:
1. Create 10 INJECTION orders (5 old, 5 new)
   - Old: appointments 15 days ago
   - New: appointments today
2. Verify 30 tasks created (3 per order)
3. Update all old order tasks to "Completed"
4. Run archive job
5. Check archived tasks count (should be 15)

**Expected Outcomes**:
- ✓ All 30 tasks created successfully
- ✓ Only old order tasks (15) archived
- ✓ New order tasks (15) remain active
- ✓ Archive shows correct pagination

---

### Scenario 5: SLA & Deadline Validation
**Objective**: Verify SLA calculations and breach detection

**Steps**:
1. Create order with appointment 20 days ago
2. Create task with 30-min SLA
3. Verify slaDeadline = appointmentTime + 30 mins
4. Calculate days overdue (should be ~20 days)
5. Check if task appears in breached list

**Expected Outcomes**:
- ✓ SLA deadline correctly calculated
- ✓ Overdue tasks marked as "BREACHED"
- ✓ Proper color coding in UI (red/orange)

---

### Scenario 6: Archive Days Calculation
**Objective**: Validate daysSinceAppointment field in archived view

**Steps**:
1. Create orders with appointments:
   - Order A: 25 days ago
   - Order B: 10 days ago
   - Order C: 5 days ago (should NOT archive)
2. Archive
3. Verify archived tasks show correct daysSinceAppointment:
   - Order A: ~25 days
   - Order B: ~10 days
   - Order C: Should NOT appear in archive

**Expected Outcomes**:
- ✓ Archive view shows accurate days calculation
- ✓ ONLY 10+ day old orders archived
- ✓ Recent orders remain active

---

## 3. TEST DATA FIXTURES

### Test Order Templates

#### Order Type A: Old Injection Order (SHOULD ARCHIVE)
```json
{
  "orderType": "INJECTION",
  "patientName": "Test Patient A",
  "appointmentTime": "2026-04-05T10:00:00Z",  // 25 days ago
  "injectionName": "Vitamin B12 1000mcg",
  "prescription": {"dosage": "1000mcg", "route": "IM"},
  "storeId": 1,
  "entityId": 50000
}
```

#### Order Type B: Recent Injection Order (SHOULD NOT ARCHIVE)
```json
{
  "orderType": "INJECTION",
  "patientName": "Test Patient B",
  "appointmentTime": "2026-04-28T14:30:00Z",  // 2 days ago
  "injectionName": "Flu Shot",
  "prescription": {"dosage": "0.5ml", "route": "IM"},
  "storeId": 1,
  "entityId": 50001
}
```

#### Order Type C: Other Service (SHOULD ARCHIVE)
```json
{
  "orderType": "HOME_SAMPLE",
  "patientName": "Test Patient C",
  "appointmentTime": "2026-04-10T11:00:00Z",  // 20 days ago
  "serviceType": "OTHER_SERVICE",
  "description": "Health Counseling",
  "storeId": 1,
  "entityId": 50002
}
```

---

## 4. VALIDATION CHECKLIST

### Task Creation Validation
- [ ] Correct number of tasks created per order
- [ ] Task titles match rule templates
- [ ] SLA deadlines are correctly calculated
- [ ] Task priority matches rule definition
- [ ] Task types are correct

### Task Status Validation
- [ ] Status transitions are valid (CREATED → ASSIGNED → COMPLETED)
- [ ] Status updates persist in database
- [ ] Task history logs all status changes
- [ ] Timestamps are accurate

### Archive Validation
- [ ] Only 10+ day old appointments archived
- [ ] Tasks archived regardless of individual task completion
- [ ] `isArchived` flag set to true
- [ ] Archived tasks removed from active view
- [ ] Pagination works correctly in archive view

### UI/UX Validation
- [ ] Archive button appears and is functional
- [ ] Archived tasks view loads with pagination
- [ ] "Days Since Appt" column displays correctly
- [ ] Order IDs are visible and clickable
- [ ] Task count shows correct numbers

### Database Validation
- [ ] No orphaned tasks
- [ ] Referential integrity maintained
- [ ] Indexes being used (query performance)
- [ ] No data loss after archive

---

## 5. TEST EXECUTION STEPS

### Setup Phase
```bash
# 1. Clear test data
DELETE FROM taskos.tasks WHERE "entityId" >= 50000;
DELETE FROM taskos.task_history WHERE "taskId" IN (SELECT id FROM taskos.tasks WHERE "entityId" >= 50000);

# 2. Verify task rules exist
SELECT * FROM taskos.task_rules WHERE name LIKE '%Injection%' OR name LIKE '%Other%';

# 3. Verify task types exist
SELECT * FROM taskos.task_types WHERE name LIKE 'INJ_%' OR name LIKE 'OTH_%';
```

### Test Execution
```bash
# 1. Create test orders (use SQL or API)
# 2. Verify task creation
# 3. Update task statuses
# 4. Run archive job: curl -X POST http://localhost:3000/api/tasks/archive
# 5. Validate archived tasks
# 6. Check UI displays correctly
```

### Cleanup Phase
```bash
# After tests complete, clean up
DELETE FROM taskos.tasks WHERE "entityId" >= 50000;
```

---

## 6. SUCCESS CRITERIA

| Metric | Target | Status |
|--------|--------|--------|
| All tasks created on order intake | 100% | ⬜ |
| Tasks archive on 10+ day threshold | 100% | ⬜ |
| SLA calculations accurate | 100% | ⬜ |
| Status updates persist | 100% | ⬜ |
| Pagination works correctly | ✓ | ⬜ |
| No data loss during archive | 100% | ⬜ |
| UI displays archived tasks correctly | ✓ | ⬜ |
| Performance: Archive job < 5 seconds | 100% | ⬜ |

---

## 7. KNOWN LIMITATIONS & EDGE CASES

### Potential Issues
1. **Timezone handling**: Appointments stored in UTC, ensure local timezone conversions work
2. **Null metadata**: Some orders may not have `appointmentTime` in metadata
3. **Concurrent updates**: What happens if task is updated while archiving?
4. **Date boundary**: What about orders exactly 10 days old?

### Testing These Cases
- [ ] Test with orders created in different timezones
- [ ] Test with missing/null metadata fields
- [ ] Test archive while tasks are being updated
- [ ] Test exact 10-day boundary (should archive)

---

## 8. REPORTING

### Test Report Template
```
Date: 2026-04-30
Tester: [Name]
Test Duration: [Time]

SUMMARY:
- Scenarios Passed: [X]/6
- Total Tests: [N]
- Pass Rate: [X%]

FAILED TESTS:
- [Test name]: [Failure reason]

BLOCKERS:
- [Any blocking issues]

RECOMMENDATIONS:
- [Improvements needed]
```

---

## 9. ROLLBACK PLAN

If tests fail and impact production data:
```sql
-- Restore from latest backup
-- Or manually fix data:
UPDATE taskos.tasks SET "isArchived" = false WHERE id IN ([list of ids]);
```

---

## 10. NEXT STEPS

1. **Phase 1**: Manual SQL-based testing
2. **Phase 2**: API endpoint testing
3. **Phase 3**: UI testing via browser
4. **Phase 4**: Load testing with bulk orders
5. **Phase 5**: Production validation

