# Multi-Source Task Creation System

## Overview

The multi-source polling system enables TaskOS to create tasks from multiple data sources (Orders, Appointments, Camps, etc.) based on configurable task rules. Each source has its own handler that knows how to fetch entities and sync status back.

## Architecture

### Components

#### 1. Generic Database Source Handler (`handlers/database-source-handler.ts`)

**Single reusable handler for ANY database table** - fully configurable, no code changes needed to add new sources.

Implements `ISourceHandler` interface with:
- `getSourceInfo()` - Returns metadata about the source
- `fetchEntitiesNeedingTasks(since, limit)` - Fetches entities using dynamic SQL queries
- `syncTaskStatusToSource(taskId, sourceEntityId, status, context)` - Syncs task status back
- `validateConnection()` - Validates table exists and is accessible
- `getAvailableMetadata()` - Returns available types and statuses

**Scalability Features:**
- Takes configuration from `DataSource` model
- Dynamically builds queries from `queryTemplate`
- Maps fields using `metadataFieldMapping`
- Works with any table structure (different column names, field types)
- Single class instance can handle 100+ sources
- Add new source by inserting DataSource record - zero code changes

**How Configuration Works:**
```javascript
{
  sourceId: "orders",
  tableReference: "public.orders",
  primaryKeyField: "id",
  typeFieldName: "orderType",
  statusFieldName: "orderStatus",
  queryTemplate: "SELECT * FROM orders WHERE updated_at > $1 LIMIT $2",
  metadataFieldMapping: {
    patientName: "patient_name",
    labName: "lab_name",
    appointmentTime: "appointment_time"
  }
}
```

#### 2. Polling Engine (`polling-engine.ts`)
Orchestrates polling cycles:
- Registers and manages source handlers
- Coordinates parallel polling of multiple sources
- Creates tasks for fetched entities
- Logs polling results and metrics

#### 3. Rule Matching (`../task-creation/rule-matcher.ts`)
Determines which task rules apply to source entities:
- Matches entity type and status against rule scopes
- Respects source-specific rule configuration
- Filters by allowed types/statuses per source
- Returns matching rules sorted by priority

#### 4. Task Creation Service (`../task-creation/create-task-service.ts`)
Creates tasks from source entities:
- Generates task titles from templates
- Calculates SLA deadlines (with source-specific overrides)
- Stores source metadata for sync-back
- Handles task deduplication

## Data Flow

```
Source Entities (Orders, Appointments, Camps)
    ↓
Polling Engine.pollSource()
    ↓
SourceHandler.fetchEntitiesNeedingTasks()
    ↓
RuleMatcher.findMatchingRules()
    ↓
TaskCreationService.createTaskFromSourceEntity()
    ↓
Task created with source metadata
    ↓
Task Status Changes
    ↓
TaskCreationService.syncTaskStatusToSource()
    ↓
SourceHandler.syncTaskStatusToSource()
    ↓
Source System Updated
```

## Usage

### 1. Initialize the Polling Engine (at app startup)

```typescript
import { initializePollingEngine } from "@/lib/polling/init-polling-engine";

// In your main.ts or Next.js startup
await initializePollingEngine();

// This automatically:
// 1. Loads ALL data sources from DataSource table
// 2. Creates DatabaseSourceHandler instances for each
// 3. Registers them with the PollingEngine
// 4. Validates all source connections
// No code changes needed to add new sources!
```

### 2. Poll All Active Sources

```typescript
import { getPollingEngine } from "@/lib/polling/polling-engine";
import { createTaskFromSourceEntity } from "@/lib/task-creation/create-task-service";
import { findMatchingRules } from "@/lib/task-creation/rule-matcher";

const engine = getPollingEngine();

const results = await engine.pollAllActiveSources(
  async (entity, sourceId) => {
    // Find matching rules for this entity
    const rules = await findMatchingRules(sourceId, entity);
    
    if (rules.length === 0) {
      console.log(`No rules match entity ${entity.id} from source ${sourceId}`);
      return null;
    }

    // Create task for the first matching rule
    const rule = rules[0];
    const dataSource = await prisma.dataSource.findUnique({
      where: { sourceId },
    });

    const result = await createTaskFromSourceEntity(
      sourceId,
      entity,
      rule,
      dataSource!.displayName,
      undefined // storeId
    );

    return result.success ? result.taskId : null;
  }
);

console.log("Polling complete:", results);
```

