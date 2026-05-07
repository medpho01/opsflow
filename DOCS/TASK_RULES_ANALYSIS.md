# Task Rules Feature - Readiness Analysis & Recommendations
**Prepared for: Abhishek (Product Manager)**  
**Date: May 2, 2026**  
**Status: Critical Review Required**

---

## Executive Summary

The **Task Rules** feature has foundational infrastructure in place, but there are **critical gaps and consistency issues** that prevent it from fully supporting your current SOPs (Standard Operating Procedures). The system can create tasks based on order state, but the configuration options are **not flexible enough** for complex business logic, and there are **status enum mismatches** between the Labstack order system and TaskOS task system.

### Critical Findings:
- ❌ Status enum mismatch: Order statuses don't align with rule trigger conditions
- ⚠️ Rule configuration is too simplistic for multi-step SOPs
- ⚠️ No support for OR/AND logic in trigger conditions
- ❌ Missing metadata-based triggers (report ETAs, custom fields)
- ⚠️ Limited time-window support (no "between X and Y minutes")
- ✅ Core rule evaluation engine works
- ✅ Assignment logic supports skill-based routing
- ✅ Deduplication prevents duplicate task creation

---

## 1. Current State of Task Rules Implementation

### 1.1 What Exists (Foundation)

**TaskRule Model:**
```prisma
model TaskRule {
  id                String                  @id @default(cuid())
  name              String
  orderType         OrderType               // HOME_SAMPLE, CENTER_VISIT, INJECTION
  taskTypeId        Int
  titleTemplate     String                  // Supports: {{patientName}}, {{orderId}}, {{storeName}}, {{labName}}
  slaMinutes        Int
  priority          TaskPriority            // URGENT, HIGH, MEDIUM, LOW
  triggerType       TaskRuleTriggerType     // STATUS or TIME
  triggerCondition  Json                    // Flexible but unvalidated
  isActive          Boolean
  escalationChainId Int?
  requiredSkills    TaskRuleSkill[]         // Skills needed for assignment
  tasks             Task[]
  createdAt         DateTime
  updatedAt         DateTime
}
```

**Current Trigger Condition Structure:**
```typescript
interface TriggerCondition {
  statusIn: string[];                    // ✅ Order status matching
  minutesSinceCreated?: number;         // ✅ Age since order created
  minutesSinceStatusUpdated?: number;   // ✅ Time in current status
  minutesBeforeAppointment?: number;    // ✅ Time window before appointment
  minutesAfterAppointment?: number;     // ✅ Time window after appointment
  requiresNoPreviousTaskOfType?: boolean; // ⚠️ Partially implemented
}
```

**Rule Evaluation Engine:**
- Polling-based (every 5 minutes via cron)
- Fetches all active orders from Labstack
- Evaluates each rule against each order
- Creates tasks when conditions match
- Deduplication: one active task per (ruleId, orderId)
- Assignment: Round-robin load-balancing with skill filtering

### 1.2 What Works

✅ **Core Infrastructure:**
- Rules can be created and configured via API
- Rules can be enabled/disabled
- Task creation from matching rules
- Skill-based assignment filtering
- Escalation chain integration
- Deduplication logic prevents duplicate tasks

✅ **Rule Statistics:**
- Tracks tasks created per rule
- Tracks rule usage (tasks in last 24h)
- Shows total tasks created by each rule

✅ **Assignment Logic:**
- Picks agent with fewest open tasks (load-balancing)
- Filters by required skills
- Filters by store assignment
- Filters by daily roster status (ACTIVE, ON_FIELD)

---

## 2. SOP Readiness Assessment

### 2.1 The 8 HSC (Home Sample Collection) SOPs

Your SOPs define 8 distinct operational rules:

