# Engine - Feature Documentation

Welcome to the TaskOS Engine (Background Processing) documentation! This is the heart of automated task creation and system maintenance.

## 📚 Documentation Structure

| Document | Purpose | Audience |
|----------|---------|----------|
| [FEATURE_SPEC.md](FEATURE_SPEC.md) | Engine capabilities, processes | Architects, Tech Leads |
| [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) | Architecture, polling cycle, services | Backend Developers, DevOps |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Detailed polling flow, decision logic | System Designers |
| [API_ENDPOINTS.md](API_ENDPOINTS.md) | Monitoring endpoints | DevOps, System Admin |

## 🎯 Feature Overview

The **Engine** is the autonomous background processing system that:

- ✅ **Rule Evaluation** - Every 5 minutes, evaluates task creation rules
- ✅ **Task Auto-Creation** - Creates tasks when orders match rule conditions
- ✅ **SLA Monitoring** - Watches for deadline breaches
- ✅ **Duplicate Prevention** - Ensures no duplicate task creation
- ✅ **Daily Summaries** - Generates performance metrics
- ✅ **Task Archival** - Cleans up old completed tasks
- ✅ **Health Monitoring** - Self-diagnostic checks and alerts
- ✅ **Metrics Collection** - Performance tracking and logging

## 🚀 Quick Start

### Core Processes
1. **Poller** - Runs every 5 minutes (`/src/lib/engine/poller.ts`)
2. **Rule Evaluator** - Evaluates rules against orders (`taskCreator.ts`)
3. **SLA Watcher** - Monitors SLA deadlines (`slaWatcher.ts`)
4. **Daily Summary** - Generates report (`dailySummary.ts`)
5. **Archive Scheduler** - Cleans up old tasks (`archiveScheduler.ts`)

### Entry Points
```
src/lib/engine/
├── poller.ts               # Main polling cycle (runs every 5 min)
├── taskCreator.ts          # Rule evaluation & task creation
├── slaWatcher.ts           # SLA breach detection
├── dailySummary.ts         # Daily metrics aggregation
├── archiveScheduler.ts     # Old task cleanup
└── labstack.ts             # Order fetching from external API
```

### Monitoring
- **URL**: `/head/engine` (engine health dashboard)
- **API**: `GET /api/engine/health`, `GET /api/engine/logs`

## 🏗️ Polling Cycle

Every 5 minutes:

```
1. Acquire Lock (prevent concurrent runs)
2. Load All Active Rules
   └─ SELECT * FROM TaskRule WHERE isActive = true
3. For Each Rule:
   ├─ Fetch Matching Orders (from Labstack API)
   ├─ Evaluate Trigger Condition
   │  └─ Check: status, time conditions, metadata
   ├─ Check for Duplicates
   └─ If Matches & No Duplicate:
       └─ Create Task in Database
4. Run SLA Watcher
   └─ Find breached tasks & update status
5. Release Lock
6. Log Metrics
   └─ Write to analytics database
```

**Duration**: Typically <2 minutes for full cycle

## 📊 Processing Pipeline

```
Labstack Orders
    ↓
Poller (every 5 min)
    ├─ Load Rules
    ├─ Evaluate Each Rule
    │   ├─ Filter orders by orderType
    │   ├─ Evaluate trigger (status, time, metadata)
    │   ├─ Check duplicates
    │   └─ Create task if matches
    ├─ Watch SLA breaches
    └─ Log metrics
    ↓
TaskOS Database
    ├─ Task table (new tasks)
    ├─ Audit table (for logging)
    └─ Analytics (metrics)
```

## 🔌 Monitoring API

```
GET /api/engine/health             # Current engine status
GET /api/engine/logs?lines=100     # Recent logs
GET /api/engine/metrics/last-cycle # Last polling cycle stats
```

## 📈 Key Metrics

- **Cycle Duration** - Time to complete one polling cycle
- **Rules Evaluated** - Number of rules checked
- **Tasks Created** - New tasks from this cycle
- **Duplicates Prevented** - Rules that matched but found duplicates
- **SLA Breaches Detected** - Tasks that missed deadline
- **Error Count** - Failed operations

## 🚨 Alert Conditions

Engine generates alerts if:
- ⚠️ Polling cycle takes >5 minutes
- 🔴 Lock acquisition fails (previous cycle still running)
- 🔴 Labstack API unreachable
- 🔴 Database connection lost
- ⚠️ High error rate in task creation

## 🔗 Related Features

- **Task Rules**: Rules that engine evaluates → [Task Rules Docs](../task-rules/)
- **All Tasks**: Tasks that engine creates → [All Tasks Docs](../all-tasks/)
- **Analytics**: Metrics that engine generates → [Analytics Docs](../analytics/)

## ⚙️ Configuration

**Polling Interval**: 5 minutes (hardcoded in `poller.ts`)
**Labstack API Timeout**: 30 seconds
**Task Archive Age**: 90 days (configurable)

See [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) for all configuration options.

## 🧪 Testing

- Unit tests for trigger evaluation
- Integration tests for complete polling cycle
- Load tests for high-volume rule processing
- Mock Labstack API for testing

See [TESTING_GUIDE.md](TESTING_GUIDE.md)

## 📋 Implementation Status

- ✅ Core polling engine
- ✅ Rule evaluation
- ✅ SLA watching
- ✅ Daily summaries
- ✅ Task archival
- ✅ Health monitoring
- ⏳ Performance optimization (caching)
- ⏳ Distributed processing (multi-instance)

---

**Last Updated**: May 2, 2026  
**Documentation Version**: 1.0
