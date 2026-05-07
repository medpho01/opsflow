# Task Rules Feature - QA Test Plan
**Prepared for:** Mani (QA Lead)  
**Prepared by:** Mayur (Developer)  
**Date:** May 2, 2026  
**Feature:** Task Rules - Phase 1 & Phase 2 Implementation

---

## Overview

This document contains all test cases required to validate the Task Rules feature implementation against the TASK_RULES_IMPLEMENTATION_PLAN.md specification.

**Test Responsibility:** Mani (QA)  
**Developer Responsibility:** Mayur (support during testing)  
**Timeline:** As per sprint planning

---

## Phase 1: Status Enum Validation - Test Cases

### Test Case P1-001: Create Rule with Valid Single Status

**Specification Reference:** TASK_RULES_IMPLEMENTATION_PLAN.md Section 2.3, Scenario 1

**Preconditions:**
- User is logged in as OPS_HEAD role
- System has LabstackOrderStatus enum loaded

**Test Steps:**
1. POST to `/api/task-rules`
2. Include valid status: `statusIn: ["ORDER_SCHEDULED"]`
3. Include all other required fields (name, orderType, taskTypeId, titleTemplate, slaMinutes, priority)

**Expected Result:**
- HTTP Status: 201 Created
- Response includes rule object with ID
- Rule is saved to database
- Status matches input exactly

**Acceptance Criteria:**
- ✅ Rule created successfully
- ✅ Status value is exactly "ORDER_SCHEDULED"
- ✅ No validation error returned

---

### Test Case P1-002: Create Rule with Multiple Valid Statuses

**Specification Reference:** TASK_RULES_IMPLEMENTATION_PLAN.md Section 2.3, Scenario 1 (extended)

**Test Steps:**
1. POST to `/api/task-rules`
2. Include multiple statuses: `statusIn: ["ORDER_SCHEDULED", "PHLEBO_ASSIGNED", "SAMPLE_COLLECTED"]`

**Expected Result:**
- HTTP Status: 201 Created
- All three statuses stored in triggerCondition.statusIn
- No errors or warnings

**Acceptance Criteria:**
- ✅ All statuses accepted
- ✅ Array preserved exactly as sent

---

### Test Case P1-003: Create Rule with Invalid Status

**Specification Reference:** TASK_RULES_IMPLEMENTATION_PLAN.md Section 2.3, Scenario 2

**Test Steps:**
1. POST to `/api/task-rules`
2. Include invalid status: `statusIn: ["NONEXISTENT_STATUS"]`
3. Include all other required fields

**Expected Result:**
- HTTP Status: 400 Bad Request
- Error message: "Invalid order status in triggerCondition.statusIn"
- Response includes `invalidStatuses: ["NONEXISTENT_STATUS"]`
- Response includes `validStatuses: [all 9 valid statuses]`
- Rule is NOT created in database

**Acceptance Criteria:**
- ✅ Invalid status rejected
- ✅ Error message is clear
- ✅ Valid statuses list provided for user reference
- ✅ No rule saved

---

### Test Case P1-004: Create Rule with Mixed Valid/Invalid Statuses

**Specification Reference:** TASK_RULES_IMPLEMENTATION_PLAN.md Section 2.3, Scenario (mixed case from line 378-379)

**Test Steps:**
1. POST to `/api/task-rules`
2. Include mixed statuses: `statusIn: ["ORDER_SCHEDULED", "INVALID1", "INVALID2"]`

**Expected Result:**
- HTTP Status: 400 Bad Request
- Error message lists both invalid statuses: ["INVALID1", "INVALID2"]
- Valid status "ORDER_SCHEDULED" does NOT cause error
- Response includes full list of valid statuses
- Rule is NOT created

**Acceptance Criteria:**
- ✅ All invalid statuses identified
- ✅ Error message is specific
- ✅ No partial saves

---

### Test Case P1-005: Update Rule (PATCH) with Invalid Status

**Specification Reference:** TASK_RULES_IMPLEMENTATION_PLAN.md Section 2.3, Scenario 3

**Preconditions:**
- Valid rule exists in database
- Rule has statusIn: ["ORDER_SCHEDULED"]