### 3. Configure a New Data Source

```typescript
// Via API
POST /api/data-sources
{
  "sourceId": "appointments",
  "displayName": "Patient Appointments",
  "tableReference": "public.appointments",
  "primaryKeyField": "id",
  "typeFieldName": "appointmentType",
  "statusFieldName": "appointmentStatus",
  "queryTemplate": "SELECT * FROM appointments WHERE updated_at > $1 ORDER BY created_at DESC",
  "pollingIntervalMinutes": 5,
  "backfillEnabled": true,
  "backfillDays": 7
}
```

### 4. Create Source-Specific Task Rules

A task rule can be scoped to specific sources:

```typescript
// Create a rule
const rule = await prisma.taskRule.create({
  data: {
    name: "New Appointment Consultation",
    orderType: "CONSULTATION",
    taskTypeId: 1,
    titleTemplate: "Appointment: {patientName} with {doctorName}",
    slaMinutes: 120,
    priority: "HIGH",
    triggerType: "TIME",
    triggerCondition: {},
    isActive: true,
  },
});

// Scope it to appointments source
const scope = await prisma.taskRuleSourceScope.create({
  data: {
    taskRuleId: rule.id,
    dataSourceId: appointmentSourceId,
    allowedTypes: ["CONSULTATION", "CHECKUP"],
    allowedStatuses: ["SCHEDULED", "CONFIRMED"],
    assignmentStrategy: "round_robin",
    slaMinutesOverride: 60, // Override SLA for this source
    isActive: true,
    createdById: userId,
  },
});
```

### 5. Sync Task Status Back to Source

When a task status changes:

```typescript
import { syncTaskStatusToSource } from "@/lib/task-creation/create-task-service";

const handler = engine.getHandler(task.source);
if (handler) {
  await syncTaskStatusToSource(task.id, handler);
}
```

## Database Schema

