# Multi-Source Task Creation System
## Technical Architecture & Implementation Guide

---

## 1. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                   MULTI-SOURCE TASK SYSTEM                  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ POLLING LAYER                                        │  │
│  │ ┌────────────────┬────────────────┬──────────────┐  │  │
│  │ │ Orders Source  │ Appt Source    │ Camps Source│  │  │
│  │ │ Polling Worker │ Polling Worker │ Polling ... │  │  │
│  │ └────────────────┴────────────────┴──────────────┘  │  │
│  │                     ↓                                │  │
│  │            Task Creation Engine                      │  │
│  │  (source-aware rule matching & task creation)       │  │
│  └──────────────────────────────────────────────────────┘  │
│                        ↓                                    │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ UNIFIED TASK MODEL                                   │  │
│  │ (Tasks with source metadata)                         │  │
│  └──────────────────────────────────────────────────────┘  │
│                        ↓                                    │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ API LAYER                                            │  │
│  │ ├─ /api/tasks (unified interface)                   │  │
│  │ ├─ /api/data-sources (source mgmt)                  │  │
│  │ ├─ /api/task-rules (source-scoped)                  │  │
│  │ └─ /api/polling-status (observability)              │  │
│  └──────────────────────────────────────────────────────┘  │
│                        ↓                                    │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ PRESENTATION LAYER                                   │  │
│  │ └─ All Tasks Board (multi-source unified view)       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Core Concepts & Terminology

### 2.1 Key Entities

| Entity | Definition | Example |
|--------|-----------|---------|
| **Source** | A table/system that contains order-like entities | Orders, Appointments, Camps |
| **Entity** | A single record from a source | OrderId=2000005, AppointmentId=apt123 |
| **Source Type** | A classification field within a source | OrderType, AppointmentType |
| **Source Status** | A status field within a source | orderStatus, appointmentStatus |
| **Task Rule** | Defines when to create tasks for entity combinations | If source=Orders AND type=BLOOD_TEST AND status=CREATED, create task with SOP X |
| **Polling Cycle** | One complete scan of a source for new entities | Orders polling cycle executes every 5 minutes |

### 2.2 Data Flow

```
1. POLLING
   Source Handler reads entities from source
   ↓
2. RULE MATCHING
   For each entity, find matching Task Rules (by source + type + status)
   ↓
3. TASK CREATION
   Create Task record with source metadata
   ↓
4. PERSISTENCE
   Save task to database and publish event
   ↓
5. SYNC (Optional)
   Notify source system of task creation (if configured)
```

---

## 3. Database Schema

### 3.1 New Tables

#### Table: `DataSource`
```sql
CREATE TABLE data_source (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Identification
  source_id VARCHAR(50) NOT NULL UNIQUE,  -- "orders", "appointments"
  display_name VARCHAR(255) NOT NULL,
  description TEXT,
  
  -- Schema Definition
  table_reference VARCHAR(255) NOT NULL,  -- "public.orders" or external API ref
  primary_key_field VARCHAR(50) NOT NULL, -- "id" (field name)
  
  -- Type & Status Fields
  type_field_name VARCHAR(50) NOT NULL,   -- "orderType", "appointmentType"
  status_field_name VARCHAR(50) NOT NULL, -- "orderStatus", "appointmentStatus"
  
  -- Metadata
  query_template TEXT NOT NULL,           -- SQL with placeholders for last_poll_time
  metadata_field_mapping JSONB,           -- {patientName: "patient.name", ...}
  
  -- Configuration
  polling_interval_minutes INT DEFAULT 5,
  is_active BOOLEAN DEFAULT true,
  backfill_enabled BOOLEAN DEFAULT false,
  backfill_days INT DEFAULT 7,
  
  -- Sync Configuration
  sync_back_enabled BOOLEAN DEFAULT false,
  sync_endpoint VARCHAR(255),             -- external API endpoint
  sync_handler_type VARCHAR(50),          -- "api", "database", "webhook"
  
  -- Auditing
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  created_by UUID REFERENCES "user"(id),
  
  INDEX idx_source_id (source_id),
  INDEX idx_is_active (is_active)
);
```

