# Multi-Source Task Creation System
## Product Specification

---

## 1. Executive Summary

**Problem**: The current task system is tightly coupled to a single data source (Orders table). As the platform grows, we need to support task creation from multiple sources (Appointments, Camps, Pharma Orders, Requests, etc.), each with their own metadata structures, status definitions, and operational procedures.

**Vision**: A flexible, scalable task creation system that:
- Supports any entity/order-like table as a data source
- Allows independent metadata definitions per source
- Enables source-specific SOPs via scoped Task Rules
- Maintains a unified task management experience across all sources
- Provides observability and debugging for multi-source polling

**Scope**: This document covers the product design for v1 of multi-source support, focusing on Orders, Appointments, and Camps as initial sources.

---

## 2. Current State Analysis

### 2.1 Today's Architecture
```
Orders Table → Polling Engine → Task Creation → Unified Task Board
                    ↓
            Task Rules (OrderType + Status combinations)
```

**Limitations**:
- Hard-coded for Orders table
- Assumes all entities have `orderType` and `orderStatus` fields
- Task context stored in `metadata` blob without structure
- Difficult to reference back to source entity
- No multi-source task assignment rules

---

## 3. Product Requirements

### 3.1 Data Source Management

**Requirement**: System administrators can register new entity sources

**Who**: OPS_HEAD with System Admin role
**What**: Configure which tables to poll and how to identify entities needing tasks

**Configuration per source includes**:
- Source ID (e.g., "orders", "appointments", "camps")
- Display name (e.g., "Lab Orders", "Patient Appointments")
- Table name and database reference
- Primary key field
- Query to fetch entities needing tasks
- Available type/status fields (with allowed values)
- Metadata mapping (which fields to store in task context)
- Historical data handling (backfill date range)

**UI Location**: Settings → Data Sources (new section)

### 3.2 Source-Scoped Task Rules

**Requirement**: Define task creation rules per source + type + status combination

**Current workflow**:
```
Order arrives with type="BLOOD_TEST" and status="CREATED"
→ Find matching rule (type=BLOOD_TEST, status=CREATED)
→ Create task with SOP steps, assignee logic, SLA
```

**New workflow**:
```
Order arrives with source="orders", type="BLOOD_TEST", status="CREATED"
Appointment arrives with source="appointments", type="CONSULTATION", status="PENDING"

For each entity:
  → Find rules matching (source, type, status)
  → Create task with source-specific SOP, assignment logic, SLA
```

**Rule creation UI**:
- Filter by Data Source (dropdown)
- Show available types for selected source (dropdown/multi-select)
- Show available statuses for selected source (dropdown/multi-select)
- Define SOP and assignment rules

**Example rules**:
| Source | Type | Status | SOP | Assignee Rule | SLA |
|--------|------|--------|-----|---------------|-----|
| orders | BLOOD_TEST | CREATED | [steps...] | route_by_store | 2h |
| orders | BLOOD_TEST | SCHEDULED | [steps...] | route_by_store | 24h |
| appointments | CONSULTATION | PENDING | [steps...] | round_robin | 4h |
| camps | VACCINATION | REGISTERED | [steps...] | geo_based | 6h |

### 3.3 Unified Task Interface

**Requirement**: Agents see all tasks (regardless of source) in a unified interface

**Current task view**: All Tasks → table with Order # column
**New task view**: All Tasks → table with Entity # and Source columns

**Task payload changes**:
```javascript
// Before
{
  entityId: 2000005,
  entityType: "ORDER",
  metadata: { orderStatus: "CREATED", orderType: "BLOOD_TEST", ... }
}

// After
{
  entityId: 2000005,
  entityType: "ORDER",
  source: "orders",
  sourceType: "BLOOD_TEST",
  sourceStatus: "CREATED",
  metadata: { ... }  // source-specific fields
}
```

### 3.4 Task Assignment Rules (Source-Aware)

**Requirement**: Assignment rules can be tailored per source

**Examples**:
- Orders → Route by store assignment
- Appointments → Round-robin by availability
- Camps → Geo-based assignment
- Requests → Priority-based assignment

**Implementation**: Assignment rules are already parameterized; need to extend to be source-aware

### 3.5 Task Status Sync

**Requirement**: Task completion/status changes sync back to source entity

**Current flow**:
```
Agent marks task as COMPLETED
→ Task status updated
→ Order status updated (optional external API call)
```

**New flow**:
```
Agent marks task as COMPLETED
→ Task status updated
→ For source-specific logic:
   if source="orders" → call Orders API to update status
   if source="appointments" → call Appointments API
   if source="camps" → call Camps API
```

**Implementation**: Source handler plugins that define sync logic

### 3.6 Observability & Debugging

**Requirement**: OPS_HEAD can view polling status per source

**What to track**:
- Last poll time per source
- Entities found vs. tasks created
- Failed polls (errors, exceptions)
- Polling latency
- Entity-to-task mapping audit trail

**UI**: Dashboard → Data Source Polling Status
- Table showing each source's polling health
- Link to detailed logs per source
- Manual trigger for re-polling a source

---

## 4. User Workflows

### 4.1 Workflow: Configure New Data Source

**Actor**: System Admin / OPS_HEAD
**Goal**: Enable task creation from Appointments table

**Steps**:
1. Go to Settings → Data Sources
2. Click "Add New Source"
3. Fill form:
   - Name: "Patient Appointments"
   - Source ID: "appointments"
   - Query: Custom SQL to fetch appointments needing task review
   - Type field: "appointmentType" (dropdown)
   - Status field: "appointmentStatus" (dropdown)
   - Metadata fields: [appointmentTime, patientName, labName, ...]
