# Multi-Source Task System - Phases 2, 3, 4 Implementation Roadmap

## Phase 2: Assignment & Distribution (CRITICAL - May 8-9)

### Overview
Enable automatic task assignment to agents with multiple strategies, roster validation, and skill-based routing.

### Deliverables

#### 2.1 Assignment Strategies Engine
**File**: `/src/lib/task-creation/assignment-strategies.ts`
- Interface: `IAssignmentStrategy`
- Implementations:
  - `RoundRobinStrategy` - Distribute evenly
  - `StoreAffinity` - Route to assigned stores
  - `SkillBased` - Match required skills
  - `LeastLoaded` - Assign to agents with capacity
  - `GeoBased` - Route by location

#### 2.2 Roster Validation Service
**File**: `/src/lib/task-creation/roster-validator.ts`
- Check agent availability for specific date
- Validate agent status (ACTIVE vs OFF/LEAVE/SICK)
- Get working hours and break times
- Prevent assignment to unavailable agents

#### 2.3 Assignment Service
**File**: `/src/lib/task-creation/assignment-service.ts`
- Execute assignment strategy
- Validate roster before assignment
- Update task with agent + assignment metadata
- Log assignment decision

#### 2.4 Assignment Validation API
**Route**: `POST /api/tasks/validate-assignment`
- Test assignment before task creation
- Show which agents would be assigned
- Return assignment rationale

#### 2.5 Task Creation Update
**Modify**: `/src/lib/task-creation/create-task-service.ts`
- Integrate assignment service
- Set assignedToId before task creation
- Store assignment strategy metadata

### Implementation Steps
1. Create assignment strategies interface
2. Implement each strategy
3. Create roster validator
4. Create assignment service
5. Update task creation to use assignment
6. Create validation API endpoint
7. Add tests for each strategy
8. Update documentation

### Success Criteria
- ✅ Tasks automatically assigned on creation
- ✅ Multiple strategies working (round-robin verified)
- ✅ Roster validation prevents unavailable agent assignment
- ✅ Assignment logged and queryable
- ✅ API validates assignments before creation

---

## Phase 3: Webhook & Real-time (May 10-11)

### Overview
Support webhook-based real-time event ingestion and status sync-back to sources.

### Deliverables

#### 3.1 Webhook Handler
**File**: `/src/lib/polling/handlers/webhook-handler.ts`
- Implement `ISourceHandler` for webhook sources
- Parse incoming webhook payloads
- Validate webhook signatures
- Queue events for processing

#### 3.2 Webhook API Endpoint
**Route**: `POST /api/webhooks/{sourceId}`
- Receive webhook events
- Validate source configuration
- Transform payload to SourceEntity
- Trigger task creation immediately (not polling)

#### 3.3 Real-time Task Creation
**File**: `/src/lib/task-creation/real-time-task-creator.ts`
- Process webhook entities immediately
- Same rule matching as polling
- Same assignment logic
- Log real-time events separately

#### 3.4 Status Sync-back to Source
**File**: `/src/lib/polling/sync-service.ts`
- Watch for task status changes
- Call source handler's syncTaskStatusToSource()
- Support API, webhook, and database sync strategies
- Retry logic for failures

#### 3.5 Webhook Management API
**Routes**:
- `POST /api/data-sources/{id}/webhook-config` - Configure webhook
- `GET /api/data-sources/{id}/webhook-events` - View recent webhook events
- `POST /api/data-sources/{id}/test-webhook` - Send test webhook

### Implementation Steps
1. Create webhook handler
2. Create webhook API endpoint
3. Create real-time task creator
4. Create sync-back service
5. Hook into task status changes
6. Create webhook management endpoints
7. Add webhook signature validation
8. Add retry logic for failed syncs

### Success Criteria
- ✅ Webhook events create tasks immediately
- ✅ Task status synced back to source
- ✅ Webhook signature validation working
- ✅ Failed syncs retry with backoff
- ✅ Webhook event history queryable

---

## Phase 4: Advanced Features (May 12+)

### Overview
Enable complex scenarios like multi-rule tasks, task aggregation, and advanced filtering.

### Deliverables

#### 4.1 Multi-Rule Task Creation
**Modify**: `/src/lib/task-creation/create-task-service.ts`
- Support creating multiple tasks per entity
- Each matching rule gets its own task
- Prevent duplicate task creation
- Link related tasks together

#### 4.2 Task Aggregation
**File**: `/src/lib/task-creation/task-aggregator.ts`
- Combine similar tasks (multiple patients same doctor)
- Reduce task volume for bulk operations
- Configurable aggregation rules
- Maintain traceability to source entities

#### 4.3 Advanced Filtering Engine
**File**: `/src/lib/polling/filters.ts`
- Custom entity filters per source
- Support complex conditions (AND/OR/NOT)
- Filter expressions: `status = SCHEDULED AND appointmentTime > NOW`
- Pre-filter before rule matching

#### 4.4 Data Transformation Rules
**File**: `/src/lib/polling/transformers.ts`
- Field mapping and computation
- Support expressions: `slaMinutes = CASE WHEN type = 'URGENT' THEN 30 ELSE 120`
- Type coercion and validation
- Metadata enrichment

#### 4.5 Batch Operations API
**Routes**:
- `POST /api/tasks/bulk-action` - Update multiple tasks
- `POST /api/data-sources/{id}/backfill` - Reprocess historical entities
- `GET /api/tasks/aggregate` - Get aggregated task statistics