**Test Steps:**
1. PATCH `/api/task-rules/{ruleId}`
2. Update triggerCondition with: `statusIn: ["INVALID_STATUS"]`

**Expected Result:**
- HTTP Status: 400 Bad Request
- Error message: "Invalid order status in triggerCondition.statusIn"
- Response includes invalid and valid status lists
- Rule in database is NOT modified
- Original statusIn: ["ORDER_SCHEDULED"] remains unchanged

**Acceptance Criteria:**
- ✅ Invalid status rejected in PATCH
- ✅ Original rule unchanged
- ✅ Error message helpful

---

### Test Case P1-006: Get Valid Statuses Endpoint

**Specification Reference:** TASK_RULES_IMPLEMENTATION_PLAN.md Section 2.2, File 4 (lines 290-339)

**Test Steps:**
1. GET `/api/task-rules/valid-statuses`
2. User is OPS_HEAD role

**Expected Result:**
- HTTP Status: 200 OK
- Response includes array of statuses
- Each status has: `value`, `label`, `description`
- All 9 valid statuses are present:
  - ORDER_SCHEDULED
  - PHLEBO_ASSIGNED
  - SAMPLE_COLLECTED
  - SAMPLE_DELIVERED
  - SAMPLE_IN_TRANSIT
  - REPORT_READY
  - REPORT_DELIVERED
  - CANCELED
  - PATIENT_MISSED

**Example Response Structure:**
```json
{
  "statuses": [
    {
      "value": "ORDER_SCHEDULED",
      "label": "Order Scheduled",
      "description": "Order is scheduled, awaiting confirmation"
    },
    ...
  ]
}
```

**Acceptance Criteria:**
- ✅ All 9 statuses present
- ✅ Labels are human-readable
- ✅ Descriptions are helpful
- ✅ Values match enum exactly

---

### Test Case P1-007: Status Enum Value Validation

**Specification Reference:** TASK_RULES_IMPLEMENTATION_PLAN.md Section 2.2 (enum definition, lines 136-146)

**Verify all 9 status values match exactly:**

| Status | Expected Value | Actual Value | Match? |
|---|---|---|---|
| 1 | ORDER_SCHEDULED | ? | ✅/❌ |
| 2 | PHLEBO_ASSIGNED | ? | ✅/❌ |
| 3 | SAMPLE_COLLECTED | ? | ✅/❌ |
| 4 | SAMPLE_DELIVERED | ? | ✅/❌ |
| 5 | SAMPLE_IN_TRANSIT | ? | ✅/❌ |
| 6 | REPORT_READY | ? | ✅/❌ |
| 7 | REPORT_DELIVERED | ? | ✅/❌ |
| 8 | CANCELED | ? | ✅/❌ |
| 9 | PATIENT_MISSED | ? | ✅/❌ |

**Acceptance Criteria:**
- ✅ All 9 values match specification exactly
- ✅ No extra statuses
- ✅ No missing statuses

---

### Test Case P1-008: Empty statusIn Array

**Test Steps:**
1. POST to `/api/task-rules`
2. Include empty statusIn: `statusIn: []`

**Expected Result:**
- HTTP Status: 400 Bad Request
- Error message: "triggerCondition.statusIn must have at least one status"
- Rule NOT created

**Acceptance Criteria:**
- ✅ Empty array rejected
- ✅ Clear error message

---

### Test Case P1-009: Missing statusIn Field

**Test Steps:**
1. POST to `/api/task-rules`
2. Omit statusIn from triggerCondition

**Expected Result:**
- HTTP Status: 400 Bad Request
- Error message: "triggerCondition.statusIn must have at least one status"
- Rule NOT created

**Acceptance Criteria:**
- ✅ Missing field rejected
- ✅ Clear error message

---

## Phase 2: Metadata-Based Triggers - Test Cases

### Test Case P2-001: Create Rule with Valid Metadata Condition

**Specification Reference:** TASK_RULES_IMPLEMENTATION_PLAN.md Section 3.3, lines 601-632

