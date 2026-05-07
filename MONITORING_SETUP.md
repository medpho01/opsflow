# Archive System - Monitoring Setup

**Purpose:** Monitor archive system health and performance  
**Frequency:** Daily check (automated or manual)  
**Owner:** Operations Head or DevOps

---

## 📊 Quick Status Check

Run this SQL to get daily status:

```bash
psql -d labstack << 'EOF'
\echo '=== ARCHIVE SYSTEM STATUS ==='
\echo 'Timestamp:' `date`
\echo ''

-- Task distribution
SELECT 
  'Total Tasks' as metric, COUNT(*) as count 
FROM taskos.tasks
UNION ALL
SELECT 'Active (non-archived)', COUNT(*) FROM taskos.tasks WHERE "isArchived" = false
UNION ALL
SELECT 'Archived', COUNT(*) FROM taskos.tasks WHERE "isArchived" = true
UNION ALL
SELECT 'Completed', COUNT(*) FROM taskos.tasks WHERE status = 'COMPLETED'
UNION ALL
SELECT 'Cancelled', COUNT(*) FROM taskos.tasks WHERE status = 'CANCELLED'
ORDER BY 1;

\echo ''
\echo '=== ARCHIVE STATS VIEW ==='
SELECT category, count, ROUND(percentage::numeric, 1) as percentage_pct
FROM taskos.v_archive_stats
ORDER BY category;

\echo ''
\echo '=== NEXT ARCHIVE CANDIDATES ==='
SELECT 
  COUNT(*) as tasks_ready_for_archive,
  MIN(days_since_appointment) as oldest_days,
  MAX(days_since_appointment) as newest_days
FROM taskos.v_archive_candidates;
EOF
```

---

## 🔍 Detailed Monitoring Checklist

### Daily Checks (Automated via Cron)

```bash
#!/bin/bash
# Daily archive monitoring script
# Add to crontab: 0 8 * * * /path/to/archive_monitor.sh

TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
LOG_FILE="/var/log/tascos/archive_monitor.log"

echo "[$TIMESTAMP] Starting archive system health check" >> $LOG_FILE

# Check 1: Archive job runs at expected time
psql -d labstack -c "
  SELECT COUNT(*) as recent_archives 
  FROM taskos.tasks 
  WHERE \"isArchived\" = true 
    AND \"updatedAt\" > NOW() - INTERVAL '24 hours'
" >> $LOG_FILE

# Check 2: Archive stats are healthy
psql -d labstack -c "
  SELECT category, count 
  FROM taskos.v_archive_stats 
  WHERE category IN ('Active Tasks', 'Archived Tasks')
" >> $LOG_FILE

# Check 3: No recent errors
if grep -q "error" /var/log/tascos/archive_*.log 2>/dev/null; then
  echo "[$TIMESTAMP] ⚠️ WARNING: Archive errors detected" >> $LOG_FILE
else
  echo "[$TIMESTAMP] ✅ No archive errors" >> $LOG_FILE
fi

echo "[$TIMESTAMP] Archive health check complete" >> $LOG_FILE
```

### Weekly Review (Manual)

Every Monday, review:

1. **Archive Statistics**
   ```sql
   SELECT * FROM taskos.v_archive_stats;
   ```
   - Expected: Archived count growing, Active staying stable

2. **Archive Rate**
   ```sql
   SELECT 
     DATE_TRUNC('day', "updatedAt") as archive_date,
     COUNT(*) as tasks_archived
   FROM taskos.tasks
   WHERE "isArchived" = true
   GROUP BY DATE_TRUNC('day', "updatedAt")
   ORDER BY archive_date DESC
   LIMIT 7;
   ```
   - Expected: ~daily runs archiving tasks > 10 days old

3. **Operational Impact**
   - Check ops team feedback (clearer dashboard?)
   - Verify task counts are accurate
   - Confirm no operational issues

### Monthly Review (Management)