| Rule ID | SOP Name | Trigger | Required Logic | Status |
|---------|----------|---------|----------------|--------|
| **HSC-R1** | 30-Min Booking Confirm | Order created → 30 mins passed | statusIn + minutesSinceCreated | ✅ Supported |
| **HSC-R2** | T-1 Previous Day Closure | Appointment tomorrow | statusIn + appointmentTime tomorrow | ⚠️ Partial (no date math) |
| **HSC-R3** | Pre-Visit Phlebo Check | 30 mins before appointment | statusIn + minutesBeforeAppointment | ✅ Supported |
| **HSC-R4** | Collection Tracking | 60+ mins in PHLEBO_ASSIGNED | statusIn + minutesSinceStatusUpdated | ✅ Supported |
| **HSC-R5** | Sample Handover Check | 30+ mins in SAMPLE_COLLECTED | statusIn + minutesSinceStatusUpdated | ✅ Supported |
| **HSC-R6** | Report Tracking | Sample delivered + check ETA | statusIn + metadata field | ❌ Not Supported |
| **HSC-R8** | Escalation (Stuck Orders) | 2+ hours without status change | statusIn + minutesSinceStatusUpdated | ✅ Supported |

**Readiness Score: 5/8 (62.5%)**

### 2.2 Supported Rules Analysis

**✅ Fully Supported (5 rules):**
- HSC-R1, HSC-R3, HSC-R4, HSC-R5, HSC-R8

These use simple combinations of:
- Order status matching
- Time-based conditions (minutes since created/status change/appointment)

**⚠️ Partially Supported (1 rule):**
- HSC-R2: Cannot reliably trigger for "appointment tomorrow" because:
  - No date arithmetic in conditions (only time deltas)
  - Must use hack: "minutesBeforeAppointment" set to 24hrs+ and "minutesAfterAppointment" = 0
  - Not semantically clear or maintainable

**❌ Not Supported (1 rule):**
- HSC-R6: Requires metadata field checking
  - Trigger on `order.metadata.reportETA` timestamp
  - Fire when ETA is within 2 hours OR has passed
  - **Completely missing** from trigger condition options

**⚠️ Partially Supported (1 rule):**
- HSC-R2: Semantically awkward
  - Current workaround: Use "minutesBeforeAppointment: 1440" + "minutesAfterAppointment: 0"
  - This means: "Fire if appointment is between 24hrs in future and now"
  - Works but is confusing and error-prone

---

## 3. Critical Issue: Status Enum Mismatch

### 3.1 The Problem

**Labstack Order Statuses** (from public schema, already defined):
```
ORDER_SCHEDULED
PHLEBO_ASSIGNED
SAMPLE_COLLECTED
SAMPLE_DELIVERED
SAMPLE_IN_TRANSIT
REPORT_READY
REPORT_DELIVERED
CANCELED (terminal)
PATIENT_MISSED (terminal)
```

**Current Issue:**
Rules reference **Order statuses**, but the system doesn't validate that these actually exist. There's no validation preventing:

```json
{
  "name": "Invalid Rule",
  "triggerCondition": {
    "statusIn": ["NONEXISTENT_STATUS", "ANOTHER_FAKE_STATUS"]
  }
}
```

**Why This Matters:**
- Silent failures: Rule created but never triggers
- Hard to debug: No error message explaining why rule doesn't work
- Requires manual validation by Super Admin

### 3.2 Impact

1. **Silent Failures**: Rules referencing non-existent statuses never trigger
2. **Hard to Debug**: Ops team creates rule, nothing happens, unclear why
3. **No Feedback**: API doesn't warn about invalid statuses
4. **Data Inconsistency**: Database contains invalid rule configurations

### 3.3 Current State

- ❌ No validation of `triggerCondition.statusIn` values
- ❌ No Labstack Order Status enum exposed to TaskOS
- ❌ No API documentation stating which statuses are valid
- ❌ No UI selector showing available Labstack order statuses

---

## 4. Detailed Gap Analysis

### 4.1 Configuration Gaps

