# Multi-Source Task System - Quick Start Guide

## 🚀 Get Started in 5 Minutes

### 1. **System Automatically Initializes on App Startup**
When you open TaskOS, the system automatically:
- ✅ Initializes the polling engine
- ✅ Loads all configured data sources  
- ✅ Starts cron jobs for automatic polling
- ✅ Begins creating tasks from all sources

**No manual setup required!**

### 2. **View Your Data Sources**
Navigate to `/head/data-sources`

You'll see:
- **Orders** - Already configured and polling (every 5 minutes)
- **Camps** - Available for configuration

### 3. **Enable Camps (Optional)**
Call this API once to configure Camps:
```bash
curl -X POST http://localhost:3000/api/data-sources/seed \
  -H "Content-Type: application/json" \
  -d '{"source": "camps"}'
```

Or make a POST request via the UI if available.

**Result**: Camps will be polled and tasks created automatically

### 4. **View All Tasks (Multi-Source)**
Navigate to `/head/tasks` (or your all tasks board)

You can now:
- ✅ See tasks from Orders and Camps together
- ✅ Filter by source: `?source=orders` or `?source=camps`
- ✅ Filter by type: `?sourceType=VACCINATION` or `?sourceType=BLOOD_TEST`
- ✅ See source column in task list

### 5. **Monitor Polling Health**
Check system health and polling status:
```bash
GET /api/health
```

Returns:
- Number of active sources
- Scheduled polling jobs
- Database connection status
- Last poll times per source

### 6. **Trigger Polling Manually** (if needed)
In the Data Sources page, click "Manual Poll" button for any source

Or call API:
```bash
POST /api/data-sources/{sourceId}/manual-poll
```

---

## 📊 What Tasks Get Created

### From Orders
- Blood tests needing entry
- Pathology orders needing scheduling
- Order status updates

### From Camps
- Camp setup tasks (4 hour SLA)
- Resource verification tasks (3 hour SLA)
- Post-event reporting tasks (6 hour SLA)

### Each Task Includes
- ✅ Source identification
- ✅ Entity reference back to source
- ✅ Source-specific metadata
- ✅ Status sync-back to source system

---

## 🔧 Configuration

### View Current Configuration
```bash
GET /api/data-sources
```

Returns all sources with:
- Polling interval
- Last poll time
- Success/failure rates
- Task creation metrics

### Add a New Source

**Option 1: Via API (simplest)**
```bash
POST /api/data-sources/seed
{ "source": "appointments" }
```

**Option 2: Manual via Database**
```sql
INSERT INTO data_sources (...)
VALUES (...)
```

### Create Task Rules for New Sources

Task rules determine when to create tasks.

Example: "When a camp is registered, create a setup task"

Currently configured for Camps:
1. **Setup Rule** - Triggered on REGISTERED status
2. **Resources Rule** - Triggered on SCHEDULED status  
3. **Reporting Rule** - Triggered on COMPLETED status

Existing Orders rules still work unchanged!

---

## 🔍 Troubleshooting

### "No tasks being created"
1. Check `/api/health` - is polling running?
2. Check Data Sources page - are sources active?
3. Trigger manual poll for the source
4. Check DataSourcePollingLog for errors

### "Only Orders tasks, no Camps tasks"
1. Ensure Camps source is configured: GET `/api/data-sources`
2. If missing, run seeding API: POST `/api/data-sources/seed`
3. Wait 5 minutes for next polling cycle
4. Or trigger manual poll immediately

### "Task created but status not updating source"
1. Check if source has sync enabled: GET `/api/data-sources/{sourceId}`
2. Verify syncStrategy is not "NONE"
3. Check if source has syncEndpoint configured
4. View DataSourcePollingLog for sync errors

---

## 📈 Monitoring & Metrics

### Key Metrics to Watch
1. **Polling Success Rate**: Should be 100%
2. **Tasks Created per Cycle**: Should be consistent
3. **Average Polling Duration**: Should be < 1 second
4. **Failed Syncs**: Should be 0

### Where to Find Them
```bash
GET /api/data-sources/{sourceId}/polling-status
GET /api/health
```

### Database Query
```sql
SELECT 
  source_id,
  status,
  COUNT(*) as polls,
  AVG(duration_ms) as avg_duration_ms,
  SUM(tasks_created) as total_tasks
FROM data_source_polling_logs
GROUP BY source_id, status
```

---

## 🎯 Common Tasks

### Filter tasks by Camps only
```
GET /api/tasks?source=camps
```

### Filter tasks by Vaccination camps
```
GET /api/tasks?source=camps&sourceType=VACCINATION
```

### View all sources and their status
```
Navigate to /head/data-sources
```

### Check why a poll failed
```
GET /api/data-sources/{sourceId}/polling-status
```
Look at "recentPolls" array for error messages

### Force immediate polling
```
POST /api/data-sources/{sourceId}/manual-poll
```

---

## ✨ Features Unlocked

With multi-source now active:

1. ✅ **Unified Task Board** - All sources in one view
2. ✅ **Automatic Polling** - 5-minute intervals (configurable)
3. ✅ **Real-time Webhooks** - POST events to `/api/webhooks/{sourceId}`
4. ✅ **Status Sync-back** - Task changes sync back to source
5. ✅ **Source Filtering** - Filter tasks by origin
6. ✅ **Scalable** - Add sources without code changes
7. ✅ **Reliable** - Error handling and logging
8. ✅ **Observable** - Health checks and metrics

---

## 📚 For Developers

### Adding a New Source (Code-Free)
See `MULTI_SOURCE_FEATURE_COMPLETE.md`

### Webhook Signature Validation
If your source supports webhooks:
```typescript
// Client calculates
signature = HMAC-SHA256(payload, shared_secret)

// Sends as header
X-Webhook-Signature: sha256=<hex-signature>

// Server validates using secret from DataSource config
```

### Custom Assignment Strategies
Sources can specify custom assignment strategies:
- `route_by_store` - Route to agent in same store
- `round_robin` - Rotate through available agents
- `geo_based` - Route to nearest agent
- `skill_based` - Route to agents with skills
- `least_loaded` - Route to agent with fewest tasks
- `priority_based` - Route based on task priority

---

## 🚨 Important Notes

1. **Polling starts automatically** - Once a source is registered, it starts polling
2. **Interval is configurable** - Default 5 minutes, can be changed per source
3. **No tasks until rules exist** - Source must have matching rules to create tasks
4. **Status sync requires config** - Source must have syncStrategy and endpoint set
5. **All tasks are unified** - Single task board for all sources

---

## 📞 Next Steps

1. Go to `/head/data-sources` to manage sources
2. Seed Camps source for testing
3. Create task rules for any new sources
4. Monitor polling status via `/api/health`
5. Test end-to-end with manual polling

**Questions?** Check logs, test APIs, or review `MULTI_SOURCE_FEATURE_COMPLETE.md`

---

**Status**: Ready for Production ✅