Every month, create a report:

```sql
SELECT
  'Total Tasks' as category,
  COUNT(*) as current_count,
  ROUND(COUNT(*) * 100.0 / LAG(COUNT(*)) OVER (ORDER BY NULL), 1) as pct_of_last_month
FROM taskos.tasks
WHERE "createdAt" < NOW() - INTERVAL '30 days'

UNION ALL

SELECT 'Active Tasks', COUNT(*), NULL
FROM taskos.tasks
WHERE "isArchived" = false
  AND "createdAt" < NOW() - INTERVAL '30 days'

UNION ALL

SELECT 'Archived Tasks', COUNT(*), NULL
FROM taskos.tasks
WHERE "isArchived" = true
  AND "createdAt" < NOW() - INTERVAL '30 days';
```

---

## ⚙️ Scheduler Initialization

### Option 1: Add to Application Startup (Recommended)

Add this to your main application initialization file (e.g., `src/lib/server/init.ts`):

```typescript
import { initializeArchiveScheduler } from '@/lib/engine/archiveScheduler';

export async function initializeServer() {
  console.log('[App] Initializing server...');
  
  // Initialize archive scheduler (runs nightly at 2 AM)
  initializeArchiveScheduler();
  
  console.log('[App] Archive scheduler initialized');
  
  // ... other initialization
}
```

Then call `initializeServer()` in your app startup (e.g., in a root layout effect or API route).

### Option 2: Manual Trigger (Testing/On-Demand)

```bash
# Manually trigger archive job
curl -X POST http://localhost:3000/api/tasks/archive \
  -H "Content-Type: application/json"

# Expected response:
# { "success": true, "message": "Archive job executed successfully" }
```

### Option 3: External Cron Job

```bash
# Add to your system crontab (runs at 2 AM daily)
0 2 * * * curl -X POST http://localhost:3000/api/tasks/archive

# Or use scheduling service like AWS Lambda, Google Cloud Scheduler, etc.
```

---

## 🚨 Troubleshooting

### Issue: Archive job not running

**Check 1: Verify scheduler initialized**
```bash
# Look for initialization log message
tail -f /var/log/app.log | grep "Archive scheduler"
# Expected: "[ArchiveScheduler] Initialized - archive runs daily at 2 AM"
```

**Check 2: Verify database connectivity**
```bash
psql -d labstack -c "SELECT COUNT(*) FROM taskos.tasks;"
# Should return task count without error
```

**Check 3: Check for errors in logs**
```bash
grep "\[TaskArchiver\]" /var/log/app.log | tail -20
# Should show execution logs without [ERROR]
```

### Issue: Archived tasks still showing in active view

**Check:** Verify API filter is in place
```bash
grep -n "isArchived: false" /src/app/api/tasks/route.ts
# Should show at least one match
```

**Fix:** Restart dev server if changes were made:
```bash
npm run dev
```

### Issue: Archive stats view is empty

**Check:** Verify view exists
```bash
psql -d labstack -c "\dv taskos.v_*"
# Should list v_archive_stats among other views
```

**Rebuild:** If missing, recreate views:
```bash
psql -d labstack < migrations/create_archive_views.sql
```

---

## 📈 Expected Metrics

### Healthy System

```
Daily Archive Activity:
├── Tasks archived per cycle: 0-5 (depends on new data)
├── Active task count: Stable or decreasing
├── Archived task count: Growing slowly
└── Errors: None

Archive Stats:
├── Active Tasks: Reflects current workload
├── Archived Tasks: 300+ (from April orders)
├── Completed Tasks: 5-10
└── Cancelled Tasks: 0-2

Dashboard Performance:
├── Load time: < 500ms
├── Task list accuracy: 100%
├── Archive counts: Match v_archive_stats
└── Search accuracy: No archived tasks appearing
```

### Unhealthy System

