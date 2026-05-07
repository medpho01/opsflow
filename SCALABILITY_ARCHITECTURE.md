# Multi-Source Scalability Architecture

## The Problem: Why Hardcoded Handlers Don't Scale

### ❌ WRONG Approach (Doesn't Scale)

Creating a separate handler class for each source:

```
OrdersSourceHandler.ts        ← New code file for Orders
AppointmentsSourceHandler.ts  ← New code file for Appointments  
CampsSourceHandler.ts         ← New code file for Camps
CustomEventSourceHandler.ts   ← New code file for Custom Events
NewSourceHandler.ts           ← New code file for every new source!

Result: 
- N sources = N code files to maintain
- Must deploy code for each new source
- Scales linearly with code changes O(n)
- High maintenance overhead
- Easy to introduce bugs (copy-paste handler code)
- Not production-grade for 100+ sources
```

**Consequences:**
1. Every new source requires a developer
2. Deployment cycle needed for new sources
3. Risk of introducing bugs per source
4. Can't dynamically add sources at runtime
5. Configuration and code are tightly coupled

---

## The Solution: Single Configurable Generic Handler ✅

### ✅ CORRECT Approach (Scales Infinitely)

One handler class that works for ANY table:

```
DatabaseSourceHandler.ts  ← Single reusable handler
↓
Configuration in Database (DataSource table)
↓
No code changes needed to add new sources!

Result:
- 1 handler class = unlimited sources
- Add source by INSERT statement
- Scales O(1) with code complexity
- Low maintenance (single handler to maintain)
- Minimal bug risk (one code path for all sources)
- Production-grade for 100s of sources
```

**Key Design:**

```typescript
// Configuration-driven, not code-driven
const handler = new DatabaseSourceHandler({
  sourceId: "orders",
  displayName: "Lab Orders",
  tableReference: "public.orders",
  primaryKeyField: "id",
  typeFieldName: "orderType",
  statusFieldName: "orderStatus",
  queryTemplate: "SELECT * FROM orders WHERE updated_at > $1 LIMIT $2",
  metadataFieldMapping: {
    patientName: "patient_name",
    labName: "lab_name"
  }
});

// This same handler class works for:
// - Orders (different columns)
// - Appointments (different columns)
// - Camps (different columns)  
// - Any future source (just provide config!)
```

---

## How Initialization Works (Scalable)

### Current Flow (Handles 1 or 100 sources equally)

```typescript
// init-polling-engine.ts
async function initializePollingEngine() {
  // 1. Load ALL data sources from database
  const dataSources = await prisma.dataSource.findMany({
    where: { isActive: true }
  });

  // 2. For EACH source, create a handler with its config
  for (const dataSource of dataSources) {
    const handler = await createDatabaseSourceHandler(dataSource.id);
    engine.registerHandler(dataSource.sourceId, handler);
  }

  // 3. Start polling - all sources use the same logic
  await engine.pollAllActiveSources(taskCreationFn);
}
```

**Why This Scales:**

1. **No hardcoded source names** - reads from database
2. **No handler selection logic** - same handler for all sources
3. **Same polling logic** - DatabaseSourceHandler.fetchEntitiesNeedingTasks() works for all
4. **Configuration is flexible** - different column names, field types, query templates
5. **New sources are automatic** - add DataSource record, restart app, it works

---

## Adding a New Source (Zero Code Changes)

### Scenario: Add "Camps" Source

**Old Way (Hardcoded Handlers):**
1. Create `camps-handler.ts` file
2. Implement CampsSourceHandler class
3. Import in init-polling-engine.ts
4. Register handler manually
5. Deploy new code
6. Restart application

**New Way (Generic Handler):**
1. INSERT DataSource record into database
2. Restart application  
3. ✅ Done - no code changes!

```sql
-- That's literally all you need to do:
INSERT INTO data_sources (
  sourceId, displayName, tableReference, primaryKeyField,
  typeFieldName, statusFieldName, queryTemplate,
  metadataFieldMapping, pollingIntervalMinutes, isActive,
  createdById, createdAt, updatedAt
) VALUES (
  'camps', 'Medical Camps', 'public.camps', 'id',
  'campType', 'campStatus',
  'SELECT * FROM camps WHERE updated_at > $1 LIMIT $2',
  '{"campName": "name", "location": "location"}',
  5, true, 1, NOW(), NOW()
);
```

---

## Configuration vs Code Coupling

### ❌ Tightly Coupled (Hardcoded)
```
Code changes → Deploy → Restart → New source available
⏱️ Time: minutes to hours
🔧 Effort: developer needed
⚠️ Risk: code review, testing, deployment errors
📉 Scalability: breaks at 10+ sources
```

### ✅ Loosely Coupled (Configuration-Driven)
```
Database change → Restart → New source available
⏱️ Time: seconds
🔧 Effort: DBA/ops can do it
⚠️ Risk: minimal (just database config)
📈 Scalability: works for 100+ sources
```

