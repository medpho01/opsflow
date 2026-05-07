# OpsFlow "All Tasks" Feature Overhaul — Implementation Plans Summary

**Date:** May 1, 2026  
**Project:** Complete feature implementation across Frontend, Backend, and QA  
**Duration:** 7-9 weeks (10 weeks including QA)  
**Team Size:** 2-3 engineers + 1 PM + 1-2 QA

---

## QUICK REFERENCE

Three comprehensive implementation plans have been created:

### 1. FRONTEND IMPLEMENTATION PLAN
**File:** `IMPLEMENTATION_PLAN_1_FRONTEND.md`
- **14 Features** across 3 phases
- **Effort:** 25-35 days development
- **Focus:** Real-time data freshness, visual urgency, powerful filtering
- **Key Components:** Refresh button, WebSocket listener, SLA color zones, status widget, Kanban view

### 2. BACKEND IMPLEMENTATION PLAN
**File:** `IMPLEMENTATION_PLAN_2_BACKEND.md`
- **8 Critical Fixes** (Priority 1) + **8 High-Priority Fixes** (Priority 2)
- **New API Endpoints** for assignment metadata, task history, WebSocket events
- **Effort:** 35-45 days (fixes + features)
- **Focus:** Data integrity, race condition prevention, timezone support, real-time events

### 3. QA / TESTING IMPLEMENTATION PLAN
**File:** `IMPLEMENTATION_PLAN_3_QA_TESTING.md`
- **Comprehensive test pyramid** (unit, integration, E2E, performance, UAT)
- **Regression tests** for all 8 critical bugs
- **14 feature test suites** with detailed scenarios
- **Performance targets:** Sort <100ms, WebSocket <5s, SLA ±1s accuracy
- **Success criteria:** Zero duplicates, 80% coverage, ops UAT sign-off

---

## PHASE BREAKDOWN

### PHASE 1: FOUNDATION (Weeks 1-2) — Quick Wins
**5 Critical Features**
1. Manual Refresh Button + Last Updated Timestamp (F1.1) — 3-4 hrs
2. Auto-Refresh on New Task Creation via WebSocket (F1.2) — 4-5 days
3. Color-Coded Urgency Zones (Green/Yellow/Red) (F1.3) — 2-3 days
4. Status Distribution Widget (F1.4) — 2-3 days
5. Assignment Status Visibility (F1.5) — 3-4 days

**Effort:** 14-18 frontend days + 7-10 backend days = **24-28 days**
**Outcome:** Real-time foundation, urgency visibility, workflow transparency

### PHASE 2: USABILITY (Weeks 3-5) — Core Improvements
**5 Refinement Features**
1. Unified Filter Bar (F2.1) — 4 days
2. Better SLA Display with Context (F2.2) — 2 days
3. Task Detail Side Panel (F2.3) — 4-5 days
4. Improved Empty State Messaging (F2.4) — 1 day
5. Assignment Rule Audit Trail (F2.5) — 2 days

**Effort:** 14-17 frontend days + 3-5 backend days = **20-22 days**
**Outcome:** Polished UX, deep task inspection, context-rich decisions

### PHASE 3: INTELLIGENCE (Weeks 6-10) — Advanced Capabilities
**4 Advanced Features**
1. Kanban / Grouping View (F3.1) — 5-7 days
2. Real-Time Alerts / Notifications (F3.2) — 3-4 days
3. Task Aging Indicator (F3.3) — 2-3 days
4. Bulk Select for Filtered View (F3.4) — 2-3 days

**Effort:** 12-17 frontend days + 2-3 backend days = **16-20 days**
**Outcome:** Visual workflow management, proactive alerting, stuck task detection

---

## CRITICAL FIXES TIMELINE

### Week 1: Priority 1 Fixes (MUST DO BEFORE PRODUCTION)

1. **C1.1: Unique Constraint** (3-4 hrs)
   - Database migration, Prisma schema update
   - Prevents duplicate task creation race condition
   - Atomic upsert in code