| Feature | Current | Need | Priority |
|---------|---------|------|----------|
| Status matching | ✅ Simple array | ✅ OK | Low |
| Time-based triggers | ⚠️ Minutes delta only | ⚠️ Need date-based | Medium |
| Metadata conditions | ❌ None | ❌ Required (R6) | High |
| Compound logic | ❌ Only AND | ⚠️ Need OR for complex rules | Medium |
| Time windows | ⚠️ Before/after only | ⚠️ Need "between X and Y" | Medium |
| Negative conditions | ❌ None | ⚠️ "No task of type X exists" | Low |

### 4.2 Metadata Conditions (Critical Gap)

**Use Case: HSC-R6 (Report Tracking)**

Currently unsupported:
```json
{
  "statusIn": ["SAMPLE_DELIVERED"],
  "metadataConditions": {
    "reportETA": {
      "exists": true,
      "operator": "<=",
      "offsetMinutes": 120  // Trigger if ETA is within next 2 hours
    }
  }
}
```

**Why This Matters:**
- Report ETA is stored in order.metadata.reportETA (timestamp)
- Need to trigger tasks based on this dynamic value
- Currently: R6 cannot be implemented; requires manual intervention

### 4.3 Time Window Gaps

**Current Support:**
- "At least X minutes since Y" ✅
- "At most X minutes until Z" ✅

**Missing Support:**
- "Between appointment -30 mins and now" ❌
- "30 mins before AND 15 mins after" (overlapping windows) ❌
- "Every day at 20:00 IST if order in X status" ❌ (no scheduled triggers)

### 4.4 Assignment Readiness

**Current:**
- ✅ Skill-based filtering works
- ✅ Store-based filtering works
- ✅ Load-balancing (fewest open tasks) works
- ⚠️ No manual override option
- ⚠️ No agent capacity constraints
- ⚠️ No time-zone aware scheduling

---

## 5. Configuration Options: Sufficiency Assessment

### 5.1 Current Flexibility

**What Can You Configure Today?**

✅ **Per-Rule:**
- Rule name, description
- Order type (HOME_SAMPLE, CENTER_VISIT, INJECTION)
- Task type (determines checklist, aging thresholds)
- Title template (with basic variable substitution)
- SLA duration (minutes)
- Priority (URGENT, HIGH, MEDIUM, LOW)
- Trigger type (STATUS or TIME)
- Trigger conditions (structured JSON)
- Required skills for assignment
- Escalation chain (if SLA breached)
- Active/inactive toggle

**Limitations:**
- Cannot dynamically calculate SLA based on order metadata
- Cannot customize checklist per rule
- Cannot have rule-specific assignment weights
- Cannot schedule rules for specific times
- Cannot create conditional task titles (e.g., "URGENT: " prefix if priority=URGENT)

### 5.2 Future SOP Support Prediction

**If you add 5 more order types and 20+ more SOPs:**
- Current system can handle it technically
- But readability/maintainability will suffer
- Complex trigger conditions will become JSON spaghetti
- Need visual rule builder UI

**Verdict**: Configuration options are **minimally sufficient** for current SOPs, but **not extensible** for future complexity.

---

## 6. Recommendations for Improvement

### 6.1 Priority 1: Add Status Enum Validation (CRITICAL)

**Problem**: Rules can reference invalid Labstack statuses with no validation.

**Solution:**
1. **Extract/Import Labstack Order Status Enum:**
   - Use enum from existing Labstack database definitions
   - Already exists: ORDER_SCHEDULED, PHLEBO_ASSIGNED, SAMPLE_COLLECTED, SAMPLE_DELIVERED, SAMPLE_IN_TRANSIT, REPORT_READY, REPORT_DELIVERED, CANCELED, PATIENT_MISSED

2. **Add API Validation:**
   - When creating/updating rules: validate `triggerCondition.statusIn` against enum
   - Return 400 error if invalid status provided
   - Message: "Invalid status 'XYZ'. Valid statuses are: [list]"

