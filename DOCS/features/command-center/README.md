# Command Center - Feature Documentation

Welcome to the Command Center (HEAD Dashboard) documentation! This is the central control hub for operations management.

## 📚 Documentation Structure

| Document | Purpose | Audience |
|----------|---------|----------|
| [FEATURE_SPEC.md](FEATURE_SPEC.md) | Dashboard features, KPIs, alerts | Product Managers, Operations |
| [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) | Architecture, components, data flow | Backend & Frontend Developers |
| [API_ENDPOINTS.md](API_ENDPOINTS.md) | All dashboard endpoints | API Consumers, Frontend Developers |
| [TESTING_GUIDE.md](TESTING_GUIDE.md) | Testing strategy for dashboard | QA Engineers |

## 🎯 Feature Overview

The **Command Center** (HEAD Dashboard) provides operations leaders with a real-time, unified view of the entire system state including:

- ✅ **Real-Time Stats Widget** - Live counts of tasks, team status, and active alerts
- ✅ **Team Capacity Display** - Agent workload and availability status
- ✅ **SLA Health Overview** - System-wide SLA performance metrics
- ✅ **Critical Alerts** - High-priority items requiring immediate attention
- ✅ **Daily Summary** - Previous day's KPIs and trends
- ✅ **Quick Actions** - Fast access to common operations
- ✅ **Auto-Refresh** - Updates every 60 seconds with new data

## 🚀 Quick Start

### Entry Point
- **URL**: `/head` (HEAD role users only)
- **Component**: `/src/app/(app)/head/page.tsx` → `HeadCommandCenter`
- **Main Dashboard API**: `GET /api/dashboard`

### Key Components
```
src/app/(app)/head/
├── page.tsx                    # Main dashboard
├── tasks/page.tsx             # All Tasks board
├── rules/page.tsx             # Task Rules panel
├── analytics/page.tsx         # Analytics & reporting
└── engine/page.tsx            # Engine health monitor
```

### What's Displayed
1. **Stats Widget** - Task counts by status, team members online, SLA health %
2. **Team Panel** - Agent availability, current workload, assignments
3. **Alerts Panel** - Critical issues (SLA breaches, stuck tasks)
4. **Yesterday's Summary** - Completed tasks, breached tasks, trends

## 🔗 Related Features

- **All Tasks**: Detailed task board → [All Tasks Docs](../all-tasks/)
- **Task Rules**: Automation configuration → [Task Rules Docs](../task-rules/)
- **Analytics**: Detailed reporting → [Analytics Docs](../analytics/)
- **Engine**: Background processing → [Engine Docs](../engine/)

## 🏗️ Dashboard Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Command Center - Real-Time Operations Dashboard           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Stats Widget              │  Team Capacity Widget         │
│  ─────────────────        │  ─────────────────────        │
│  Tasks: 466               │  Online Agents: 12/15         │
│  Created: 45              │  Avg Load: 38.5 tasks         │
│  Assigned: 23             │  Capacity: 87% utilized       │
│  In Progress: 178         │                              │
│  Breached: 8              │                              │
│  Completed: 156           │                              │
│                           │                              │
│  ─────────────────────────────────────────────────────────│
│                                                             │
│  Alerts & Critical Items           Yesterday's Summary     │
│  ─────────────────────             ────────────────      │
│  🔴 8 SLA Breached tasks          ✅ Tasks completed: 156  │
│  🟠 12 Tasks stuck >60min         ⚠️  Tasks breached: 8   │
│  🟠 Critical skill shortage       📈 Avg completion: 4h   │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  [View All Tasks] [Task Rules] [Analytics] [Engine Health] │
└─────────────────────────────────────────────────────────────┘
```

## 📊 Key Metrics

- **Task Counts** - By status (7 states)
- **Team Status** - Online agents, average workload
- **SLA Health** - System-wide performance percentage
- **Alerts** - Count of critical items
- **Daily Metrics** - Previous day's completed/breached counts

## 🔄 Auto-Refresh

- Default: Every 60 seconds
- Configurable: Via dashboard settings
- Data sources: Task counts, team status, alert counts, daily summary

## 💡 Use Cases

1. **Operations Lead** - Glance at overall system health
2. **On-Call Supervisor** - Quickly identify critical issues
3. **Team Manager** - Monitor team capacity and workload
4. **SLA Analyst** - Track system-wide SLA performance

## 🔌 API

Main endpoint:
```
GET /api/dashboard

Response:
{
  "taskCounts": { /* by status */ },
  "teamStatus": { /* online agents */ },
  "slaHealth": { /* system SLA % */ },
  "criticalAlerts": [ /* urgent items */ ],
  "yesterdaySummary": { /* previous day KPIs */ }
}
```

Full documentation: [API_ENDPOINTS.md](API_ENDPOINTS.md)

## 📋 Implementation Status

- ✅ Stats widget with auto-refresh
- ✅ Team capacity display
- ✅ Alerts panel
- ✅ Yesterday's summary
- ⏳ Real-time WebSocket updates (planned)

---

**Last Updated**: May 2, 2026  
**Documentation Version**: 1.0