#### Table: `DataSourcePollingLog`
```sql
CREATE TABLE data_source_polling_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  source_id UUID NOT NULL REFERENCES data_source(id),
  
  -- Timing
  poll_started_at TIMESTAMP NOT NULL,
  poll_completed_at TIMESTAMP,
  duration_ms INT,
  
  -- Results
  entities_found INT,
  entities_processed INT,
  tasks_created INT,
  tasks_failed INT,
  
  -- Status
  status VARCHAR(20) NOT NULL,  -- "PENDING", "IN_PROGRESS", "SUCCESS", "ERROR", "PARTIAL"
  error_message TEXT,
  
  -- Details
  details JSONB DEFAULT '{}',   -- {entitiesByType: {...}, failedEntities: [...]}
  
  created_at TIMESTAMP DEFAULT NOW(),
  
  INDEX idx_source_id (source_id),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at DESC)
);
```

#### Table: `TaskRuleSourceScope` (New table)
```sql
CREATE TABLE task_rule_source_scope (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  task_rule_id UUID NOT NULL REFERENCES task_rule(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  
  -- Scope Definition
  allowed_types JSONB NOT NULL,     -- ["BLOOD_TEST", "CONSULTATION"]
  allowed_statuses JSONB NOT NULL,  -- ["CREATED", "PENDING"]
  
  -- Assignment Strategy
  assignment_strategy VARCHAR(50) DEFAULT 'default',  -- "route_by_store", "round_robin", etc.
  assignment_strategy_config JSONB DEFAULT '{}',
  
  -- SLA Override (for this source)
  sla_minutes_override INT,
  
  -- Active Status
  is_active BOOLEAN DEFAULT true,
  
  -- Auditing
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  created_by UUID REFERENCES "user"(id),
  
  UNIQUE(task_rule_id, source_id),
  INDEX idx_source_id (source_id),
  INDEX idx_is_active (is_active)
);
```

#### Table: `Task` (Schema Extension)
```sql
-- Add columns to existing task table:
ALTER TABLE task ADD COLUMN (
  source VARCHAR(50),              -- "orders", "appointments", "camps"
  source_type VARCHAR(100),        -- "BLOOD_TEST", "CONSULTATION", etc.
  source_status VARCHAR(100),      -- current status in source system
  source_entity_id BIGINT,         -- ID in source system (Orders.id, Appt.id, etc.)
  source_last_synced_at TIMESTAMP, -- when we last synced status back to source
  source_handler_context JSONB,    -- source-specific context for sync logic
  
  INDEX idx_source (source),
  INDEX idx_source_entity (source, source_entity_id)
);
```

---

## 4. Polling Architecture

### 4.1 Source Handler Interface

All data sources implement the same interface:

```typescript
interface ISourceHandler {
  /**
   * Metadata about this source
   */
  getSourceInfo(): SourceInfo;

  /**
   * Fetch entities needing task review
   * @param since Last poll time - only get entities created/modified since then
   * @param limit Batch size for polling
   */
  fetchEntitiesNeedingTasks(since: Date, limit: number): Promise<Entity[]>;

  /**
   * Sync task status back to source
   * Called when task status changes
   */
  syncTaskStatusToSource(
    taskId: number,
    sourceEntityId: number,
    newStatus: TaskStatus,
    context: Record<string, unknown>
  ): Promise<void>;

  /**
   * Validate if source is accessible
   * Called during source registration
   */
  validateConnection(): Promise<{ ok: boolean; message: string }>;

  /**
   * Get available types and statuses for this source
   * Called during source configuration
   */
  getAvailableMetadata(): Promise<SourceMetadata>;
}

interface Entity {
  id: number | string;        // source's primary key
  type: string;               // type within source (orderType, appointmentType, etc.)
  status: string;             // status within source
  metadata: Record<string, unknown>;
  createdAt: Date;
  modifiedAt: Date;
}

interface SourceInfo {
  sourceId: string;
  displayName: string;
  primaryKeyField: string;
  typeField: string;
  statusField: string;
}

interface SourceMetadata {
  availableTypes: { label: string; value: string }[];
  availableStatuses: { label: string; value: string }[];
  metadataFields: { name: string; type: 'string' | 'number' | 'datetime' }[];
}
```