**Test Steps:**
1. POST to `/api/task-rules`
2. Include metadata condition:
```json
{
  "statusIn": ["SAMPLE_DELIVERED"],
  "metadataConditions": [
    {
      "fieldPath": "reportETA",
      "operator": "<=",
      "offsetMinutes": 120
    }
  ]
}
```

**Expected Result:**
- HTTP Status: 201 Created
- Rule is created with metadata condition intact
- metadataConditions array preserved exactly

**Acceptance Criteria:**
- ✅ Metadata condition accepted
- ✅ fieldPath preserved
- ✅ operator preserved
- ✅ offsetMinutes preserved

---

### Test Case P2-002: Metadata Operator Validation

**Specification Reference:** TASK_RULES_IMPLEMENTATION_PLAN.md Section 3.3, lines 603-606

**Valid Operators (must all be accepted):**
```
"exists", "not_exists", "equals", "not_equals",
"contains", "starts_with", "ends_with",
">", ">=", "<", "<="
```

**Test Steps:**
For each valid operator, POST a rule with that operator in metadata condition.

**Expected Result:**
- HTTP Status: 201 Created for each
- Rule saved with correct operator

**Acceptance Criteria:**
- ✅ All 11 operators accepted
- ✅ None rejected
- ✅ Operator value preserved exactly

---

### Test Case P2-003: Invalid Metadata Operator

**Test Steps:**
1. POST rule with metadata condition
2. Use operator: "invalid_operator"

**Expected Result:**
- HTTP Status: 400 Bad Request
- Error message includes: "Invalid operator: invalid_operator"
- Error lists all valid operators
- Rule NOT created

**Acceptance Criteria:**
- ✅ Invalid operator rejected
- ✅ Clear error message
- ✅ Valid operators listed

---

### Test Case P2-004: Metadata Condition - Value Required

**Specification Reference:** TASK_RULES_IMPLEMENTATION_PLAN.md Section 3.3, lines 622-632

**Test Steps:**
1. POST rule with metadata condition
2. Use operator "equals" (requires value)
3. Omit value field

**Expected Result:**
- HTTP Status: 400 Bad Request
- Error message: "metadataCondition with operator 'equals' requires a value"
- Rule NOT created

**Acceptance Criteria:**
- ✅ Missing required value rejected
- ✅ Operator name in error message
- ✅ Clear guidance

---

### Test Case P2-005: Metadata Condition - Missing fieldPath

**Test Steps:**
1. POST rule with metadata condition
2. Omit fieldPath

**Expected Result:**
- HTTP Status: 400 Bad Request
- Error message: "Each metadataCondition must have fieldPath and operator"
- Rule NOT created

**Acceptance Criteria:**
- ✅ Missing fieldPath rejected
- ✅ Clear error message

---

### Test Case P2-006: Metadata Evaluation - Timestamp with Offset

**Specification Reference:** TASK_RULES_IMPLEMENTATION_PLAN.md Section 3.3, lines 513-530

**Setup:**
- Create rule with metadata condition:
  - fieldPath: "reportETA"
  - operator: "<="
  - offsetMinutes: 120
  - This should fire when reportETA is within next 2 hours

**Test Data:**
- Create order with metadata.reportETA = NOW + 60 minutes
- Should match the rule (60 < 120)

**Expected Result:**
- Rule evaluates to TRUE
- Task is created

**Acceptance Criteria:**
- ✅ Timestamp comparison works
- ✅ Offset calculation correct
- ✅ Task created when condition met

---

### Test Case P2-007: Metadata Evaluation - String Operations

**Test Cases for each string operator:**

#### P2-007a: "contains"
```json
{
  "fieldPath": "phleboNotes",
  "operator": "contains",
  "value": "not available"
}
```
- Should match: "Patient not available, call later"
- Should NOT match: "Patient is ready"

#### P2-007b: "starts_with"
```json
{
  "fieldPath": "phleboNotes",
  "operator": "starts_with",
  "value": "URGENT"
}
```
- Should match: "URGENT: Patient unavailable"
- Should NOT match: "Patient URGENT call"