### DataSource
Stores configuration for each data source:
```typescript
{
  id: string;                        // Unique ID
  sourceId: string;                  // "orders", "appointments", "camps"
  displayName: string;               // Human-readable name
  tableReference: string;            // "public.orders" or API endpoint
  primaryKeyField: string;           // ID field name
  typeFieldName: string;             // Type field name
  statusFieldName: string;           // Status field name
  queryTemplate: string;             // SQL with $since placeholder
  metadataFieldMapping: Json;        // Field name mappings
  pollingType: DataSourceType;       // DATABASE | API | WEBHOOK
  pollingIntervalMinutes: number;    // Poll frequency
  isActive: boolean;
  syncStrategy: SourceSyncStrategy;  // NONE | API | DATABASE | WEBHOOK
  syncEndpoint: string;              // For API/webhook sync
  syncCredentials: Json;             // Encrypted credentials
  backfillEnabled: boolean;
  backfillDays: number;
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

### DataSourcePollingLog
Tracks polling metrics:
```typescript
{
  id: string;
  dataSourceId: string;
  pollStartedAt: DateTime;
  pollCompletedAt: DateTime;
  durationMs: number;
  entitiesFound: number;
  entitiesProcessed: number;
  tasksCreated: number;
  tasksFailed: number;
  status: "SUCCESS" | "ERROR" | "PARTIAL";
  errorMessage: string;
  details: Json;
}
```

### TaskRuleSourceScope
Scopes task rules to specific sources:
```typescript
{
  id: string;
  taskRuleId: string;
  dataSourceId: string;
  allowedTypes: Json;                // ["type1", "type2"]
  allowedStatuses: Json;             // ["status1", "status2"]
  assignmentStrategy: string;        // Assignment strategy name
  assignmentStrategyConfig: Json;    // Strategy-specific config
  slaMinutesOverride: number;        // Override SLA for this source
  isActive: boolean;
}
```

### Task (Extensions)
Multi-source fields added to existing Task model:
```typescript
{
  source: string;                    // "orders" | "appointments" | "camps"
  sourceType: string;                // Type from source system
  sourceStatus: string;              // Current status in source
  sourceEntityId: BigInt;            // ID in source system
  sourceLastSyncedAt: DateTime;      // Last sync time
  sourceHandlerContext: Json;        // Source-specific context
}
```

## API Endpoints

### Data Sources Management

**GET /api/data-sources**
List all data sources
```
Response: { dataSources: [...], count: number }
```

**POST /api/data-sources**
Register a new data source
```
Body: RegisterDataSourceRequest
Response: RegisterDataSourceResponse
```

**GET /api/data-sources/{id}**
Get a specific data source
```
Response: DataSource with included ruleScopes
```

**PUT /api/data-sources/{id}**
Update a data source
```
Body: Partial<DataSource>
Response: Updated DataSource
```

**DELETE /api/data-sources/{id}**
Deactivate a data source (soft delete)
```
Response: { success: true, dataSource: ... }
```

**GET /api/data-sources/{id}/polling-status**
Get polling status and history
```
Response: PollingStatus
```

## Adding a New Data Source (SCALABLE)

You **do NOT need to write any code** to add a new source. Just insert a DataSource record:

```sql
INSERT INTO data_sources (
  id, sourceId, displayName, tableReference, primaryKeyField,
  typeFieldName, statusFieldName, queryTemplate,
  metadataFieldMapping, pollingIntervalMinutes, pollingType,
  isActive, createdById, createdAt, updatedAt
) VALUES (
  'camps-source-001',
  'camps',
  'Medical Camps',
  'public.camps',
  'id',
  'campType',
  'campStatus',
  'SELECT * FROM camps WHERE updated_at > $1 ORDER BY created_at DESC LIMIT $2',
  '{"campName": "name", "location": "location", "campDate": "date"}',
  5,
  'DATABASE',
  true,
  1,
  NOW(),
  NOW()
);
```

On next application startup:
1. `initializePollingEngine()` loads this record
2. Creates a `DatabaseSourceHandler` with this config
3. Automatically starts polling
4. **Zero code changes required**

## Creating Custom Handlers (Advanced)

If you need non-database sources (API, webhook, etc.), implement `ISourceHandler`:

```typescript
export class ApiSourceHandler implements ISourceHandler {
  async fetchEntitiesNeedingTasks(since: Date, limit: number): Promise<SourceEntity[]> {
    // Call external API, return entities
  }
  
  async syncTaskStatusToSource(...) { /* sync back to API */ }
  async validateConnection() { /* validate API connectivity */ }
  async getSourceInfo() { /* return API metadata */ }
  async getAvailableMetadata() { /* fetch available types from API */ }
}
```

Register it:
```typescript
const engine = getPollingEngine();
engine.registerHandler("my-api", new ApiSourceHandler());
```

But for **database sources**, the generic `DatabaseSourceHandler` handles everything.

## Error Handling

- Gracefully handles missing tables (returns empty entities)
- Logs detailed errors for debugging
- Continues polling other sources if one fails
- Stores error messages in polling logs
- Marks polls as PARTIAL if some entities fail to create tasks

## Performance Considerations

- Parallel polling of multiple sources
- Batch entity fetching (limit parameter)
- Indexed queries on createdAt, updated_at
- Efficient rule matching with source scoping
- Cursor-based polling to prevent duplicate processing
- Prevents duplicate tasks with uniqueness constraint

## Monitoring & Observability

Track polling metrics via:
1. DataSourcePollingLog table
2. GET /api/data-sources/{id}/polling-status endpoint
3. Logging: Each operation logs start, success/failure, metrics
4. Console output: Detailed logs at each stage

## Future Enhancements

- **Phase 2:** Assign strategies (round-robin per source, geo-based, priority)
- **Phase 3:** Webhook support for real-time event processing
- **Phase 4:** API-based polling with authentication
- **Phase 5:** Advanced filtering and transformation rules
- **Phase 6:** Multi-source task aggregation and consolidation
