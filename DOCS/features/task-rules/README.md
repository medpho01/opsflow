# Task Rules - Feature Documentation

Welcome to the Task Rules automation engine documentation! This directory contains everything needed to understand, configure, and extend the rule-based task creation system.

## 📚 Documentation Structure

| Document | Purpose | Audience |
|----------|---------|----------|
| [FEATURE_SPEC.md](FEATURE_SPEC.md) | Rule concepts, SOPs, UI/UX | Product Managers, Operations, Designers |
| [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) | Architecture, APIs, evaluation engine | Backend & Frontend Developers |
| [API_ENDPOINTS.md](API_ENDPOINTS.md) | All endpoints for rule operations | API Consumers, Frontend Developers |
| [TESTING_GUIDE.md](TESTING_GUIDE.md) | Unit, integration, E2E testing strategy | QA Engineers, Developers |
| [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) | Phases (P1-P4), effort, milestones | Project Managers, Tech Leads |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common issues, debug guides | Support, DevOps, Developers |

## 🎯 Feature Overview

The **Task Rules** feature enables operations teams to automate task creation based on configurable conditions. Instead of creating tasks manually, rules automatically create tasks when orders match specified conditions.

### What It Does
- ✅ **Rule Creation** - Define rules with status triggers and time conditions
- ✅ **Auto-Evaluation** - Background poller evaluates rules every 5 minutes
- ✅ **Skill-Based Assignment** - Route tasks to agents with required skills
- ✅ **Metadata Filtering** - Trigger on order metadata (e.g., report ETA)
- ✅ **Deduplication** - Prevent duplicate task creation
- ✅ **Audit Trail** - Track all rule changes with who/when/what
- ✅ **Rule Builder UI** - Create/edit rules without API calls

### Key Use Cases
1. **Booking Confirmation** - Create task when order scheduled
2. **Pre-Visit Confirmation** - Remind patient 1 hour before appointment
3. **Sample Collection Follow-up** - Task when sample collected
4. **Report Delivery** - Monitor report delivery timing
5. **SLA Escalation** - Auto-escalate tasks nearing breach

## 🚀 Quick Start for Developers

### Where is the code?
```
src/
├── app/(app)/head/rules/page.tsx             # Rule management UI
├── components/task-rules/                    # Rule builder components
│   ├── RulesPanel.tsx                       # Main rule list
│   ├── RuleBuilder.tsx                      # Rule creation form
│   └── ...                                  # Sub-components
├── app/api/task-rules/                      # API endpoints
│   ├── route.ts                            # POST/GET rules
│   ├── [id]/route.ts                       # PATCH/DELETE rule
│   ├── valid-statuses/route.ts             # GET valid statuses
│   ├── metadata-fields/route.ts            # GET available fields
│   └── [id]/audit-log/route.ts             # GET rule changes
├── lib/engine/                              # Evaluation engine
│   ├── poller.ts                           # 5-min polling cycle
│   ├── taskCreator.ts                      # Rule evaluation logic
│   ├── labstack.ts                         # Order fetching
│   ├── slaWatcher.ts                       # SLA breach detection
│   └── ruleAudit.ts                        # Audit logging
└── prisma/schema.prisma                     # TaskRule model
```

### How to run locally?
```bash
# Start development server
npm run dev

# Visit Rule Builder
http://localhost:3000/head/rules

# Watch engine logs
npm run logs:engine

# Run tests
npm test -- task-rules
```

### Key Concepts

**Rule Components:**
- **Trigger Condition**: When to evaluate (status-based or time-based)
- **Task Configuration**: What task to create (type, priority, SLA)
- **Assignment**: Who gets the task (skill requirements, escalation chain)

**Trigger Types:**
- **Status-Based**: Fire when order status matches (e.g., ORDER_SCHEDULED)
- **Time-Based**: Fire after X minutes in current status
- **Metadata-Based**: Fire when metadata condition met (e.g., reportETA < 2 hours)

**Evaluation Flow:**
```
1. Poller runs every 5 minutes
2. Fetch all active rules
3. For each rule, fetch matching orders
4. Evaluate trigger condition
5. If matches & no duplicate → Create task
6. Log metrics for analytics
```

## 🏗️ Architecture Overview