#### P2-007c: "ends_with"
```json
{
  "fieldPath": "phleboNotes",
  "operator": "ends_with",
  "value": "later"
}
```
- Should match: "Patient not available, call later"
- Should NOT match: "Call later today"

**Acceptance Criteria:**
- ✅ Each operator works correctly
- ✅ Case-sensitive comparison
- ✅ Correct match/no-match behavior

---

## Phase 3: UI Integration - Test Cases

### Test Case P3-001: Status Dropdown in TaskRulesPanel

**Test Steps:**
1. Open Task Rules creation form
2. Locate status selector dropdown
3. Click dropdown to open

**Expected Result:**
- Dropdown shows all 9 valid statuses
- Statuses are human-readable (formatted labels)
- Statuses match /api/task-rules/valid-statuses endpoint

**Acceptance Criteria:**
- ✅ All 9 statuses visible
- ✅ Labels are readable
- ✅ Selection works

---

### Test Case P3-002: Metadata Condition Builder in UI

**Test Steps:**
1. Open Task Rules creation form
2. Add metadata condition
3. Set fieldPath, operator, value, offsetMinutes

**Expected Result:**
- All fields editable
- Operator dropdown shows valid operators
- offsetMinutes field visible for comparison operators
- offsetMinutes field hidden for "exists"/"not_exists"

**Acceptance Criteria:**
- ✅ Metadata condition form works
- ✅ Conditional field visibility correct
- ✅ Values submitted to API

---

### Test Case P3-003: Trigger Summary Display

**Test Steps:**
1. Create rule with status and metadata condition
2. View trigger summary

**Expected Result:**
- Summary shows rule trigger logic in readable format
- Example: "Trigger when status is SAMPLE_DELIVERED AND reportETA is within 120 minutes"
- Metadata condition count shown if multiple

**Acceptance Criteria:**
- ✅ Summary is readable
- ✅ Accurate representation of logic
- ✅ User can understand rule trigger

---

## Authorization & Security Tests

### Test Case SEC-001: Unauthorized User Cannot Create Rule

**Test Steps:**
1. POST to `/api/task-rules`
2. User role is NOT OPS_HEAD (e.g., OPS_AGENT)

**Expected Result:**
- HTTP Status: 403 Forbidden
- Error message: "Forbidden"
- Rule NOT created

**Acceptance Criteria:**
- ✅ Non-OPS_HEAD users blocked
- ✅ Clear error response

---

### Test Case SEC-002: Unauthorized User Cannot Get Valid Statuses

**Test Steps:**
1. GET `/api/task-rules/valid-statuses`
2. User role is OPS_AGENT

**Expected Result:**
- HTTP Status: 403 Forbidden

**Acceptance Criteria:**
- ✅ Endpoint requires OPS_HEAD role

---

## Database & Persistence Tests

### Test Case DB-001: Rule Status Persists

**Test Steps:**
1. Create rule with statusIn: ["ORDER_SCHEDULED", "PHLEBO_ASSIGNED"]
2. GET `/api/task-rules` to list all rules
3. Find the created rule

**Expected Result:**
- Rule appears in list
- statusIn array has exactly ["ORDER_SCHEDULED", "PHLEBO_ASSIGNED"]
- Status values match exactly

**Acceptance Criteria:**
- ✅ Status values persisted
- ✅ Array order preserved
- ✅ No data modification

---

### Test Case DB-002: Metadata Condition Persists

**Test Steps:**
1. Create rule with metadata condition
2. GET `/api/task-rules/{id}` to fetch that rule
3. Check triggerCondition.metadataConditions

**Expected Result:**
- metadataConditions array present
- fieldPath, operator, value, offsetMinutes all preserved
- No data loss or transformation

**Acceptance Criteria:**
- ✅ Metadata condition fully persisted
- ✅ All fields intact
- ✅ No unexpected transformations

---

## Edge Cases & Error Handling

### Test Case EDGE-001: Very Long Status Array

**Test Steps:**
1. POST rule with statusIn containing all 9 valid statuses

**Expected Result:**
- HTTP Status: 201 Created
- All 9 statuses saved

**Acceptance Criteria:**
- ✅ No arbitrary limits
- ✅ All statuses accepted