### 4.2 Source Handler Implementations

#### Orders Handler
```typescript
class OrdersSourceHandler implements ISourceHandler {
  getSourceInfo(): SourceInfo {
    return {
      sourceId: "orders",
      displayName: "Lab Orders",
      primaryKeyField: "id",
      typeField: "orderType",
      statusField: "orderStatus",
    };
  }

  async fetchEntitiesNeedingTasks(since: Date, limit: number): Promise<Entity[]> {
    const orders = await db.query(`
      SELECT 
        id,
        order_type as type,
        order_status as status,
        patient_name,
        lab_name,
        phlebo_name,
        created_at,
        updated_at,
        json_build_object(
          'patientName', patient_name,
          'labName', lab_name,
          'phleboName', phlebo_name
        ) as metadata
      FROM orders
      WHERE updated_at > $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [since, limit]);
    
    return orders.map(o => ({
      id: o.id,
      type: o.type,
      status: o.status,
      metadata: o.metadata,
      createdAt: o.created_at,
      modifiedAt: o.updated_at,
    }));
  }

  async syncTaskStatusToSource(
    taskId: number,
    sourceEntityId: number,
    newStatus: TaskStatus,
    context: Record<string, unknown>
  ): Promise<void> {
    // Call external Orders API or update orders table
    await orderApi.updateOrderStatus(sourceEntityId, {
      taskStatus: newStatus,
      updatedBy: 'TaskOS'
    });
  }

  async validateConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      await db.query('SELECT 1 FROM orders LIMIT 1');
      return { ok: true, message: 'Connected to Orders table' };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  async getAvailableMetadata(): Promise<SourceMetadata> {
    // Fetch from database or hard-coded config
    return {
      availableTypes: [
        { label: 'Blood Test', value: 'BLOOD_TEST' },
        { label: 'Pathology', value: 'PATHOLOGY' },
      ],
      availableStatuses: [
        { label: 'Created', value: 'CREATED' },
        { label: 'Scheduled', value: 'SCHEDULED' },
      ],
      metadataFields: [
        { name: 'patientName', type: 'string' },
        { name: 'labName', type: 'string' },
      ],
    };
  }
}
```

#### Appointments Handler
```typescript
class AppointmentsSourceHandler implements ISourceHandler {
  // Similar implementation, different source
  // Points to appointments table or API
}
```

#### Camps Handler
```typescript
class CampsSourceHandler implements ISourceHandler {
  // Similar implementation for camps
}
```

### 4.3 Polling Engine

```typescript
class PollingEngine {
  private handlers: Map<string, ISourceHandler> = new Map();
  private lastPollTimes: Map<string, Date> = new Map();

  /**
   * Register a source handler
   */
  registerHandler(sourceId: string, handler: ISourceHandler) {
    this.handlers.set(sourceId, handler);
  }

  /**
   * Run polling cycle for all sources
   */
  async runPollingCycle(): Promise<void> {
    const sources = await db.query(`
      SELECT id, source_id, polling_interval_minutes 
      FROM data_source 
      WHERE is_active = true
    `);

    for (const source of sources) {
      // Check if it's time to poll this source
      const lastPoll = this.lastPollTimes.get(source.source_id);
      const shouldPoll = !lastPoll || 
        (Date.now() - lastPoll.getTime()) > (source.polling_interval_minutes * 60 * 1000);

      if (!shouldPoll) continue;

      await this.pollSource(source.id, source.source_id);
    }
  }

