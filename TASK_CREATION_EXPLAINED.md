# How Tasks Are Created From Orders

## Quick Answer

**YES** - Orders automatically create tasks, but **NOT instantly**.

- ⏱ **Timing:** Tasks are created **every 5 minutes** (not real-time)
- 🔄 **Process:** Poller runs → Detects new orders → Matches task rules → Creates tasks
- 📝 **Default interval:** 300,000 ms = **5 minutes**

---

## How It Works (Complete Flow)

### Step 1: Order Created in LabStack
```
You create an order in public."Order" table
        ↓
Order sits in database
        ↓
Waiting for poller to detect it...
```

### Step 2: Poller Runs Every 5 Minutes
```
Poller cycle starts (automatic)
        ↓
1. Fetches ALL active orders from labstack
2. Loads ALL active task rules (15 rules)
3. Evaluates trigger conditions
4. Creates matching tasks
5. Logs results
        ↓
Tasks now exist in taskos.tasks table
```

### Step 3: You Can See the Tasks
```
After poller runs, query taskos.tasks
        ↓
✓ Tasks visible with correct properties
✓ SLA deadlines calculated
✓ Metadata populated
```

---

## Timing Details

### Default: Every 5 Minutes

| Timing | Duration |
|--------|----------|
| **Poller Interval** | 5 minutes (300,000 ms) |
| **Fastest Task Creation** | < 1 minute (if poller just ran) |
| **Slowest Task Creation** | < 5 minutes (if you just missed poller) |
| **Average** | ~2.5 minutes |

### Example Timeline

```
10:00 AM  - Poller runs (tasks created for all orders up to this point)
10:05 AM  - Poller runs (detects new orders)
           ↑ If you create order at 10:03, it will be detected here
10:10 AM  - Poller runs
10:15 AM  - Poller runs
... every 5 minutes
```

### Worst Case
```
10:00:01 AM - You create an order (just missed poller)
             ...waiting...
10:05:00 AM - Poller detects and creates tasks
             Total wait: ~5 minutes
```

### Best Case
```
10:00:01 AM - You create an order (poller just started)
10:00:30 AM - Poller finishes and creates tasks
             Total wait: ~30 seconds (usually 1-2 minutes)
```

---

## How to Check Poller Progress

### 1. Check Server Logs

```bash
# Watch for [Poller] messages in your server output:

[Poller] Cycle started at 2026-04-30T13:25:00.000Z
[Poller] 5 active orders fetched from labstack
[Poller] 15 active task rules loaded
[Poller] Tasks created: 12, skipped: 3
[Poller] SLA watcher completed
[Poller] Cycle finished in 423ms — status: SUCCESS
```

### 2. Check Polling Log in Database

```bash
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
SELECT 
  "startedAt",
  "finishedAt",
  "durationMs",
  "ordersFound",
  "tasksCreated",
  status
FROM taskos."PollingLog"
ORDER BY "startedAt" DESC
LIMIT 5;
EOF
```

**Example output:**
```
startedAt              | finishedAt            | durationMs | ordersFound | tasksCreated | status
───────────────────────┼───────────────────────┼────────────┼─────────────┼──────────────┼────────
2026-04-30 13:25:00   | 2026-04-30 13:25:00.4 | 400        | 5           | 12           | SUCCESS
2026-04-30 13:20:00   | 2026-04-30 13:20:00.3 | 380        | 3           | 9            | SUCCESS
2026-04-30 13:15:00   | 2026-04-30 13:15:00.2 | 350        | 0           | 0            | SUCCESS
```

### 3. Verify Tasks Were Created

```bash
# After poller runs, check tasks table:
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
SELECT 
  COUNT(*) as total_tasks,
  COUNT(DISTINCT "entityId") as orders_with_tasks,
  MAX("createdAt") as last_task_created
FROM taskos.tasks
WHERE "createdAt" > NOW() - INTERVAL '10 minutes';
EOF
```

---

## Testing Task Creation

### Quick Test: Create Order and Wait for Tasks

```bash
#!/bin/bash

echo "Step 1: Create order in database"
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
-- Copy INSERT from test-scenarios-today-yesterday.sql
-- Example: Create order 2000000
INSERT INTO public."Order" (...)
VALUES (...);
EOF

echo "Step 2: Check time and note it"
date

echo "Step 3: Wait for poller to run"
echo "- Option A: Wait up to 5 minutes naturally"
echo "- Option B: Trigger manually (if endpoint available)"
echo "- Option C: Check server logs for [Poller] messages"

echo "Step 4: Check tasks created (after poller runs)"
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
SELECT 
  COUNT(*) as tasks_created,
  STRING_AGG(DISTINCT tr.name, ' | ') as rules_matched
FROM taskos.tasks t
LEFT JOIN taskos.task_rules tr ON tr.id = t."taskRuleId"
WHERE t."entityId" = 2000000;
EOF

echo "If you see task count > 0, it worked!"
```

---

## Understanding the Poller Flow

### What the Poller Does