#### 4.6 Advanced Analytics
**File**: `/src/lib/analytics/polling-analytics.ts`
- Source performance metrics
- Assignment strategy effectiveness
- SLA compliance by source
- Entity processing latency

### Implementation Steps
1. Add multi-rule logic
2. Create task aggregator
3. Create filtering engine
4. Create transformation engine
5. Create bulk operations API
6. Create analytics queries
7. Add configuration UI hooks
8. Add comprehensive tests

### Success Criteria
- ✅ Multiple tasks created per entity (when rules allow)
- ✅ Task aggregation reduces volume
- ✅ Advanced filters working
- ✅ Transformations applied correctly
- ✅ Analytics showing system health

---

## Cross-Phase Integration Points

### Database Changes
- Phase 2: Add `assignedStrategy` tracking to Task
- Phase 3: Add webhook event logs, sync status
- Phase 4: Add aggregation metadata, analytics

### API Security
- All endpoints require OPS_HEAD or appropriate role
- Webhook endpoints require signature validation
- Rate limiting on webhook ingestion

### Error Handling
- Phase 2: Assignment failure → fallback strategy
- Phase 3: Webhook failure → queue for retry
- Phase 4: Transformation failure → use original data

### Monitoring & Logging
- Phase 2: Log assignment decisions
- Phase 3: Log webhook events and syncs
- Phase 4: Log aggregation and filtering decisions

---

## Implementation Order (Recommended)

### Week 1 (May 8-9): Phase 2 - CRITICAL
1. Assignment Strategies (2 hours)
2. Roster Validator (1 hour)
3. Assignment Service (2 hours)
4. Update Task Creation (1 hour)
5. Assignment API (1 hour)
6. Tests (1 hour)

### Week 2 (May 10-11): Phase 3 - HIGH PRIORITY
1. Webhook Handler (1.5 hours)
2. Webhook Endpoint (1.5 hours)
3. Real-time Task Creator (1 hour)
4. Sync Service (2 hours)
5. Webhook Management API (1 hour)
6. Tests (1 hour)

### Week 3 (May 12+): Phase 4 - NICE TO HAVE
1. Multi-rule Logic (1.5 hours)
2. Task Aggregator (1.5 hours)
3. Filtering Engine (1 hour)
4. Transformers (1 hour)
5. Bulk Operations (1.5 hours)
6. Analytics (1 hour)
7. Tests (1.5 hours)

---

## Team Handoff Plan

### Phase 2 (Assignment)
- Critical for agents to receive tasks
- Depends on: Phase 1 (task creation)
- Impacts: Agent workload, SLA compliance
- Owner: Backend team (assignment logic)

### Phase 3 (Webhooks)
- Real-time capability for partners
- Depends on: Phase 2 (assignment works)
- Impacts: Real-time sync with external systems
- Owner: Integration team (webhook handling)

### Phase 4 (Advanced)
- Optimizations and analytics
- Depends on: Phase 2 + 3 (core working)
- Impacts: System efficiency and insights
- Owner: Data/analytics team

---

## Risk Mitigation

### Phase 2 Risks
- Assignment strategy fails → Fallback to round-robin
- Roster not available → Assign anyway (log warning)
- Agent capacity exceeded → Queue task for later

### Phase 3 Risks
- Webhook arrives before source created → Queue until source ready
- Sync-back fails → Store failed sync in database, retry
- Duplicate webhooks → Deduplication by event ID

### Phase 4 Risks
- Aggregation loses source traceability → Maintain linkage
- Filters exclude valid entities → Provide filter test endpoint
- Analytics slow on large datasets → Implement caching

---

## Success Metrics by Phase

### Phase 2
- 95%+ of tasks assigned automatically
- Average assignment time < 1 second
- 0 assignment errors in production
- Agent capacity never exceeded (queued properly)

### Phase 3
- < 1 second latency from webhook to task creation
- 99%+ webhook event success rate
- 100% of task status synced back to source
- Zero data loss on failed syncs

### Phase 4
- 50%+ reduction in task volume via aggregation
- Advanced filters eliminate 20%+ irrelevant tasks
- Analytics dashboards < 1 second load time
- Bulk operations process 1000+ tasks/minute

---

## Total Implementation Time

- **Phase 2**: ~9 hours (1 day focused work)
- **Phase 3**: ~8 hours (1 day focused work)  
- **Phase 4**: ~12 hours (1.5 days for nice-to-have features)
- **Total**: ~29 hours (~3-4 days of focused work)

Plus:
- Code review: 2-3 hours per phase
- Testing: 1-2 hours per phase
- Documentation: 1 hour per phase
- Deployment & monitoring: 1 hour per phase

**Total with QA/review**: ~40-45 hours (~5-6 days)

---

## Deliverables Summary

By end of Phase 4:
- ✅ Multi-source task creation (Phase 1)
- ✅ Automatic agent assignment (Phase 2)
- ✅ Real-time webhook support (Phase 3)
- ✅ Advanced filtering & aggregation (Phase 4)
- ✅ Full observability and analytics
- ✅ Enterprise-grade scalability
- ✅ Zero-downtime new source addition
- ✅ Real-time sync with all sources

**Result**: Production-ready multi-source task management system supporting unlimited sources, real-time events, and intelligent distribution.