  /**
   * Poll a single source
   */
  private async pollSource(sourceDbId: string, sourceId: string): Promise<void> {
    const logId = uuidv4();
    const startTime = new Date();

    try {
      await db.query(
        `INSERT INTO data_source_polling_log (id, source_id, status, poll_started_at)
         VALUES ($1, $2, $3, $4)`,
        [logId, sourceDbId, 'IN_PROGRESS', startTime]
      );

      const handler = this.handlers.get(sourceId);
      if (!handler) {
        throw new Error(`No handler registered for source: ${sourceId}`);
      }

      // Fetch entities from source
      const lastPollTime = this.lastPollTimes.get(sourceId) || 
        new Date(Date.now() - 24 * 60 * 60 * 1000); // Default to last 24h
      
      const entities = await handler.fetchEntitiesNeedingTasks(lastPollTime, 100);

      // Process each entity
      let tasksCreated = 0;
      let tasksFailed = 0;
      const entitiesByType: Record<string, number> = {};
      const failedEntities: Array<{ id: string; reason: string }> = [];

      for (const entity of entities) {
        try {
          // Find matching task rules for this entity
          const rules = await this.findMatchingRules(sourceDbId, entity.type, entity.status);

          for (const rule of rules) {
            const task = await this.createTask(sourceId, rule, entity);
            tasksCreated++;
          }

          // Track entity type
          entitiesByType[entity.type] = (entitiesByType[entity.type] || 0) + 1;
        } catch (error) {
          tasksFailed++;
          failedEntities.push({
            id: String(entity.id),
            reason: error.message,
          });
        }
      }

      // Update polling log
      await db.query(
        `UPDATE data_source_polling_log 
         SET status = $1, 
             poll_completed_at = $2,
             duration_ms = $3,
             entities_found = $4,
             entities_processed = $5,
             tasks_created = $6,
             tasks_failed = $7,
             details = $8
         WHERE id = $9`,
        [
          'SUCCESS',
          new Date(),
          Date.now() - startTime.getTime(),
          entities.length,
          entities.length,
          tasksCreated,
          tasksFailed,
          JSON.stringify({
            entitiesByType,
            failedEntities,
          }),
          logId,
        ]
      );

      this.lastPollTimes.set(sourceId, new Date());
    } catch (error) {
      await db.query(
        `UPDATE data_source_polling_log 
         SET status = $1, error_message = $2, poll_completed_at = $3
         WHERE id = $4`,
        ['ERROR', error.message, new Date(), logId]
      );

      console.error(`Polling failed for source ${sourceId}:`, error);
    }
  }

  /**
   * Find task rules that match source + type + status
   */
  private async findMatchingRules(
    sourceId: string,
    type: string,
    status: string
  ): Promise<any[]> {
    return db.query(
      `SELECT tr.*, trss.assignment_strategy, trss.sla_minutes_override
       FROM task_rule tr
       JOIN task_rule_source_scope trss ON tr.id = trss.task_rule_id
       WHERE trss.source_id = $1
         AND trss.is_active = true
         AND trss.allowed_types @> $2
         AND trss.allowed_statuses @> $3`,
      [sourceId, JSON.stringify([type]), JSON.stringify([status])]
    );
  }

