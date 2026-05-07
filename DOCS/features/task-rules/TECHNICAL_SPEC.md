# Task Rules - Technical Specification

**Tech Lead: Manjul (Tech Architect)**  
**Developer: Mayur (Senior Developer)**  
**Version: 1.0** (Feature Documentation Restructure - May 2, 2026)

---

## Quick Navigation
- 🔌 [API Endpoints](API_ENDPOINTS.md)
- 🧪 [Testing Guide](TESTING_GUIDE.md)
- 🗺️ [Implementation Roadmap](IMPLEMENTATION_ROADMAP.md)

---

## 1. System Architecture

### 1.1 High-Level Overview

```
┌─────────────────────────────────────────────────────────────┐
│                   Browser (React Admin)                      │
├─────────────────────────────────────────────────────────────┤
│  RulesPanel (list) → RuleBuilder (create/edit)              │
│  Display rules, create/update/delete actions                │
└─────────────────────────────────────────────────────────────┘
                            ▼ (HTTP)
┌─────────────────────────────────────────────────────────────┐
│                   API Layer (Next.js)                        │
├─────────────────────────────────────────────────────────────┤
│  POST   /api/task-rules                  Create rule         │
│  GET    /api/task-rules                  List all rules      │
│  PATCH  /api/task-rules/{id}             Update rule         │
│  DELETE /api/task-rules/{id}             Delete rule         │
│  GET    /api/task-rules/valid-statuses   Get status options  │
│  GET    /api/task-rules/metadata-fields  Get field docs      │
│  GET    /api/task-rules/{id}/audit-log   Get change history  │
└─────────────────────────────────────────────────────────────┘
                            ▼ (SQL)
┌─────────────────────────────────────────────────────────────┐
│              PostgreSQL Database                            │
├─────────────────────────────────────────────────────────────┤
│  TaskRule (rule definitions)                                │
│  TaskRuleSkill (join table for skill requirements)          │
│  TaskRuleAudit (change audit trail)                         │
│  Task (created tasks)                                       │
│  Order (Labstack orders)                                    │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 Evaluation Flow (Polling Engine)

```
Cron Job: Every 5 minutes
    ↓
src/lib/engine/poller.ts
    ├─ Acquire lock (prevent duplicate runs)
    ├─ Get all active rules
    │   └─ Query: SELECT * FROM TaskRule WHERE isActive = true
    ├─ For each rule:
    │   └─ Call evaluateRuleForOrderType()
    │       └─ Fetch matching orders from Labstack
    │       └─ For each order, evaluate trigger condition
    │       └─ If matches && no duplicate:
    │           ├─ Create task via taskCreator.ts
    │           ├─ Store in database
    │           └─ Log metrics
    ├─ Run SLA watcher
    ├─ Generate daily summary
    └─ Release lock
```

### 1.3 Trigger Evaluation

**Status-Based Trigger:**
```typescript
// Example: Fire when order status is ORDER_SCHEDULED
function evaluateTrigger(order: Order, rule: TaskRule): boolean {
  const { triggerCondition } = rule;
  
  // 1. Check status
  if (!triggerCondition.statusIn.includes(order.status)) {
    return false; // Order not in matching status
  }
  
  // 2. Check time conditions (if any)
  if (triggerCondition.minutesSinceCreated) {
    const minutesPassed = (now - order.createdAt) / 60000;
    if (minutesPassed < triggerCondition.minutesSinceCreated) {
      return false; // Not enough time passed
    }
  }
  
  // 3. Check deduplication
  if (checkDuplicateTask(order.id, rule.taskTypeId)) {
    return false; // Task already exists
  }
  
  return true; // All conditions met
}
```

**Metadata-Based Trigger:**
```typescript
// Example: Fire when reportETA is within next 2 hours
function evaluateMetadataCondition(order: Order, condition: MetadataCondition): boolean {
  const fieldValue = getNestedField(order.metadata, condition.fieldPath);
  
  switch (condition.operator) {
    case "<=":
      // Compare timestamp with offset
      const fieldTime = new Date(fieldValue).getTime();
      const thresholdTime = now.getTime() + (condition.offsetMinutes * 60_000);
      return fieldTime <= thresholdTime;
    
    case "exists":
      return fieldValue !== undefined && fieldValue !== null;
    
    case "equals":
      return fieldValue === condition.value;
    
    // ... other operators
  }
}
```

---

## 2. Database Schema

### 2.1 Core Models

```prisma
model TaskRule {
  id              String   @id @default(nanoid())
  name            String   @unique
  description     String?
  
  // Trigger Configuration
  orderType       OrderType  // HOME_SAMPLE, CENTER_VISIT, etc
  triggerCondition Json     // Stored as JSONB
  
  // Task Configuration
  taskTypeId      Int
  taskType        TaskType @relation(fields: [taskTypeId], references: [id])
  titleTemplate   String   // "Confirm {{patientName}} appointment"
  priority        TaskPriority @default(MEDIUM)
  slaMinutes      Int      // Required SLA duration
  
  // Assignment
  requiredSkills  TaskRuleSkill[]  // Skills needed for assignee
  escalationChainId Int?
  escalationChain EscalationChain? @relation(fields: [escalationChainId], references: [id])
  
  // Management
  isActive        Boolean  @default(true)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  // Metrics
  totalTasksCreated Int @default(0)
  tasksLast24h    Int @default(0)
  lastExecutedAt  DateTime?
  
  @@index([orderType])
  @@index([isActive])
  @@index([createdAt])
}

