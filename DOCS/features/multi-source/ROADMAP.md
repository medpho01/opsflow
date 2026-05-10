# Multi-Source Task System - Implementation Roadmap

## Overview

This roadmap outlines the path to transform TaskOS from a single-source (Orders) task system to a flexible multi-source platform that can pull tasks from any table (Orders, Appointments, Camps, Pharma Orders, Requests, etc.).

**Documents**:
- `PRODUCT_SPEC.md` - What we're building (features, workflows, user experience)
- `TECHNICAL_SPEC.md` - How we're building it (architecture, APIs, database schema)

---

## Key Design Principles

### 1. **Source Abstraction**
Every data source (Orders, Appointments, etc.) implements the same `ISourceHandler` interface. This allows us to:
- Add new sources without modifying core polling logic
- Reuse rule matching, task creation, and assignment logic
- Keep source-specific logic isolated in handlers

### 2. **Rule Scoping**
Task Rules are now scoped to source + type + status combinations:
- Same rule name can exist for different sources with different behaviors
- Rules can be source-specific or source-agnostic
- Assignment strategies can vary per source

### 3. **Unified Task Model**
All tasks (regardless of source) use the same Task model with:
- `source` field (identifies source: "orders", "appointments", "camps")
- `source_type` field (specific type within that source)
- `source_status` field (current status in source system)
- `metadata` field (source-specific context)

### 4. **Backward Compatibility**
- Existing Orders-based tasks continue to work
- No breaking changes to existing APIs
- Migration is gradual (legacy + new side-by-side)

---

## Architecture Layers

```
┌─────────────────────────────────────┐
│  PRESENTATION LAYER                 │
│  (All Tasks Board - unified view)   │
└─────────────────────────────────────┘
            ↓
┌─────────────────────────────────────┐
│  API LAYER                          │
│  - /api/tasks (multi-source)        │
│  - /api/data-sources (management)   │
│  - /api/task-rules (scoped)         │
└─────────────────────────────────────┘
            ↓
┌─────────────────────────────────────┐
│  BUSINESS LOGIC LAYER               │
│  - Polling Engine                   │
│  - Rule Matching (source-aware)     │
│  - Task Creation                    │
│  - Task Sync                        │
└─────────────────────────────────────┘
            ↓
┌─────────────────────────────────────┐
│  SOURCE HANDLERS (Plugin Layer)     │
│  - Orders Handler                   │
│  - Appointments Handler             │
│  - Camps Handler                    │
│  - Extensible for future sources    │
└─────────────────────────────────────┘
            ↓
┌─────────────────────────────────────┐
│  DATA LAYER                         │
│  - Orders Table                     │
│  - Appointments Table               │
│  - Camps Table                      │
│  - Task Management Tables           │
└─────────────────────────────────────┘
```

---

## Implementation Phases

### **Phase 1: Foundation (Weeks 1-2)**
Build the core multi-source infrastructure without breaking existing functionality.

**Database**:
- Create `DataSource` table (register sources)
- Create `DataSourcePollingLog` table (observability)
- Create `TaskRuleSourceScope` table (rule scoping)
- Extend `Task` table with source fields

**Code**:
- Implement `ISourceHandler` interface
- Create `OrdersSourceHandler` (existing Orders logic)
- Create `PollingEngine` (orchestrates all sources)
- Extend `TaskRule` model with source scoping
- Update rule matching logic (source-aware)

**APIs**:
- POST `/api/data-sources` (register new source)
- GET `/api/data-sources` (list sources)
- GET `/api/data-sources/{id}/polling-status`

**Testing**:
- Unit tests for source handlers
- Unit tests for rule matching
- Integration tests for polling cycle

**Timeline**: 2 weeks

---

### **Phase 2: Integration (Week 3)**
Integrate multi-source polling into existing task system.

**Code**:
- Implement `AppointmentsSourceHandler`
- Connect polling engine to cron scheduler
- Update task creation logic for multi-source
- Implement task sync-back logic
- Extend assignment engine (source-aware)

**APIs**:
- Enhance GET `/api/tasks` with `source` filtering
- Enhance PATCH `/api/tasks/{id}` with sync-back
- POST `/api/task-rules` with source scopes

**UI**:
- Add "Data Sources" management page
- Add source field to All Tasks board
- Add source filtering to task list
- Add source indicators to task detail

**Testing**:
- Integration tests with multiple sources
- Task creation from multiple sources
- Rule matching across sources
- Sync-back verification

**Timeline**: 1 week

---

### **Phase 3: Sync & Observability (Week 4)**
Complete source integration with proper error handling and visibility.

**Code**:
- Implement source-specific sync handlers
- Complete error handling for polling failures
- Implement retry logic for failed tasks
- Create polling status dashboard

**APIs**:
- GET `/api/polling-status` (system-wide view)
- POST `/api/data-sources/{id}/manual-poll`

**UI**:
- Polling Status Dashboard (per-source health)
- Polling logs and error details
- Manual polling trigger button

**Testing**:
- Error scenarios (source unavailable)
- Retry logic verification
- Sync-back error handling
- Multi-source task assignment

**Timeline**: 1 week

---

### **Phase 4: Expansion (Weeks 5-6)**
Add Camps source and prepare for additional sources.

**Code**:
- Implement `CampsSourceHandler`
- Verify extensibility with new source
- Create source template for future additions

**Ops**:
- Register Camps as data source
- Configure Camps-specific task rules
- Set up Camps → Task sync-back

**UI**:
- UI for registering new sources (self-service)
- Source-specific metadata configuration

