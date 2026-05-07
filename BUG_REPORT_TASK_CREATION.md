# BUG REPORT: Task Creation Failure - Poller Crash

## Status
**CRITICAL** - Prevents ALL task creation (0% completion rate)

## Problem
The polling engine crashes on every cycle with:
```
"Cannot read properties of undefined (reading 'includes')"
```

**Impact:**
- ✗ HSC-R1: 114 orders in ORDER_SCHEDULED (30+ mins old) → 0 tasks created (100% gap)
- ✗ HSC-R4: 8 orders in PHLEBO_ASSIGNED (60+ mins old) → 0 tasks created (100% gap)  
- ✗ HSC-R5: 27 orders in SAMPLE_COLLECTED → 27 tasks created (0% gap) **Works!**
- ✗ 1 order marked REPORT_DELIVERED still has open tasks (no auto-close)
- ✗ 38,551 completed orders, but only 1 with open tasks (gap exists)

## Root Cause
**File:** `/src/lib/engine/taskCreator.ts`  
**Line:** 17 in `evaluateTrigger()` function

```typescript
// Line 17 - CRASH HERE
if (!cond.statusIn.includes(order.orderStatus)) return false;
```

**Why it crashes:**
- `triggerCondition` is stored in database as JSONB
- When loaded via Prisma line 278, it's cast without validation:
  ```typescript
  triggerCondition: r.triggerCondition as unknown as TriggerCondition,
  ```
- If `triggerCondition` doesn't have `statusIn` property → `cond.statusIn` is `undefined`
- Calling `.includes()` on `undefined` throws: "Cannot read properties of undefined"

## Evidence
**Polling logs show consistent failure:**
```
startedAt            | ordersFound | tasksCreated | status | error_summary
2026-04-30 04:55     | 238         | 0            | ERROR  | Cannot read properties of undefined (reading 'includes')
2026-04-30 04:50     | 238         | 0            | ERROR  | Cannot read properties of undefined (reading 'includes')
(repeats every 5 minutes)
```

**Gap Analysis Results:**
```
Rule HSC-R1: 114 orders needing task | 0 with task | 114 gap (100% gap)
Rule HSC-R4: 8 orders needing task   | 0 with task | 8 gap (100% gap)
Rule HSC-R5: 27 orders needing task  | 27 with task | 0 gap (WORKING!)
```

## Fix Required
The `evaluateTrigger()` function must:
1. Safely access `cond.statusIn` with null/undefined checking
2. Validate trigger condition structure before use
3. Provide helpful error logging if structure is invalid

## Related Issues
1. **Task Auto-Closure:** Completed orders (REPORT_DELIVERED) should auto-close their tasks, but don't. Currently 1 order with open task, but this should be 0.

2. **Order Status Mismatch:** Task rules reference status values that don't exist:
   - Rules use: `["BOOKED", "CONFIRMED", "PHLEBO_DISPATCHED"]`
   - Database has: `["ORDER_SCHEDULED", "PHLEBO_ASSIGNED", "SAMPLE_COLLECTED", etc.]`
   - This is a separate validation issue in the database

## Validation Data
- Total orders: 46,166
- Orders in ORDER_SCHEDULED: 117 (should trigger HSC-R1)
- Orders in PHLEBO_ASSIGNED: 8 (should trigger HSC-R4)
- Orders in SAMPLE_COLLECTED: 27 (should trigger HSC-R5, currently working!)
- Total open tasks: 74
- Tasks on completed orders: 1 (should be 0)