  /**
   * Create task from entity and matching rule
   */
  private async createTask(
    sourceId: string,
    rule: any,
    entity: Entity
  ): Promise<any> {
    const task = {
      title: rule.title_template.replace('{type}', entity.type),
      description: rule.description,
      priority: rule.priority,
      source: sourceId,
      sourceType: entity.type,
      sourceStatus: entity.status,
      sourceEntityId: entity.id,
      entityId: entity.id,
      entityType: sourceId.toUpperCase(),
      taskRuleId: rule.id,
      metadata: entity.metadata,
      status: 'CREATED',
      createdAt: new Date(),
    };

    return db.query(
      `INSERT INTO task (
        title, description, priority, source, source_type, source_status,
        source_entity_id, entity_id, entity_type, task_rule_id, metadata, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      Object.values(task)
    );
  }
}
```

---

## 5. API Endpoints

### 5.1 Data Source Management

#### POST `/api/data-sources`
Create/register a new data source

```typescript
Request {
  sourceId: string;              // "appointments"
  displayName: string;           // "Patient Appointments"
  description: string;
  tableReference: string;        // "public.appointments"
  primaryKeyField: string;       // "id"
  typeField: string;             // "appointmentType"
  statusField: string;           // "appointmentStatus"
  queryTemplate: string;         // SQL with $since placeholder
  metadataFieldMapping: Record<string, string>;
  pollingIntervalMinutes: number;
  isActive: boolean;
}

Response {
  id: UUID;
  sourceId: string;
  displayName: string;
  validationResult: { ok: boolean; message: string };
  backfillStatus?: { entitiesFound: number; tasksCreated: number };
}
```

#### GET `/api/data-sources`
List all registered sources

```typescript
Response {
  sources: {
    id: UUID;
    sourceId: string;
    displayName: string;
    isActive: boolean;
    pollingIntervalMinutes: number;
    lastPollAt?: Date;
    pollingStatus: 'HEALTHY' | 'WARNING' | 'ERROR';
  }[];
}
```

#### GET `/api/data-sources/{id}/polling-status`
Get detailed polling status for a source

```typescript
Response {
  sourceId: string;
  lastPoll: {
    startedAt: Date;
    completedAt: Date;
    status: 'SUCCESS' | 'ERROR' | 'PARTIAL';
    entitiesFound: number;
    tasksCreated: number;
    errorMessage?: string;
  };
  recentPolls: Array<{
    startedAt: Date;
    status: string;
    tasksCreated: number;
  }>;
}
```

### 5.2 Task Rules (Enhanced)

#### POST `/api/task-rules`
Create task rule with source scoping

```typescript
Request {
  name: string;
  description: string;
  sourceScopes: Array<{
    sourceId: UUID;           // references DataSource.id
    allowedTypes: string[];   // ["BLOOD_TEST", "CONSULTATION"]
    allowedStatuses: string[]; // ["CREATED", "PENDING"]
    assignmentStrategy: string;
    slaMinutes: number;
  }>;
  sop: {
    steps: Array<{ order: number; text: string; isRequired: boolean }>;
  };
}

Response {
  id: UUID;
  name: string;
  sourceScopes: Array<{ sourceId: UUID; allowedTypes: string[] }>;
}
```

#### PUT `/api/task-rules/{id}`
Update task rule including source scopes

### 5.3 Tasks (Enhanced)

#### GET `/api/tasks`
Existing endpoint enhanced with source filtering

```typescript
Query params {
  source?: string;           // Filter by source (e.g., "orders", "appointments")
  sourceType?: string;       // Filter by source type
  sourceStatus?: string;     // Filter by source status
  ...existing filters...
}

Response {
  tasks: Array<{
    id: number;
    title: string;
    source: string;              // NEW
    sourceType: string;          // NEW
    sourceStatus: string;        // NEW
    sourceEntityId: number;      // NEW
    status: string;
    priority: string;
    ...existing fields...
  }>;
  pagination: { pages: number; total: number };
}
```

---

## 6. Task Creation Flow (Detailed)

```
┌─────────────────────────────────────────────────┐
│ 1. POLLING ENGINE TICK (every 5 minutes)        │
├─────────────────────────────────────────────────┤
│  For each active source:                        │
│  - Get handler (OrdersHandler, ApptsHandler)   │
│  - Call handler.fetchEntitiesNeedingTasks()    │
│  - Get list of entities from source            │
└─────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────┐
│ 2. RULE MATCHING                                │
├─────────────────────────────────────────────────┤
│  For each entity (e.g., Order #2000005):       │
│  - Get source, type, status                    │
│  - Query: SELECT rules WHERE                   │
│    source_id = orders                          │
│    AND type IN ['BLOOD_TEST']                  │
│    AND status IN ['CREATED', 'PENDING']        │
│  - Find matching rule                          │
└─────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────┐
│ 3. ASSIGNMENT STRATEGY                          │
├─────────────────────────────────────────────────┤
│  Rule.assignmentStrategy = "route_by_store"    │
│  - Get store from entity metadata              │
│  - Find available agents for that store        │
│  - Assign task to agent                        │
│  - Set SLA deadline (rule.sla + now)          │
└─────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────┐
│ 4. TASK CREATION                                │
├─────────────────────────────────────────────────┤
│  INSERT INTO task (                            │
│    source: "orders",                           │
│    sourceType: "BLOOD_TEST",                   │
│    sourceStatus: "CREATED",                    │
│    sourceEntityId: 2000005,                    │
│    title: "BLOOD_TEST for Order #2000005",    │
│    metadata: { patientName: "...", ... },     │
│    ...                                         │
│  )                                             │
└─────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────┐
│ 5. EVENT PUBLISHING (async)                     │
├─────────────────────────────────────────────────┤
│  PUBLISH event:                                │
│  - event_type: "task.created"                  │
│  - task_id: 12345                              │
│  - source: "orders"                            │
│  - listeners: [SyncWorker, NotificationSvc]   │
└─────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────┐
│ 6. SOURCE SYNC (if enabled)                     │
├─────────────────────────────────────────────────┤
│  handler.syncTaskStatusToSource(...)           │
│  - Call Orders API: "New task created"        │
│  - Update order status (optional)              │
└─────────────────────────────────────────────────┘
```

---

## 7. File Structure

```
src/
├── app/
│   └── api/
│       ├── data-sources/           [NEW]
│       │   ├── route.ts            (GET all, POST create)
│       │   ├── [id]/
│       │   │   └── polling-status/ (GET polling details)
│       │   └── validate/           (POST validation)
│       ├── task-rules/             [ENHANCED]
│       │   └── route.ts            (updated to handle source scopes)
│       └── tasks/                  [ENHANCED]
│           ├── route.ts            (updated to filter by source)
│           └── [id]/route.ts       (updated for sync-back)
│
├── lib/
│   ├── polling/                    [NEW]
│   │   ├── polling-engine.ts       (main polling orchestrator)
│   │   ├── handlers/               (source handlers)
│   │   │   ├── types.ts            (ISourceHandler interface)
│   │   │   ├── orders-handler.ts
│   │   │   ├── appointments-handler.ts
│   │   │   └── camps-handler.ts
│   │   └── scheduling/
│   │       └── cron-jobs.ts        (polling scheduler)
│   │
│   ├── task-creation/              [ENHANCED]
│   │   ├── create-task.ts          (updated for multi-source)
│   │   ├── rule-matcher.ts         (source-aware rule matching)
│   │   └── assignment-engine.ts    (source-aware assignment)
│   │
│   └── sync/                       [NEW]
│       ├── task-sync.ts            (sync task status back to source)
│       └── sync-handlers/          (source-specific sync logic)
│
├── components/
│   └── head/
│       ├── DataSourcesManager.tsx  [NEW] (UI for data source config)
│       ├── TaskRulesPanel.tsx      [ENHANCED] (add source scoping UI)
│       └── AllTasksBoard.tsx       [ENHANCED] (add source filtering)
│
└── types/
    └── multi-source.ts             [NEW] (TypeScript interfaces)
```

---

## 8. Implementation Phases

### Phase 1: Foundation (Week 1-2)
- [x] Database schema creation
- [x] Data Source model and API
- [x] Source Handler interface
- [x] Orders Handler implementation
- [x] Task Rule source scoping
- [ ] Task model extensions
- [ ] Polling engine setup (basic)

### Phase 2: Integration (Week 3)
- [ ] Polling scheduler (cron jobs)
- [ ] Task creation from multiple sources
- [ ] Rule matching engine (source-aware)
- [ ] API endpoints enhancement
- [ ] UI: Data Sources Manager

### Phase 3: Sync & Observability (Week 4)
- [ ] Task sync-back to sources
- [ ] Polling status dashboard
- [ ] Error handling & retry logic
- [ ] Testing across sources

### Phase 4: Expansion (Week 5+)
- [ ] Appointments source
- [ ] Camps source
- [ ] Additional sources (backlog)

---

## 9. Migration Plan

### 9.1 Data Migration
```sql
-- Add new columns to existing tasks
ALTER TABLE task ADD COLUMN source VARCHAR(50) DEFAULT 'orders';
ALTER TABLE task ADD COLUMN source_type VARCHAR(100);
ALTER TABLE task ADD COLUMN source_status VARCHAR(100);
ALTER TABLE task ADD COLUMN source_entity_id BIGINT;

-- Backfill existing tasks (all are from orders)
UPDATE task 
SET source = 'orders',
    source_type = metadata->>'orderType',
    source_status = metadata->>'orderStatus',
    source_entity_id = entity_id
WHERE source IS NULL;

-- Create data_source record for Orders (pre-configured)
INSERT INTO data_source (
  source_id, display_name, table_reference, primary_key_field,
  type_field_name, status_field_name, is_active
) VALUES (
  'orders', 'Lab Orders', 'public.orders', 'id',
  'order_type', 'order_status', true
);
```

### 9.2 Backward Compatibility
- Existing task queries work as-is (source field defaults to 'orders')
- Existing task rules automatically scoped to 'orders' source
- UI gradually migrated to show source field

---

## 10. Testing Strategy

### 10.1 Unit Tests
- Source handler interface implementations
- Rule matching logic (source-aware)
- Task creation with source metadata
- Sync-back logic per source

### 10.2 Integration Tests
- End-to-end polling cycle
- Multi-source task creation
- Task status sync back to source
- Error handling & retry

### 10.3 Test Scenarios
1. **Single Source**: Orders → Tasks (existing flow, verify no regression)
2. **New Source**: Register Appointments → Poll → Create Tasks
3. **Mixed Sources**: Orders + Appointments in same view, filter by source
4. **Rule Scoping**: Same rule name, different behavior per source
5. **Sync-Back**: Task completion syncs status back to source
6. **Error Cases**: Source unavailable, polling timeout, sync failure

---

## 11. Configuration Examples

### 11.1 Orders Source (Pre-configured)
```javascript
{
  sourceId: "orders",
  displayName: "Lab Orders",
  tableReference: "public.orders",
  primaryKeyField: "id",
  typeField: "order_type",
  statusField: "order_status",
  queryTemplate: `
    SELECT * FROM orders 
    WHERE updated_at > $1 
    ORDER BY created_at DESC
  `,
  metadataFieldMapping: {
    patientName: "patient_name",
    labName: "lab_name",
    phleboName: "phlebo_name",
    appointmentTime: "appointment_time"
  }
}
```

### 11.2 Appointments Source (New)
```javascript
{
  sourceId: "appointments",
  displayName: "Patient Appointments",
  tableReference: "public.appointments",
  primaryKeyField: "id",
  typeField: "appointment_type",
  statusField: "appointment_status",
  queryTemplate: `
    SELECT * FROM appointments 
    WHERE updated_at > $1 
    ORDER BY created_at DESC
  `,
  metadataFieldMapping: {
    patientName: "patient_name",
    doctorName: "doctor_name",
    appointmentTime: "scheduled_time",
    consultationType: "consultation_type"
  }
}
```

### 11.3 Sample Task Rule (Multi-Source)
```javascript
{
  name: "Pathology Order Entry",
  description: "Create task for entering pathology orders",
  sourceScopes: [
    {
      sourceId: "orders-uuid",
      allowedTypes: ["PATHOLOGY"],
      allowedStatuses: ["CREATED", "RECEIVED"],
      assignmentStrategy: "route_by_store",
      slaMinutes: 120
    }
  ],
  sop: {
    steps: [
      { order: 1, text: "Verify order details", isRequired: true },
      { order: 2, text: "Check specimen quality", isRequired: true },
      { order: 3, text: "Enter into LIMS", isRequired: true }
    ]
  }
}
```

---

## 12. Monitoring & Alerting

### 12.1 Key Metrics
- `polling_cycle_duration_ms` per source
- `entities_found_per_cycle` per source
- `task_creation_success_rate` per source
- `task_sync_back_success_rate` per source
- `poll_failure_count` per source

### 12.2 Alerts
- Polling failure for a source (ERROR status)
- Task creation rate anomaly (too high/low)
- Sync-back failures (task status not synced)
- Source connectivity issues

---

## 13. Security Considerations

### 13.1 Access Control
- Only OPS_HEAD can register/configure data sources
- Only system admins can modify polling intervals
- Task rules can be created by OPS_HEAD (per source)

### 13.2 Data Isolation
- Source metadata stored securely (JSONB)
- Source credentials (if any) encrypted
- Audit trail for all source configuration changes

---

## 14. Future Enhancements

- ML-based rule suggestions based on historical task patterns
- Cross-source task dependencies (task from Orders linked to Appointment)
- Dynamic polling frequency based on entity creation rate
- Source-specific task assignment strategies (geo-based, AI-based, etc.)
- Real-time event streaming instead of polling

