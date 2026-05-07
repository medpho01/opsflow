# Required Fixes for Production Deployment

**QA Lead:** Mani  
**Date:** May 2, 2026  
**Status:** Critical fixes required before deployment

---

## Fix #1: CRITICAL - Metadata Operator Names (TaskRulesPanel.tsx)

**File:** `/src/components/head/TaskRulesPanel.tsx`

### Current Code (WRONG)
Lines 75-79:
```typescript
const METADATA_OPERATORS = [
  "exists", "not_exists", "equals", "not_equals", "contains",
  "not_contains", "greater_than", "greater_than_or_equal",
  "less_than", "less_than_or_equal", "in_array"
];
```

### Required Fix
Replace with:
```typescript
const METADATA_OPERATORS = [
  "exists", "not_exists", "equals", "not_equals", "contains",
  "starts_with", "ends_with", ">", ">=", "<", "<="
];
```

### Why
- Specification defines 11 operators using these exact names
- API validation expects these exact values
- Current names cause 400 Bad Request when submitted to API

---

## Fix #2: CRITICAL - Offset Minutes Field Conditional (TaskRulesPanel.tsx)

**File:** `/src/components/head/TaskRulesPanel.tsx`

### Current Code (WRONG)
Line 278:
```typescript
{["greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal"].includes(cond.operator) && (
```

### Required Fix
Replace with:
```typescript
{[">", ">=", "<", "<="].includes(cond.operator) && (
```

### Why
- The offset minutes field should appear when using comparison operators
- Current code checks for wrong operator names
- Field never displays because actual operators are ">", ">=" etc.

---

## Verification Steps After Fix

### Step 1: Check operator dropdown
```typescript
// In TaskRulesPanel.tsx, line 252
{METADATA_OPERATORS.map((op) => (
  <option key={op} value={op}>{op.replace(/_/g, " ")}</option>
))}
```

After fix, dropdown should show:
- exists
- not_exists
- equals
- not_equals
- contains
- starts_with
- ends_with
- >
- >=
- <
- <=

### Step 2: Test rule creation with ">" operator
1. Create new rule
2. Navigate to "Trigger Condition" tab
3. Expand "Metadata Conditions (Advanced)"
4. Click "+ Add metadata condition"
5. Set:
   - Field Path: `reportETA`
   - Operator: `>` (from dropdown)
   - Value: `1000`
   - Offset Minutes: `120`
6. Click Save
7. Should receive HTTP 201 response
8. Rule should be created successfully

### Step 3: Test rule creation with "<=" operator
1. Follow same steps as Step 2
2. Select operator `<=`
3. Should also succeed

### Step 4: Verify offset minutes field displays
1. Add metadata condition
2. Select operator `>`
3. Offset minutes input should appear below operator dropdown
4. Should be able to enter value

### Step 5: Verify offset minutes field hidden for non-comparison operators
1. Add metadata condition
2. Select operator `exists`
3. Offset minutes field should NOT appear
4. Select operator `equals`
5. Offset minutes field should NOT appear

---

## Testing Checklist

Before marking as complete:

- [ ] Operator dropdown shows correct 11 operators
- [ ] Can select ">" operator without error
- [ ] Can select ">=" operator without error
- [ ] Can select "<" operator without error
- [ ] Can select "<=" operator without error
- [ ] Can select "starts_with" operator without error
- [ ] Can select "ends_with" operator without error
- [ ] Offset minutes field appears when selecting ">", ">=", "<", "<="
- [ ] Offset minutes field hidden when selecting "exists", "equals", etc.
- [ ] Creating rule with ">" operator succeeds (HTTP 201)
- [ ] Creating rule with ">=" operator succeeds (HTTP 201)
- [ ] Creating rule with "<" operator succeeds (HTTP 201)
- [ ] Creating rule with "<=" operator succeeds (HTTP 201)
- [ ] Creating rule with "starts_with" operator succeeds (HTTP 201)
- [ ] Creating rule with "ends_with" operator succeeds (HTTP 201)
- [ ] Existing Phase 1 rules still work
- [ ] Status dropdown still works correctly

---

## Time Estimate

- Code changes: 5 minutes
- Compilation/build: 2 minutes
- Testing (manual): 15 minutes
- Testing (automated): 5 minutes
- **Total: ~30 minutes**

---

## Impact Analysis

### What This Fixes
- Users can now create metadata-based rules via UI
- Offset minutes field displays correctly
- Phase 2 functionality becomes accessible through UI
- HSC-R6 rule can be configured

### What This Does NOT Break
- Phase 1 (status validation) - no changes to that code
- Authorization - no changes to role checks
- Database persistence - no changes to data layer
- API endpoints - no changes needed to backend

### Risk Level
**LOW** - Changes are UI-only, in a local constant array. No backend changes required.

---

## Code Review Notes

The fixes are simple string literal replacements:
- Remove: "not_contains", "greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal", "in_array"
- Add: "starts_with", "ends_with", ">", ">=", "<", "<="
- Update conditional from operator names to symbols

No logic changes, no algorithm changes, no structural changes.

---

## Deployment Order

1. Apply fixes to TaskRulesPanel.tsx
2. Run npm build (verify no errors)
3. Run automated tests
4. Manual testing (checklist above)
5. Deploy to staging
6. Production deployment approval

---

**Note:** Phase 4 (Audit Trail) is already implemented and working. No additional fixes needed for that phase.