**Testing**:
- Full cycle with Camps as source
- Cross-source task management
- Data consistency verification

**Timeline**: 2 weeks (can overlap with Phase 3)

---

## Database Changes

### New Tables
```sql
-- Data source configuration
CREATE TABLE data_source (...)

-- Polling observability
CREATE TABLE data_source_polling_log (...)

-- Rule scoping per source
CREATE TABLE task_rule_source_scope (...)
```

### Modified Tables
```sql
-- Extend task table with source fields
ALTER TABLE task ADD COLUMN (
  source VARCHAR(50),
  source_type VARCHAR(100),
  source_status VARCHAR(100),
  source_entity_id BIGINT,
  ...
)
```

---

## API Changes

### New Endpoints
```
POST   /api/data-sources
GET    /api/data-sources
GET    /api/data-sources/{id}/polling-status
GET    /api/polling-status
POST   /api/data-sources/{id}/manual-poll
```

### Enhanced Endpoints
```
GET    /api/tasks?source=orders&sourceType=BLOOD_TEST
GET    /api/tasks/{id}  (returns source fields)
PATCH  /api/tasks/{id}  (syncs back to source)
POST   /api/task-rules (with source scopes)
GET    /api/task-rules (filtered by source)
```

---

## Migration Strategy

### Step 1: Deploy New Infrastructure
- Add new tables
- Extend Task model
- Deploy source handlers (Orders first)

### Step 2: Backfill Existing Data
- Populate `DataSource` table
- Create task rule source scopes for Orders
- Migrate existing rules to new structure

### Step 3: Dual Mode Operation
- New polling uses multi-source engine
- Old polling continues for Orders (fallback)
- Monitor for discrepancies

### Step 4: Cutover
- Retire old polling
- Verify all tasks created through new system
- Deploy Phase 2 changes

### Step 5: Add New Sources
- Register Appointments source
- Create Appointments task rules
- Add to task board UI

---

## Success Metrics

| Metric | Target | Phase |
|--------|--------|-------|
| Support multiple data sources | 2+ sources | Phase 2 |
| Task creation latency | <5s per entity | Phase 2 |
| Polling success rate | >99% | Phase 3 |
| UI responsiveness (All Tasks) | <500ms | Phase 2 |
| Task sync-back success | >98% | Phase 3 |
| Backward compatibility | 100% (no breaking changes) | Phase 1 |

---

## Risk Mitigation

### Risk: Breaking Existing Functionality
**Mitigation**: 
- Extensive backward compatibility testing
- Gradual rollout (Orders only in Phase 1-2)
- Dual-mode operation during cutover
- Rollback plan (revert to old polling if issues)

### Risk: Polling Performance Degradation
**Mitigation**:
- Benchmark polling cycle before/after
- Optimize rule matching queries
- Implement source-level rate limiting
- Monitor polling duration per source

### Risk: Data Inconsistency Between Sources
**Mitigation**:
- Implement source-specific sync handlers
- Validate sync-back responses
- Create audit trail for all syncs
- Monthly data consistency checks

### Risk: New Source Configuration Errors
**Mitigation**:
- Source validation at registration time
- Test query before saving
- Query dry-run preview
- Admin approval workflow

---

## Key Files to Create/Modify

### New Files
```
src/lib/polling/
  ├── polling-engine.ts
  ├── handlers/
  │   ├── types.ts
  │   ├── orders-handler.ts
  │   ├── appointments-handler.ts
  │   └── camps-handler.ts
  └── scheduling/
      └── cron-jobs.ts

src/lib/sync/
  ├── task-sync.ts
  └── sync-handlers/

src/app/api/data-sources/
  ├── route.ts
  ├── [id]/
  │   └── polling-status/route.ts
  └── validate/route.ts

src/components/
  └── DataSourcesManager.tsx
  └── PollingStatusDashboard.tsx

DOCS/features/multi-source/
  ├── PRODUCT_SPEC.md
  ├── TECHNICAL_SPEC.md
  └── IMPLEMENTATION_ROADMAP.md
```

### Modified Files
```
prisma/schema.prisma (add new models)
src/app/api/tasks/route.ts (multi-source filtering)
src/app/api/task-rules/route.ts (source scoping)
src/components/head/AllTasksBoard.tsx (source column)
```

---

## Decision Points Requiring User Input

### Q1: Should source registration be manual or auto-discoverable?
**Option A** (Recommended): Manual registration by admin
- Full control over which sources to poll
- Configuration required (prevents surprises)

**Option B**: Auto-discovery of available tables
- Faster onboarding for new sources
- Risk of polling unwanted tables

### Q2: How should we handle conflicting rules across sources?
**Option A** (Recommended): Rule inheritance model
- Rule can apply to multiple sources with source-specific overrides
- Reduces duplication

**Option B**: Completely independent rules per source
- More flexibility
- More configuration required

### Q3: Should task assignment be uniform or source-specific?
**Option A** (Recommended): Source-aware assignment
- Different sources have different assignment strategies
- Orders → route_by_store, Appointments → round_robin

**Option B**: Uniform assignment across sources
- Simpler implementation
- Less flexible

---

## Next Steps

1. **Review** this roadmap and technical specifications
2. **Decide** on the design questions above
3. **Prioritize** which sources to support (Orders, Appointments, Camps?)
4. **Schedule** kickoff for Phase 1
5. **Allocate** engineering resources

---

## Questions?

For clarification on specific components, refer to:
- **Features & Workflows** → `PRODUCT_SPEC.md`
- **Architecture & Implementation** → `TECHNICAL_SPEC.md`
- **Timeline & Phases** → This document