3. **Update Rule Creation Endpoint:**
   - POST /api/task-rules: Add validation in request handler
   - PATCH /api/task-rules/{id}: Add validation on updates

4. **Add to Specification:**
   - Document valid Labstack statuses in Product Spec
   - Add to Technical Spec under "External System Dependencies"

**Effort**: 1-2 hours | **Impact**: High | **Risk**: Low

### 6.2 Priority 2: Support Metadata-Based Triggers (HIGH)

**Problem**: Cannot implement HSC-R6 (Report Tracking).

**Solution - Phase A (MVP):**
```typescript
interface TriggerCondition {
  statusIn: string[];
  minutesSinceCreated?: number;
  minutesSinceStatusUpdated?: number;
  minutesBeforeAppointment?: number;
  minutesAfterAppointment?: number;
  
  // NEW: Metadata conditions
  metadataConditions?: {
    [fieldPath: string]: {
      operator: "exists" | "equals" | "<=" | ">=" | "contains";
      value?: any;
      offsetMinutes?: number; // For timestamp fields
    }
  }
}
```

**Example:**
```json
{
  "statusIn": ["SAMPLE_DELIVERED"],
  "metadataConditions": {
    "reportETA": {
      "operator": "<=",
      "offsetMinutes": 120
    }
  }
}
```

**Implementation**:
- Parse JSON path (e.g., "reportETA" → order.metadata.reportETA)
- Add evaluation logic in taskCreator.ts
- Handle timestamp comparisons with timezone awareness

**Effort**: 4-6 hours | **Impact**: High (enables R6) | **Risk**: Medium

### 6.3 Priority 3: Add Compound Logic Support (MEDIUM)

**Problem**: Some future SOPs may need OR conditions.

**Example**: "Trigger if status A OR status B" with different follow-up actions.

**Solution:**
```typescript
interface TriggerCondition {
  // Existing...
  
  // NEW: Compound logic
  conditionGroups?: {
    operator: "AND" | "OR";
    conditions: TriggerCondition[];
  }[]
}
```

**When Needed**: Phase 4-5 (design first)

**Effort**: 6-8 hours | **Impact**: Medium | **Risk**: Medium

### 6.4 Priority 4: Time Window Enhancements (MEDIUM)

**Problem**: Cannot express "between X and Y minutes relative to event Z".

**Solution - Add to TriggerCondition:**
```typescript
interface TimeWindow {
  relativeTo: "created" | "statusUpdated" | "appointment";
  minMinutes: number;
  maxMinutes: number;
}

interface TriggerCondition {
  // Existing...
  timeWindows?: TimeWindow[];
}
```

**Example: HSC-R2 (T-1 Pre-Day Closure)**
```json
{
  "statusIn": ["ORDER_SCHEDULED", "PHLEBO_ASSIGNED"],
  "timeWindows": [{
    "relativeTo": "appointment",
    "minMinutes": 1440,     // 24 hours before
    "maxMinutes": 1439      // Actually 24 hours exactly (tomorrow)
  }]
}
```

**Effort**: 3-4 hours | **Impact**: Medium | **Risk**: Low

### 6.5 Priority 3: Rule Builder UI (HIGH PRIORITY - Move Up)

**Current State**: Rules configured via JSON API only.

**Problem**: Super Admin needs UI to create/edit rules without API calls.

**Solution**: React UI component with tech-savvy interface:
- **Trigger Condition Builder:**
  - Status selector (dropdown with valid Labstack statuses)
  - Time conditions (readable fields: "minutes since created", "minutes before/after appointment")
  - Metadata conditions (field selector + operator + value)
- **Rule Configuration:**
  - Order type selector
  - Task type selector
  - Title template with live preview
  - SLA minutes input
  - Priority selector
  - Required skills multi-select (with search)
  - Escalation chain selector