2. **C1.2: Polling Lock** (2-3 hrs)
   - PostgreSQL advisory lock implementation
   - Prevents concurrent polling cycles
   - Process-safe (works with Node cluster)

3. **C1.3: Status Transitions** (2 hrs)
   - Validation matrix for valid state changes
   - Prevents CREATED→BLOCKED illogical transitions
   - Bulk action filtering

4. **C1.4: Timezone Support** (3-4 hrs)
   - Environment-based timezone config
   - SLA calculations in app timezone
   - Consistent across server restarts

### Week 2: Priority 2 Fixes (BEFORE RELEASE)

5. **H2.1: Null Handling Sort** (2-3 hrs)
   - NULLS LAST for appointmentTime
   - Custom status order mapping
   - Raw SQL for complex sorts

6. **H2.2: Filter Validation** (2 hrs)
   - Zod schema validation
   - Type-safe enum checking
   - Clear error messages

7. **H2.3: Archive Stats Type Safety** (1.5 hrs)
   - Strict interface definitions
   - Schema validation
   - No `any` types

---

## EFFORT ESTIMATES

### Frontend Development
| Phase | Features | Days | Notes |
|-------|----------|------|-------|
| 1 | Refresh, WebSocket, Colors, Status widget, Assignment | 18 days | Critical path |
| 2 | Filters, SLA, Side panel, Empty state, Audit trail | 17 days | UX-focused |
| 3 | Kanban, Alerts, Aging, Bulk select | 17 days | Advanced |
| **Total** | 14 features | **52 days** | ~2.5 FTE × 3 weeks |

### Backend Development
| Priority | Fixes | Days | Notes |
|----------|-------|------|-------|
| 1 | Constraints, Lock, Transitions, Timezone | 13 days | Critical fixes |
| 2 | Sorting, Validation, Type safety | 6 days | High-priority fixes |
| Features | WebSocket, Assignment metadata, History | 12 days | New endpoints |
| **Total** | 8+8+Features | **35 days** | ~2 FTE × 2.5 weeks |

### QA / Testing
| Level | Effort | Notes |
|-------|--------|-------|
| Unit Tests | 10 days | 80% code coverage |
| Integration Tests | 8 days | API, DB, WebSocket |
| E2E Tests | 6 days | Real browser workflows |
| Performance Tests | 3 days | Sort <100ms, Broadcast <5s |
| UAT | 3 days | Ops manager sign-off |
| **Total** | **30 days** | Parallel with development |

### Grand Total
**Frontend:** 52 days  
**Backend:** 35 days  
**QA:** 30 days (parallel)  
**Total Sequential:** ~87 days ≈ **7-9 weeks full-time (1 PM + 2 FE + 1 BE + 1 QA)**

---

## TEAM ASSIGNMENTS (RECOMMENDED)

### Team Composition
- **1 Frontend Lead** (architecture, F1, F2, F3.1-3.3 coordination)
- **1 Frontend Mid-level** (features, component testing)
- **1 Backend Lead** (fixes, WebSocket, data integrity)
- **1 Product Manager** (requirements, UAT coordination, communication)
- **1 QA Engineer** (test planning, E2E, performance, UAT)

### Parallel Streams
| Week | Frontend | Backend | QA |
|------|----------|---------|-----|
| 1-2 | F1.1-1.5 | C1.1-4, H2.1-3 | Unit test setup |
| 3-5 | F2.1-2.5 | F-B1.1-1.4 | Integration tests |
| 6-10 | F3.1-3.4 | Optimizations | E2E, Performance, UAT |
| 11+ | Bug fixes | Monitoring | Regression |

---

## DEPENDENCIES & CRITICAL PATH

```
Critical Path:
  C1.1 (Unique Constraint) ↓
  C1.2 (Polling Lock) ↓
  F-B1.1 (WebSocket) ↓
  F1.2 (Auto-Refresh) ↓
  F1.3 (Color Zones) ↓
  F2.3 (Side Panel) ↓
  F3.1 (Kanban View) ↓
  UAT Sign-off
```