model TaskRuleSkill {
  id          Int      @id @default(autoincrement())
  taskRuleId  String
  taskRule    TaskRule @relation(fields: [taskRuleId], references: [id], onDelete: Cascade)
  skillTagId  Int
  skillTag    SkillTag @relation(fields: [skillTagId], references: [id])
  
  @@unique([taskRuleId, skillTagId])
  @@index([skillTagId])
}

model TaskRuleAudit {
  id              Int      @id @default(autoincrement())
  ruleId          String
  action          String   // CREATE, UPDATE, DELETE, ACTIVATE, DEACTIVATE
  changedById     Int?
  changedBy       User?    @relation(fields: [changedById], references: [id])
  changesSummary  Json?    // Before/after values
  metadata        Json?    // Additional info
  createdAt       DateTime @default(now())
  
  @@index([ruleId])
  @@index([changedById])
  @@index([createdAt])
}
```

### 2.2 Indexes for Performance

```sql
CREATE INDEX idx_task_rule_order_type ON task_rules(order_type);
CREATE INDEX idx_task_rule_is_active ON task_rules(is_active);
CREATE INDEX idx_task_rule_created_at ON task_rules(created_at);
CREATE INDEX idx_task_rule_audit_rule_id ON task_rule_audits(rule_id);
CREATE INDEX idx_task_rule_audit_created ON task_rule_audits(created_at);
```

---

## 3. API Specifications

See [API_ENDPOINTS.md](API_ENDPOINTS.md) for complete endpoint documentation.

**Key Endpoints:**
- `POST /api/task-rules` - Create new rule
- `GET /api/task-rules` - List all rules
- `PATCH /api/task-rules/{id}` - Update rule
- `DELETE /api/task-rules/{id}` - Delete rule
- `GET /api/task-rules/valid-statuses` - Get status options
- `GET /api/task-rules/metadata-fields` - Get metadata field docs
- `GET /api/task-rules/{id}/audit-log` - Get change history

---

## 4. Validation & Error Handling

### 4.1 Trigger Condition Validation

```typescript
function validateTriggerCondition(condition: TriggerCondition): ValidationResult {
  // Must have at least one status
  if (!condition.statusIn || condition.statusIn.length === 0) {
    return { valid: false, error: "statusIn is required" };
  }
  
  // Validate status values against database enum
  const validStatuses = await getValidOrderStatuses();
  const invalid = condition.statusIn.filter(s => !validStatuses.includes(s));
  if (invalid.length > 0) {
    return { 
      valid: false, 
      error: "Invalid order statuses",
      invalidStatuses: invalid,
      validStatuses: validStatuses
    };
  }
  
  // Validate time conditions (if present)
  if (condition.minutesSinceCreated && condition.minutesSinceCreated < 0) {
    return { valid: false, error: "minutesSinceCreated must be >= 0" };
  }
  
  // Validate metadata conditions (if present)
  if (condition.metadataConditions) {
    for (const mc of condition.metadataConditions) {
      if (!mc.fieldPath || !mc.operator) {
        return { valid: false, error: "Metadata condition missing required fields" };
      }
    }
  }
  
  return { valid: true };
}
```

### 4.2 Error Response Format

```typescript
interface ErrorResponse {
  error: string;
  code: string;
  details?: {
    invalidStatuses?: string[];
    validStatuses?: string[];
    field?: string;
  };
}

// Examples
{ error: "Invalid order status", code: "INVALID_STATUS", 
  details: { invalidStatuses: ["INVALID"], 
             validStatuses: ["ORDER_SCHEDULED", ...] } }

{ error: "Rule name already exists", code: "DUPLICATE_NAME" }

{ error: "Task type not found", code: "NOT_FOUND" }
```

---

## 5. Performance Characteristics

| Operation | Target | Notes |
|-----------|--------|-------|
| Create rule | <100ms | Single insert + join relations |
| Get all rules | <50ms | Simple SELECT with relations |
| Evaluate 1 rule | <50ms | Per-order evaluation |
| Full polling cycle | <5 min | 5-min interval, handles 100s of rules |
| Trigger evaluation | <1ms | Per-order, memory-based |

---

## 6. Files & Dependencies

### Core Files
```
src/app/api/task-rules/
├── route.ts                    (POST, GET)
├── [id]/route.ts              (PATCH, DELETE)
├── valid-statuses/route.ts    (GET valid statuses)
├── metadata-fields/route.ts   (GET field docs)
└── [id]/audit-log/route.ts    (GET audit log)

src/lib/engine/
├── poller.ts                  (5-min polling cycle)
├── taskCreator.ts             (Rule evaluation)
├── ruleAudit.ts               (Audit logging)
└── labstack.ts                (Order fetching)

src/components/task-rules/
├── RulesPanel.tsx             (List & manage rules)
├── RuleBuilder.tsx            (Create/edit rule)
└── ...                        (Sub-components)
```

### External Dependencies
- **Prisma**: ORM for database operations
- **Node Cron**: For scheduling polling tasks
- **Next.js**: API route handlers
- **Labstack API**: For fetching order data

---

## 7. Testing Strategy

See [TESTING_GUIDE.md](TESTING_GUIDE.md) for:
- Unit tests for trigger evaluation
- Integration tests for API endpoints
- E2E tests for complete workflows

---

## 8. Deployment

See [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) for:
- Database migrations
- Feature deployment
- Monitoring setup

---

**Last Updated**: May 2, 2026  
**Documentation Version**: 1.0