```
Poller (Every 5 mins)
    ↓
Get All Active Rules
    ↓
For Each Rule:
  ├─ Fetch orders by orderType
  ├─ Evaluate trigger condition
  │   ├─ Check status
  │   ├─ Check time conditions
  │   └─ Check metadata conditions
  ├─ Check for duplicates
  └─ If match → Create task with assignment
    ↓
Write Metrics → Analytics
```

## 📊 Supported Status Values

Current (13 statuses):
```
CANCELED, CREATED, KIT_DISPATCHED, ORDER_SCHEDULED,
PATIENT_MISSED, PATIENT_VISITED, PENDING, PHLEBO_ASSIGNED,
REPORT_DELIVERED, RESCHEDULED, SAMPLE_COLLECTED,
SAMPLE_DELIVERED, SAMPLE_PROCESSED
```

Get list via: `GET /api/task-rules/valid-statuses`

## 🔗 Related Features

- **All Tasks**: Where created tasks appear → [All Tasks Docs](../all-tasks/)
- **Engine**: Background polling system → [Engine Docs](../engine/)
- **Command Center**: Dashboard overview → [Command Center Docs](../command-center/)

## 📋 Implementation Status

### Completed (Phase 1-4)
- ✅ Status enum validation (P1)
- ✅ Metadata-based triggers (P2)
- ✅ Dynamic enum fetching (Special Phase)
- ✅ Audit trail for rule changes (P4)

### In Progress / Planned
- 🚧 Rule Builder UI (P3)
- ⏳ Advanced filtering (Multi-order aggregates)
- ⏳ Webhook triggers (External systems)

## 🧪 Testing

This feature includes:
- ✅ Unit tests for trigger evaluation logic
- ✅ Integration tests for rule creation/update/delete
- ✅ E2E tests for complete rule workflows
- ✅ Database seeding with test rules

See [TESTING_GUIDE.md](TESTING_GUIDE.md) for detailed strategy.

## 🎬 Getting Started

**For Operations Teams:**
1. Read [FEATURE_SPEC.md](FEATURE_SPEC.md) to understand rule concepts
2. Use Rule Builder UI to create rules
3. Monitor rule execution in Engine dashboard

**For Developers:**
1. Read [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) for architecture
2. Review [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) for phases
3. Check [API_ENDPOINTS.md](API_ENDPOINTS.md) for endpoint specs
4. Follow [TESTING_GUIDE.md](TESTING_GUIDE.md) for test patterns

**For DevOps:**
1. Review [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) for deployment
2. Monitor via Engine dashboard
3. Check [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for issues

## 📈 Rule Examples

### Example 1: Booking Confirmation
```json
{
  "name": "Confirm Appointment Booking",
  "orderType": "HOME_SAMPLE",
  "taskType": "BOOKING_CONFIRMATION",
  "priority": "HIGH",
  "slaMinutes": 30,
  "triggerCondition": {
    "statusIn": ["ORDER_SCHEDULED"]
  }
}
```

### Example 2: Pre-Visit Reminder
```json
{
  "name": "Pre-Visit Confirmation",
  "orderType": "HOME_SAMPLE",
  "taskType": "PRE_VISIT_CONFIRM",
  "priority": "MEDIUM",
  "slaMinutes": 60,
  "triggerCondition": {
    "statusIn": ["PHLEBO_ASSIGNED"],
    "minutesBeforeAppointment": 60
  }
}
```

### Example 3: Report Monitoring
```json
{
  "name": "Report Delivery Tracking",
  "orderType": "HOME_SAMPLE",
  "taskType": "REPORT_TRACKING",
  "priority": "MEDIUM",
  "slaMinutes": 120,
  "triggerCondition": {
    "statusIn": ["SAMPLE_DELIVERED"],
    "metadataConditions": [{
      "fieldPath": "reportETA",
      "operator": "<=",
      "offsetMinutes": 120
    }]
  }
}
```

## ❓ FAQ

**Q: How often are rules evaluated?**  
A: Every 5 minutes via the polling engine.

**Q: Can a rule create multiple tasks?**  
A: No, one rule creates one task per matching order (deduplication prevents duplicates).

**Q: What happens if an order already has a task for this rule?**  
A: Deduplication logic prevents duplicate creation.

**Q: How long does evaluation take?**  
A: Typically <50ms per order, entire cycle <5 minutes.

**Q: Can I trigger on multiple order types?**  
A: No, each rule is tied to one orderType. Create multiple rules if needed.

---

**Last Updated**: May 2, 2026  
**Documentation Version**: 1.0