---

### Test Case EDGE-002: Case Sensitivity

**Test Steps:**
1. POST rule with statusIn: ["order_scheduled"] (lowercase)

**Expected Result:**
- HTTP Status: 400 Bad Request
- Status enum is case-sensitive

**Acceptance Criteria:**
- ✅ Case sensitivity enforced
- ✅ Exact match required

---

### Test Case EDGE-003: Whitespace in Status Value

**Test Steps:**
1. POST rule with statusIn: [" ORDER_SCHEDULED "] (with spaces)

**Expected Result:**
- HTTP Status: 400 Bad Request
- Whitespace not trimmed

**Acceptance Criteria:**
- ✅ Exact match required
- ✅ No auto-trimming

---

## Regression Tests

### Test Case REG-001: Existing Rules Still Work

**Preconditions:**
- Rules exist in database from before these changes

**Test Steps:**
1. GET `/api/task-rules`
2. List all rules
3. Verify existing rules still function

**Expected Result:**
- All existing rules load
- statusIn values still valid
- No migrations needed
- Rules continue to trigger correctly

**Acceptance Criteria:**
- ✅ Backward compatibility maintained
- ✅ Existing data intact

---

## Test Execution Checklist

### Phase 1 Status Validation (11 test cases)
- [ ] P1-001: Single valid status ✅/❌
- [ ] P1-002: Multiple valid statuses ✅/❌
- [ ] P1-003: Invalid status ✅/❌
- [ ] P1-004: Mixed valid/invalid ✅/❌
- [ ] P1-005: PATCH invalid status ✅/❌
- [ ] P1-006: Get valid statuses endpoint ✅/❌
- [ ] P1-007: Enum value validation ✅/❌
- [ ] P1-008: Empty statusIn array ✅/❌
- [ ] P1-009: Missing statusIn field ✅/❌

### Phase 2 Metadata Triggers (7 test cases)
- [ ] P2-001: Valid metadata condition ✅/❌
- [ ] P2-002: Operator validation ✅/❌
- [ ] P2-003: Invalid operator ✅/❌
- [ ] P2-004: Value required ✅/❌
- [ ] P2-005: Missing fieldPath ✅/❌
- [ ] P2-006: Timestamp with offset ✅/❌
- [ ] P2-007: String operations ✅/❌

### Phase 3 UI Integration (3 test cases)
- [ ] P3-001: Status dropdown ✅/❌
- [ ] P3-002: Metadata builder ✅/❌
- [ ] P3-003: Trigger summary ✅/❌

### Security (2 test cases)
- [ ] SEC-001: Unauthorized user ✅/❌
- [ ] SEC-002: Role enforcement ✅/❌

### Database (2 test cases)
- [ ] DB-001: Status persistence ✅/❌
- [ ] DB-002: Metadata persistence ✅/❌

### Edge Cases (3 test cases)
- [ ] EDGE-001: Large status array ✅/❌
- [ ] EDGE-002: Case sensitivity ✅/❌
- [ ] EDGE-003: Whitespace handling ✅/❌

### Regression (1 test case)
- [ ] REG-001: Existing rules ✅/❌

---

## Test Report Template

After running tests, please fill in:

```markdown
# Task Rules Feature - Test Report
**Tester:** Mani  
**Date:** [Date]  
**Feature:** Task Rules Phase 1 & 2  

## Summary
- **Total Tests:** 29
- **Passed:** ___
- **Failed:** ___
- **Blocked:** ___

## Issues Found
1. [Issue #1]: [Description] [Severity: Critical/High/Medium/Low]
2. [Issue #2]: ...

## Sign-Off
- [ ] All tests passed
- [ ] All critical issues resolved
- [ ] Feature ready for production

**QA Signature:** ________________  
**Date:** ________________
```

---

## Developer Support

**Mayur (Developer) is available for:**
- Clarifying test case intent
- Debugging test failures
- Providing test data
- Running targeted fixes based on QA findings

**Please report all issues with:**
- Test case number
- Steps to reproduce
- Expected vs. actual result
- Severity level
- Screenshots (if UI issue)

---

**Ready for QA validation.**