---

## Technical Comparison

| Aspect | Hardcoded Handlers | Generic Configurable Handler |
|--------|-------------------|------------------------------|
| **Adding Source** | Write new handler class | Insert DataSource record |
| **Code Changes** | Yes | No |
| **Deployment** | Required | Not required |
| **Time to Add Source** | 30+ minutes (dev cycle) | 2 minutes (config) |
| **Scalability** | O(n) handlers = O(n) complexity | O(1) handler = constant complexity |
| **Maintenance** | N handler files to maintain | 1 handler file to maintain |
| **Bug Risk** | High (N code paths) | Low (1 code path) |
| **Configuration** | Scattered in code | Centralized in database |
| **Runtime Addition** | Not possible | Possible (with restart) |
| **Production Scale** | 5-10 sources max | 100+ sources easily |

---

## The Generic Handler Design

```typescript
class DatabaseSourceHandler implements ISourceHandler {
  config: DatabaseSourceConfig; // All config from database
  
  // Works for ANY table:
  async fetchEntitiesNeedingTasks() {
    // 1. Read config (table name, field names, query template)
    // 2. Execute dynamic SQL query
    // 3. Map fields using metadataFieldMapping
    // 4. Return SourceEntity[] with correct structure
  }
  
  // Same code path for all sources
  // Behavior changes based on config, not code
}
```

**Key Insight:** The handler doesn't change - only the configuration changes!

---

## Configuration-Driven Behavior

```typescript
// Orders source
config = {
  tableReference: "public.orders",
  typeFieldName: "orderType",
  statusFieldName: "orderStatus",
  metadataFieldMapping: { patientName: "patient_name" }
}
handler = new DatabaseSourceHandler(config);
// Queries: SELECT * FROM orders WHERE updated_at > ?

// Appointments source (SAME HANDLER CLASS)
config = {
  tableReference: "public.appointments",
  typeFieldName: "appointmentType",
  statusFieldName: "appointmentStatus",
  metadataFieldMapping: { doctorName: "doctor_name" }
}
handler = new DatabaseSourceHandler(config);
// Queries: SELECT * FROM appointments WHERE updated_at > ?

// Camps source (SAME HANDLER CLASS)
config = {
  tableReference: "public.camps",
  typeFieldName: "campType",
  statusFieldName: "campStatus",
  metadataFieldMapping: { campName: "camp_name" }
}
handler = new DatabaseSourceHandler(config);
// Queries: SELECT * FROM camps WHERE updated_at > ?

// All use the SAME handler class
// All use the SAME logic
// Different behavior from different configurations
```

---

## Startup Sequence (Scalable)

```
Application Starts
  ↓
initializePollingEngine() called
  ↓
Load ALL DataSource records (1, 3, 10, 100 - doesn't matter)
  ↓
For each DataSource:
  - Create DatabaseSourceHandler(config)
  - Register with PollingEngine
  - Configure polling interval
  ↓
Poll all sources (same logic for all)
  ↓
Return results
```

**Linear time O(n)** but **zero code complexity** regardless of n

---

## Production Deployment Example

### Day 1: Launch with Orders
```sql
INSERT INTO data_sources VALUES ('orders-src', 'orders', 'Lab Orders', ...);
```
App starts, polls Orders table ✅

### Day 5: Add Appointments
```sql
INSERT INTO data_sources VALUES ('appt-src', 'appointments', 'Appointments', ...);
```
Restart app, now polls Orders + Appointments ✅
**No code changed. No deployment. No review. No testing.**

### Day 10: Add Camps
```sql
INSERT INTO data_sources VALUES ('camps-src', 'camps', 'Medical Camps', ...);
```
Restart app, now polls Orders + Appointments + Camps ✅
**Still no code changes.**

### Month 2: Add 47 more sources for partner clinics
```sql
INSERT INTO data_sources VALUES ('clinic1-src', 'clinic1_orders', ...), 
                                  ('clinic2-src', 'clinic2_orders', ...),
                                  ...
```
**Add as many as needed - same handler works for all!**

---

## Summary

| Aspect | Hardcoded | Generic |
|--------|-----------|---------|
| **Scalability** | ❌ Breaks at 10+ sources | ✅ Works for 100+ sources |
| **Code Coupling** | ❌ Config mixed with code | ✅ Config centralized in DB |
| **Adding Sources** | ❌ Requires deployment | ✅ Just DB insert + restart |
| **Maintenance** | ❌ Multiple handler files | ✅ Single handler file |
| **Production Grade** | ❌ Not really | ✅ Yes, enterprise-ready |
| **Team Efficiency** | ❌ Developers needed for each source | ✅ Non-devs can add sources |

**Recommendation:** Always use **generic, configurable handlers** for scaling systems. Configuration drives behavior, not code.