**Blocking Dependencies:**
- WebSocket implementation blocks F1.2
- Assignment metadata blocks F1.5, F2.5, F3.4
- Polling lock blocks all production deployment
- Timezone support blocks SLA accuracy

---

## SUCCESS METRICS

### Technical
- ✅ **Zero duplicate tasks** after 100-cycle stress test
- ✅ **All 8 bugs** have passing regression tests
- ✅ **SLA accuracy** within ±1 second
- ✅ **Sort/filter queries** <100ms with 10k tasks
- ✅ **WebSocket broadcast** <5 seconds (500 clients)
- ✅ **Memory usage** <200MB for 10k tasks in memory
- ✅ **80%+ unit test coverage** for business logic

### User Experience
- ✅ **<3 seconds** to identify SLA-at-risk tasks (from 30s)
- ✅ **<5 minutes** to verify auto-assignments (from 10+ mins)
- ✅ **<30 seconds** to manually reassign (from 2 mins)
- ✅ **<5 seconds** data freshness (from 30+ mins)
- ✅ **40% reduction** in SLA incidents (via color zones + alerts)

### Operational
- ✅ **Ops manager NPS** improves 5→7→8+ across phases
- ✅ **Support tickets** reduce from 10/month to <2/month
- ✅ **Feature adoption** >90% daily usage
- ✅ **Zero production bugs** after 1 week in production

---

## RISK MITIGATION

| Risk | Mitigation |
|------|-----------|
| WebSocket connection drops | Fallback to polling, auto-reconnect with backoff |
| Large dataset performance | Pagination in Kanban columns, virtualized rows |
| Race conditions in concurrent polling | Database-level lock, atomic upsert, constraint |
| Timezone confusion in multi-region deployment | Environment config, ISO 8601 timestamps, tests |
| SLA calculation errors | Comprehensive test suite, monitoring, audit trail |
| Browser compatibility | Test on Chrome, Firefox, Safari, Edge |
| Mobile responsiveness | Desktop-first Phase 1-3, mobile Phase 4 |

---

## FILE LOCATIONS

All detailed implementation plans are stored in `/Users/maverick/Documents/TaskOs/`:

1. **IMPLEMENTATION_PLAN_1_FRONTEND.md** — Frontend roadmap (14 features, 3 phases)
2. **IMPLEMENTATION_PLAN_2_BACKEND.md** — Backend fixes and APIs (8+8 fixes, 4 new endpoints)
3. **IMPLEMENTATION_PLAN_3_QA_TESTING.md** — Comprehensive test strategy (unit, integration, E2E, UAT)

---

## NEXT STEPS

### Immediate (Day 1)
- [ ] Review all three implementation plans with team
- [ ] Finalize team assignments
- [ ] Create Jira epics and tickets from plans
- [ ] Set up test infrastructure (Jest, Playwright, etc.)

### Week 1
- [ ] Begin C1.1-C1.4 critical fixes in parallel
- [ ] Set up WebSocket infrastructure (F-B1.1)
- [ ] Start F1.1 (Refresh button) — easy first win
- [ ] Write unit test templates

### Week 2
- [ ] Complete all critical fixes (C1.1-C1.4)
- [ ] Complete all Priority 2 fixes (H2.1-H2.3)
- [ ] Launch F1.2-1.5 features
- [ ] Begin integration test suite

### Week 3+
- [ ] Launch Phase 2 features
- [ ] QA executes integration and E2E tests
- [ ] Prepare ops manager UAT

---

## COMMUNICATION PLAN

- **Daily standups:** 15-min sync on blockers, PRs
- **Weekly demos:** Show working features to stakeholders
- **Bi-weekly planning:** Adjust timeline, discuss risks
- **UAT kickoff:** Week 4 (ops managers review Phase 1)
- **Production deployment:** Week 9-10 (after Phase 3 + UAT)

---

**Status:** ✅ Ready to begin implementation  
**Version:** 1.0  
**Last Updated:** May 1, 2026  
**Prepared by:** Technology Architect — Healthcare Operations Systems