```
⚠️ Warning Signs:
├── Archive job errors in logs
├── Archived count decreasing unexpectedly
├── Active task count suddenly jumping
├── API endpoints timing out
├── Dashboard showing incorrect counts
└── Archived tasks appearing in active list
```

---

## 🔧 Configuration Tuning

### Adjust Archive Threshold

If 10 days is too aggressive or too conservative:

**File:** `src/lib/engine/taskArchiver.ts` (line 8)

```typescript
const DAYS_THRESHOLD = 10;  // Change this

// Recommended values:
// 3 days   = Archive after 3 days (aggressive)
// 7 days   = Standard for most teams
// 10 days  = Current (keeps 1+ week visible)
// 14 days  = Conservative (keeps 2 weeks)
// 30 days  = Very conservative (monthly)
```

After changing:
1. Redeploy application
2. Scheduler will use new threshold on next run
3. Already-archived tasks stay archived

### Adjust Schedule Time

If 2 AM doesn't work for your timezone:

**File:** `src/lib/engine/archiveScheduler.ts` (line 22)

```typescript
cron.schedule("0 2 * * *", async () => {  // Change first two values

// Format: minute hour day month dayOfWeek
// "0 2 * * *" = 2:00 AM daily
// "0 1 * * *" = 1:00 AM daily
// "30 3 * * *" = 3:30 AM daily
// "0 2 * * 0" = 2:00 AM Sundays only
```

---

## 📋 Monitoring Checklist

### Daily (Automated)
- [ ] Archive job executes at 2 AM
- [ ] 0+ tasks marked as archived
- [ ] No error logs
- [ ] Dashboard loads successfully

### Weekly
- [ ] Archive stats reviewed
- [ ] Active task count is accurate
- [ ] Ops team confirms dashboard is cleaner
- [ ] No unarchive requests

### Monthly
- [ ] Trend analysis: Archive rate healthy?
- [ ] Performance: Response times acceptable?
- [ ] Threshold review: 10 days still appropriate?
- [ ] Cost analysis: Database size acceptable?

---

## 🔐 Safety Checks

### Before Going Live

- [ ] Database backed up
- [ ] Archive logic tested manually: `POST /api/tasks/archive`
- [ ] Unarchive endpoint tested: `PATCH /api/tasks/123/unarchive`
- [ ] Dashboard shows correct counts
- [ ] Archive page loads without errors
- [ ] Search excludes archived tasks correctly
- [ ] All logs reviewed for errors

### Ongoing Safety

- [ ] Never delete the `isArchived` column
- [ ] Never use `isArchived = true` as deletion
- [ ] Always backup before schema changes
- [ ] Keep archive views synced with actual data
- [ ] Document any threshold changes

---

## 📞 Support & Escalation

If archive system issues occur:

1. **Check daily logs:** `grep "\[Archive" /var/log/app.log`
2. **Verify database:** `psql -d labstack -c "SELECT COUNT(*) FROM taskos.tasks;"`
3. **Check API:** `curl http://localhost:3000/api/tasks/archive/stats`
4. **Manual trigger:** `curl -X POST http://localhost:3000/api/tasks/archive`
5. **Review this document:** Troubleshooting section above

Contact: Operations Head or DevOps Team

---

## 🎯 Success Criteria

Archive system is working correctly when:

✅ Daily archive job runs automatically  
✅ Old tasks (10+ days) disappear from active view  
✅ Archive count grows over time  
✅ All 320 tasks still in database (none deleted)  
✅ Ops team confirms dashboard is clearer  
✅ Search results don't include archived tasks  
✅ Archive page shows complete history  
✅ Manual unarchive works when needed  
✅ No error logs related to archiving  
✅ Dashboard performance remains fast  

---

## Next Steps

1. Initialize scheduler in app startup
2. Monitor first 7 days of operation
3. Adjust threshold if needed
4. Document any operational changes
5. Train ops team on archive system (if needed)
6. Review monthly for optimization opportunities