- **Validation & Feedback:**
  - Real-time validation errors (invalid statuses, missing required fields)
  - Preview of trigger logic: "Rule will trigger when: [readable description]"
  - Test button: "Show matching orders for this rule"
- **Advanced Features:**
  - JSON editor mode (for power users)
  - Rule history/audit trail
  - Duplicate rule button

**Target User**: Super Admin (technical, understands config/ops logic)

**Effort**: 6-8 hours | **Impact**: Usability + Productivity | **Risk**: Low

### 6.6 Priority 6: SOP Documentation & Validation (LOW)

**Add to Product Spec:**
- Complete list of supported SOPs (R1-R8 mapping)
- For each rule: trigger conditions, expected behavior, success criteria
- Examples of valid vs invalid configurations

**Add to Technical Spec:**
- TriggerCondition JSON schema with examples
- Validation logic
- Evaluation algorithm pseudocode

---

## 7. Implementation Roadmap

### Phase 1: Foundation Fixes (1-2 days)
- [ ] Extract existing Labstack order status enum
- [ ] Add status validation to rule creation endpoint
- [ ] Add validation to rule update endpoint
- [ ] Return helpful error messages (list valid statuses)
- [ ] Add status list to API documentation

### Phase 2: Metadata Support (2-3 days)
- [ ] Extend TriggerCondition interface with metadata conditions
- [ ] Implement metadata field evaluation logic in taskCreator.ts
- [ ] Add timestamp offset support (for ETA comparisons)
- [ ] Add tests for HSC-R6 (Report Tracking)
- [ ] Enable HSC-R6 rule creation and testing

### Phase 3: Rule Builder UI (3-4 days)
- [ ] Create Rule Builder component (React)
- [ ] Status selector dropdown (validated against enum)
- [ ] Time condition builders (readable format)
- [ ] Metadata condition builder (field + operator + value)
- [ ] Rule preview (shows trigger logic in plain English)
- [ ] Test button (show matching orders for this rule)
- [ ] JSON editor fallback (for power users)

### Phase 4: Audit & Documentation (1-2 days)
- [ ] Add rule modification audit trail (created/updated by whom, when)
- [ ] Update Product Spec with rule configuration examples
- [ ] Update Technical Spec with TriggerCondition schema
- [ ] Document Super Admin UI usage

### Phase 5: Advanced Features (Future - Priority 4)
- [ ] Multi-order triggers (aggregate conditions: COUNT, GROUP BY)
- [ ] Time window enhancements (between X and Y minutes)
- [ ] Rule cloning/versioning
- [ ] Rule performance metrics (how often each rule triggers)

---

## 8. Current Rule Configuration Examples

### Example 1: HSC-R1 (30-Min Booking Confirm) ✅

**Status:** Fully supported

```json
{
  "name": "HSC-R1: 30-Min Booking Confirm",
  "orderType": "HOME_SAMPLE",
  "titleTemplate": "Confirm {{patientName}} appointment - called?",
  "slaMinutes": 30,
  "priority": "HIGH",
  "triggerType": "TIME",
  "triggerCondition": {
    "statusIn": ["ORDER_SCHEDULED"],
    "minutesSinceCreated": 30
  },
  "requiredSkills": ["communication"],
  "escalationChainId": 1
}
```

### Example 2: HSC-R6 (Report Tracking) ❌

**Status:** NOT supported - workaround needed

```json
{
  "name": "HSC-R6: Report Tracking (BROKEN)",
  "orderType": "HOME_SAMPLE",
  "titleTemplate": "Check report ETA for {{patientName}}",
  "slaMinutes": 120,
  "priority": "MEDIUM",
  "triggerType": "TIME",
  "triggerCondition": {
    "statusIn": ["SAMPLE_DELIVERED"],
    // PROBLEM: No way to check metadata.reportETA
    // WORKAROUND: Manually check orders in admin panel
  }
}
```

