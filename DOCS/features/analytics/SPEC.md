# Analytics - Feature Documentation

Welcome to the Analytics and Reporting feature documentation!

## 📚 Documentation Structure

| Document | Purpose | Audience |
|----------|---------|----------|
| [FEATURE_SPEC.md](FEATURE_SPEC.md) | Reports, KPIs, insights | Product Managers, Operations |
| [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) | Architecture, data aggregation | Developers |
| [API_ENDPOINTS.md](API_ENDPOINTS.md) | Analytics endpoints | API Consumers |

## 🎯 Feature Overview

The **Analytics** feature provides operations teams with detailed performance metrics, reporting, and insights including:

- ✅ **Agent Performance Reports** - Individual agent completion rates, SLA adherence
- ✅ **Daily Summary Reports** - System-wide KPIs by day
- ✅ **SLA Analytics** - Breach trends, risk analysis
- ✅ **Task Aging Analysis** - Time distribution in each status
- ✅ **Team Workload Trends** - Capacity utilization over time
- ✅ **Custom Date Ranges** - Filter reports by date
- ✅ **Export Capability** - Download reports as CSV

## 🚀 Quick Start

### Entry Point
- **URL**: `/head/analytics`
- **Component**: `/src/app/(app)/head/analytics/page.tsx`
- **API**: `GET /api/analytics/*`

### Key Metrics
- **Completed Tasks** - Tasks finished within SLA
- **Breached Tasks** - Tasks that missed SLA deadline
- **Agent Performance** - Completion rate, average time per task
- **System Health** - Overall SLA adherence percentage

## 🔌 API Endpoints

```
GET /api/analytics/summary         # Daily KPIs
GET /api/analytics/agents          # Per-agent metrics
GET /api/analytics/sla             # SLA performance
GET /api/analytics/aging           # Task time distribution
```

Full documentation: [API_ENDPOINTS.md](API_ENDPOINTS.md)

## 🔗 Related Features

- **All Tasks**: View individual tasks → [All Tasks Docs](../all-tasks/)
- **Command Center**: Dashboard overview → [Command Center Docs](../command-center/)

---

**Last Updated**: May 2, 2026  
**Documentation Version**: 1.0