4. Save
5. System validates connection and runs initial poll
6. Displays results: "Found 47 appointments needing tasks"
7. Created 47 tasks from existing appointments (backfill)

### 4.2 Workflow: Create Task Rule for New Source

**Actor**: OPS_HEAD
**Goal**: Define how to handle CONSULTATION appointments

**Steps**:
1. Go to Task Rules
2. Click "New Rule"
3. Select source: "Patient Appointments"
4. Select types: "CONSULTATION"
5. Select statuses: "PENDING", "SCHEDULED"
6. Define SOP: Add checklist steps specific to consultations
7. Define assignment: Round-robin among consultation specialists
8. Set SLA: 4 hours
9. Save
10. System applies rule to future and matching historical appointments

### 4.3 Workflow: Assign Task from Multiple Sources

**Actor**: OPS_HEAD (task assignment)
**Goal**: Assign tasks from Orders and Appointments to available agents

**Current flow**:
- View All Tasks
- See 10 BLOOD_TEST tasks (from Orders)
- Assign to agent

**New flow**:
- View All Tasks
- See mixed: 5 BLOOD_TEST tasks (Orders), 3 CONSULTATION tasks (Appointments), 2 VACCINATION tasks (Camps)
- Filter by source if needed
- Assign to agents (assignment rules are source-aware)

---

## 5. Data Model Extensions

### 5.1 New Database Tables

#### `DataSource`
```
id: UUID
sourceId: string (unique, e.g., "orders", "appointments")
displayName: string
databaseSchema: JSON {
  tableReference: string,
  primaryKeyField: string,
  typeField: string,
  statusField: string,
  availableTypes: string[],
  availableStatuses: string[],
  metadataFields: string[]
}
queryToFetchEntities: string (SQL template)
isActive: boolean
createdAt: timestamp
updatedAt: timestamp
createdBy: userId
```

#### `DataSourcePollingLog`
```
id: UUID
sourceId: UUID → DataSource
pollStartedAt: timestamp
pollCompletedAt: timestamp
entitiesFound: integer
tasksCreated: integer
status: "SUCCESS" | "ERROR" | "PARTIAL"
errorMessage: string (if status=ERROR)
details: JSON {
  entitiesByType: { BLOOD_TEST: 5, ... },
  newTasks: [{ entityId, taskId }, ...],
  failedEntities: [{ entityId, reason }, ...]
}
```

#### `TaskRuleSourceScope` (extends current TaskRule)
```
id: UUID
taskRuleId: UUID → TaskRule
sourceId: UUID → DataSource (nullable, null = all sources)
allowedTypes: string[] (e.g., ["BLOOD_TEST", "CONSULTATION"])
allowedStatuses: string[] (e.g., ["CREATED", "PENDING"])
assignmentStrategy: string (e.g., "route_by_store", "round_robin")
slaMinutes: integer
```

### 5.2 Task Model Extensions

```javascript
// Add fields to existing Task model
{
  ...existing fields...,
  source: string,           // "orders", "appointments", "camps"
  sourceType: string,       // "BLOOD_TEST", "CONSULTATION", etc.
  sourceStatus: string,     // "CREATED", "PENDING", etc.
  sourceEntityId: number,   // References back to Orders.id, Appointments.id, etc.
}
```

---

## 6. Integration Points

### 6.1 External System Updates
When a task completes, notify source systems:
- **Orders** → Call Orders API `/update-order-status`
- **Appointments** → Call Appointments API `/update-appointment-status`
- **Camps** → Update Camps table directly

### 6.2 Entity Enrichment
When displaying task details, fetch source-specific context:
- For Orders: Patient name, lab, phlebo info
- For Appointments: Patient info, doctor availability
- For Camps: Location, team composition

### 6.3 Audit Trail
Log all task creations per source for compliance and debugging

---

## 7. Phased Rollout

### Phase 1: Foundation (v1.0)
- ✅ Data Source registration (Orders only, not editable)
- ✅ Task Rule scoping to sources
- ✅ Unified task board showing source field
- ✅ Polling status dashboard
- ✅ Basic multi-source support (Orders + 1 new source)

### Phase 2: Expansion (v1.1)
- Appointments and Camps support
- Advanced filtering by source
- Source-specific assignment strategies
- Reporting per source

### Phase 3: Intelligence (v1.2)
- ML-based source recommendations
- Predictive SLA per source
- Auto-scaling polling frequency
- Cross-source task dependency tracking

---

## 8. Success Metrics

- **Adoption**: % of new task creation from non-Orders sources
- **Latency**: P95 task creation latency per source
- **Reliability**: % polling success rate per source
- **Scalability**: Support for N sources without performance degradation
- **User Experience**: Agents can filter/assign multi-source tasks efficiently

---

## 9. FAQ & Design Decisions

### Q: Why not unified schema across sources?
**A**: Different sources have different metadata structures and business rules. Forcing a unified schema would require data transformation and lose domain-specific context.

### Q: How do we handle source-specific SOP fields?
**A**: Task checklist steps are flexible text/structured data. Source handlers can render source-specific UI components for task context.

### Q: Can a task be created from multiple sources?
**A**: No. A task is created from exactly one entity (one source). Future: consider linked tasks for dependent cross-source workflows.

### Q: What if a source goes down?
**A**: Polling fails gracefully, logged in polling status. Admin is notified. Failed entities are retried in next cycle.

### Q: How do we backfill historical entities?
**A**: At source registration time, run initial poll with configurable date range. Admin sees results and can trigger backfill.

