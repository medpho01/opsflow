# Teams Feature - Implementation Roadmap

**Feature**: Team Member Management & Order Type Assignment  
**Version**: 1.0  
**Estimated Timeline**: 2 weeks  
**Estimated Effort**: 40 engineer-days

---

## Overview

Simple team member management with order type assignment and performance metrics viewing.

---

## Implementation Phases

### Phase 1: Core Infrastructure (Days 1-4)

#### 1.1 Database Schema
- [ ] Create `TeamMemberOrderType` junction table
- [ ] Add indexes on `teamMemberId` and `orderTypeId`
- [ ] Create migration file

**Effort**: 1 day  
**Owner**: Database Engineer

#### 1.2 API Endpoints - Member Management
- [ ] GET /api/teams/members (list with pagination)
- [ ] GET /api/teams/members/{id} (detail view)
- [ ] POST /api/teams/members (add member)
- [ ] PATCH /api/teams/members/{id} (update role/capacity)
- [ ] DELETE /api/teams/members/{id} (remove member)

**Effort**: 3 days  
**Owner**: Backend Engineer

#### 1.3 API Endpoints - Order Type Assignment
- [ ] GET /api/teams/members/{id}/order-types
- [ ] POST /api/teams/members/{id}/order-types
- [ ] DELETE /api/teams/members/{id}/order-types/{orderTypeId}

**Effort**: 2 days  
**Owner**: Backend Engineer

**Total Phase 1**: 6 days

---

### Phase 2: Frontend UI (Days 5-9)

#### 2.1 Members List Page
- [ ] Build members list component with pagination
- [ ] Add filters (store, role)
- [ ] Display order types assigned to each member
- [ ] Show basic performance stats (assigned, completed, SLA%)
- [ ] Add/remove member buttons

**Effort**: 3 days  
**Owner**: Frontend Engineer

#### 2.2 Member Detail Page
- [ ] Build member profile view
- [ ] Display assigned order types
- [ ] Modal to assign new order types
- [ ] Remove order type functionality
- [ ] Performance metrics (this month, this week)

**Effort**: 3 days  
**Owner**: Frontend Engineer

#### 2.3 Integration with Existing Pages
- [ ] Update Task Rules to show member order types
- [ ] Update Task Board to show member order types on hover
- [ ] Update All Tasks to reference Teams for member info

**Effort**: 1 day  
**Owner**: Frontend Engineer

**Total Phase 2**: 7 days

---

### Phase 3: Backend Integrations (Days 10-12)

#### 3.1 Engine Integration
- [ ] Update task assignment logic to check member's order types
- [ ] Filter eligible members by assigned order types
- [ ] Log assignments properly

**Effort**: 2 days  
**Owner**: Backend Engineer

#### 3.2 Analytics Integration
- [ ] Update performance metrics to pull from Task table
- [ ] Verify SLA calculations are correct
- [ ] Test stats accuracy

**Effort**: 1 day  
**Owner**: Backend Engineer

#### 3.3 Validation & Error Handling
- [ ] Invalid order type checks
- [ ] Duplicate assignment prevention
- [ ] Member not found errors

**Effort**: 1 day  
**Owner**: Backend Engineer

**Total Phase 3**: 4 days

---

### Phase 4: Testing & QA (Days 13-14)

#### 4.1 Testing
- [ ] Unit tests for API endpoints
- [ ] Integration tests for order type assignment
- [ ] UI component tests
- [ ] End-to-end workflow tests

**Effort**: 2 days  
**Owner**: QA Engineer + Backend Engineer

#### 4.2 Manual QA
- [ ] Add member workflow
- [ ] Assign/remove order types
- [ ] View member details and stats
- [ ] Filter and search members
- [ ] Integration with task assignment

**Effort**: 1 day  
**Owner**: QA Engineer

**Total Phase 4**: 3 days

---

## Task Breakdown

| Task | Days | Owner | Dependencies |
|------|------|-------|--------------|
| DB Schema | 1 | DB Eng | None |
| Member APIs | 3 | Backend | DB Schema |
| OrderType APIs | 2 | Backend | DB Schema |
| Members List UI | 3 | Frontend | Member APIs |
| Member Detail UI | 3 | Frontend | Member APIs, OrderType APIs |
| Page Integration | 1 | Frontend | UI components |
| Engine Integration | 2 | Backend | All APIs |
| Analytics | 1 | Backend | Task table (exists) |
| Validation | 1 | Backend | All APIs |
| Testing | 2 | QA + Backend | All components |
| Manual QA | 1 | QA | All components |
| **TOTAL** | **20** | 2-3 engineers | |

---

## Timeline

```
Week 1 (May 5-9)
├─ Mon-Tue: DB schema + migrations
├─ Tue-Wed: Member management APIs
├─ Wed-Thu: Order type assignment APIs
└─ Fri: Code review + adjustments

Week 2 (May 12-16)
├─ Mon-Tue: Members list UI + detail page
├─ Tue-Wed: Order type assignment UI
├─ Wed: Page integrations
├─ Thu: Engine + Analytics integration
└─ Fri: Testing + fixes

Week 3 (May 19-23)
├─ Mon-Tue: Final testing + adjustments
├─ Wed-Thu: Manual QA + bug fixes
└─ Fri: Deployment prep

Launch Target: May 24, 2026
```

---

## Resource Requirements

- **1 Backend Engineer** (2 weeks) - APIs, engine integration
- **1 Frontend Engineer** (1.5 weeks) - UI components
- **1 QA Engineer** (0.5 weeks) - Testing
- **1 Database Engineer** (0.2 weeks) - Schema/migrations

**Total**: ~20 engineer-days

---

## Success Criteria

- ✅ Add/remove team members without errors
- ✅ Assign multiple order types per member
- ✅ Order type filters work in task assignment
- ✅ Performance stats accurate and fast (<200ms)
- ✅ No regressions in existing features
- ✅ All manual QA tests pass
- ✅ Zero critical bugs

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Database schema conflicts | Review existing schema carefully, test migrations in staging |
| Order type enum mismatch | Verify order types come from PostgreSQL system catalog |
| Performance stats accuracy | Validate stats match task data in existing tables |
| Integration with Engine | Early integration testing with Engine team |

---

## Out of Scope

- ❌ Assignment scoring or recommendations
- ❌ Skill proficiency levels
- ❌ Availability/shift scheduling (Roster feature)
- ❌ Leave management
- ❌ ML-based optimization
- ❌ Affinity tracking

---

**Next Steps**:
1. Approve technical specification
2. Start database schema creation
3. Begin API endpoint development
4. Parallel UI component work