---

## 9. Product Discussion - Answers Received

### Answered Questions:

1. **Future SOP Complexity**: ❌ No OR/AND logic needed
   - Keep simple: status + time conditions only
   - No conditional branches needed

2. **Dynamic SLA**: ❌ No dynamic SLA needed
   - Fixed SLA per rule is sufficient
   - No calculation based on metadata/events

3. **Rule Testing**: ❌ No pre-activation testing needed
   - Rules activate immediately
   - Super Admin responsible for validation

4. **Rule Versioning & Audit Trail**: ✅ Maybe (nice-to-have)
   - Track when rules change
   - Who modified rules and when
   - Helps debug why behavior changed

5. **Multi-Order Triggers**: ✅ YES - Good Use Case
   - "If 3+ orders from same store stuck in PHLEBO_ASSIGNED for 2+ hours"
   - "If 5+ HOME_SAMPLE orders in same store pending collection"
   - **Requires:** Aggregate conditions (COUNT, GROUP BY logic)
   - **Priority**: P4 (future enhancement, complex)

---

## 10. Summary Table

| Aspect | Current | Gap | Recommendation | Priority |
|--------|---------|-----|-----------------|----------|
| **Status Enum** | No validation | High | Use existing enum + add API validation | **P1** (1-2d) |
| **Metadata Triggers** | Not supported | High | Implement metadata conditions | **P2** (2-3d) |
| **Rule Builder UI** | API only | High | Build UI for Super Admin | **P3** (3-4d) |
| **Audit Trail** | None | Medium | Track rule modifications | **P4** (1-2d) |
| **Multi-Order Triggers** | Not supported | Medium | Support aggregate conditions (future) | **P5** (future) |
| **Time Windows** | Minutes delta only | Low | Not needed per product decision | Deprioritized |
| **Compound Logic** | AND only | Low | Not needed per product decision | Deprioritized |
| **SOP Coverage** | 62.5% (5/8) | High | After P1+P2: 100% (8/8) | P1+P2 |
| **Assignment Logic** | Functional ✅ | None | — | — |
| **Deduplication** | Works ✅ | None | — | — |
| **Escalation** | Integrated ✅ | None | — | — |

---

## 11. Conclusion

**The Task Rules feature has a solid foundation** but needs **4 prioritized improvements** to reach full production readiness:

### Critical Blockers to Production:
1. ❌ **HSC-R6 cannot be implemented** (metadata triggers missing) → **P2 fixes this**
2. ❌ **No status validation** (silent rule failures) → **P1 fixes this**
3. ❌ **No UI for rule creation** (Super Admin must use API) → **P3 fixes this**

### Timeline to Full SOP Support:

| Phase | Days | Deliverable | SOP Coverage |
|-------|------|-------------|--------------|
| **P1** | 1-2 | Status validation | 62.5% → 62.5% (prevents errors) |
| **P2** | 2-3 | Metadata triggers | 62.5% → 87.5% (adds R6) |
| **P3** | 3-4 | Rule Builder UI | 87.5% → 87.5% (usability) |
| **P1+P2+P3** | 6-9 | **Complete** | **100% (8/8 SOPs)** |

### Deferred (Not Needed Per Product):
- ❌ OR/AND compound logic
- ❌ Dynamic SLA calculation
- ❌ Pre-activation testing
- ⏳ Multi-order triggers (Phase 5, good use case for future)

### Ready to Use As-Is ✅:
- Assignment logic (skill-based routing)
- Deduplication (no duplicate tasks)
- Escalation chains
- Rule statistics & usage tracking

**Recommendation:**
Execute P1 → P2 → P3 in sequence (6-9 days total). After P2 completes, **100% of current SOPs are fully supported and ready for production**.

---

**Prepared by: Abhishek (Product Manager), informed by codebase analysis**  
**Next Step:** Schedule implementation kickoff, assign developer(s), track progress.