```
POLLER CYCLE (Every 5 minutes):
│
├─ 1. Fetch Orders
│     FROM public."Order"
│     WHERE status NOT IN ('CANCELED', 'REPORT_DELIVERED', 'PATIENT_MISSED')
│     Result: All active orders
│
├─ 2. Load Task Rules
│     FROM taskos.task_rules
│     WHERE "isActive" = true
│     Result: 15 rules
│
├─ 3. Evaluate Trigger Conditions
│     For EACH order + rule combination:
│     - Check: orderType matches?
│     - Check: status condition met?
│     - Check: timing condition met?
│     - Result: List of tasks to create
│
├─ 4. Create Tasks
│     INSERT INTO taskos.tasks
│     For each matched rule
│     Result: N new task records
│
├─ 5. Run SLA Watcher
│     Check for breached SLAs
│     Create SLA_BREACH alerts
│
└─ 6. Log Results
      INSERT INTO taskos."PollingLog"
      ordersFound: X
      tasksCreated: Y
      status: SUCCESS/ERROR
```

### Rule Matching Logic

```
For each order:
  ✓ Check orderType (INJECTION, HOME_SAMPLE, etc)
  ✓ Check status is in rule's statusIn list
  ✓ Check minutesBeforeAppointment condition
  ✓ Check minutesAfterAppointment condition
  ✓ Check minutesSinceCreated condition
  ✓ Check minutesSinceStatusUpdated condition
  
If ALL conditions match:
  → CREATE TASK
Else:
  → Skip task
```

---

## Changing Poller Interval (Advanced)

If you want tasks created more frequently:

### Current Setting (5 minutes)
```
.env file:
POLLING_INTERVAL_MS=300000  (5 minutes)
```

### Change to 1 Minute
```
POLLING_INTERVAL_MS=60000   (1 minute)
```

### Change to 2 Minutes
```
POLLING_INTERVAL_MS=120000  (2 minutes)
```

⚠️ **Warning:** Shorter intervals = more database load
- ✓ Good: Tasks created faster
- ✗ Bad: More CPU/DB usage
- ⚠️ Minimum: Don't go below 30 seconds

---

## Monitoring Task Creation in Real-Time

### Use This Command to Watch as Tasks Are Created

```bash
# Terminal 1: Watch poller logs
tail -f <your-nextjs-server-log> | grep "\[Poller\]"

# Terminal 2: Watch tasks being created
watch -n 1 'psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT COUNT(*) as total_tasks,
    MAX(\"createdAt\") as latest_created_at
  FROM taskos.tasks WHERE \"createdAt\" > NOW() - INTERVAL '\''5 minutes'\'';
"'

# Terminal 3: Create test order
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
INSERT INTO public."Order" (...)
VALUES (...);
EOF
```

As poller runs, you'll see:
1. Server logs show `[Poller] Tasks created: X`
2. Watch command shows task count increasing
3. Tasks appear in your dashboard

---

## Common Scenarios & Timing

### Scenario 1: Testing with 1 Order
```
10:00:00 - Create order 2000000
10:00:30 - See it in database
10:05:00 - Poller runs
10:05:01 - Tasks visible
10:05:05 - Can query tasks
         Total wait: ~5 minutes
```

### Scenario 2: Testing Multiple Orders
```
10:00:00 - Create orders 2000000-2000005 (6 orders)
10:05:00 - Poller detects all 6
10:05:02 - Creates ~18 tasks (3 per order)
         Total wait: ~5 minutes
```

### Scenario 3: Order Status Progression
```
10:00:00 - Create order (ORDER_SCHEDULED)
10:05:00 - Poller: Creates Confirm Booking + Assign Phlebo tasks
10:05:15 - Update order status to PHLEBO_ASSIGNED
10:10:00 - Poller: Detects status change, creates Phlebo Dispatch task
         Wait per progression: ~5 minutes
```

---

## Troubleshooting: "Tasks Not Created"

### Issue 1: Poller Hasn't Run Yet
**Solution:** Check logs or wait max 5 minutes
```bash
# Check if poller ran recently
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT \"startedAt\", \"ordersFound\", \"tasksCreated\"
  FROM taskos.\"PollingLog\" 
  ORDER BY \"startedAt\" DESC LIMIT 1;
"
# If timestamp is old, poller hasn't run yet
```

### Issue 2: Order Not Visible to Poller
**Solution:** Verify order was created
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT id, \"orderType\", \"orderStatus\" 
  FROM public.\"Order\" WHERE id = 2000000;
"
# If no results, order wasn't created
```

### Issue 3: Task Rules Not Active
**Solution:** Check rules are enabled
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT COUNT(*) FROM taskos.task_rules WHERE \"isActive\" = true;
"
# Should show 15 rules
```

### Issue 4: No Matching Rules
**Solution:** Order type/status may not match rule conditions
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT tr.name, tr.\"triggerCondition\"
  FROM taskos.task_rules tr
  WHERE \"orderType\" = 'HOME_SAMPLE' AND \"isActive\" = true;
"
# Review trigger conditions for your order
```

---

## Summary

| Question | Answer |
|----------|--------|
| **Do tasks create automatically?** | YES ✅ |
| **How long does it take?** | **Max 5 minutes** (usually 1-2 min) |
| **Why not instant?** | Poller runs on schedule every 5 min |
| **Can I change interval?** | YES, edit POLLING_INTERVAL_MS in .env |
| **How do I know it worked?** | Check server logs or polling log table |
| **What if tasks don't appear?** | Wait for next poller cycle or check troubleshooting |

---

## Next Steps

1. **Create a test order** using scripts from `test-scenarios-today-yesterday.sql`
2. **Note the time** when you create it
3. **Wait for poller** (max 5 minutes) or check logs for `[Poller]` messages
4. **Query tasks** to verify they were created
5. **Check polling log** to see poller execution details

**The tasks WILL be created automatically - just need to wait for poller!** ⏱️

