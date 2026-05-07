# Teams Feature - Team Member & Order Type Management

**Feature Name**: Team Member Management  
**Status**: Design  
**Last Updated**: May 3, 2026

---

## 🎯 What is Teams?

Simple team member management for TaskOS. Organize your team members, assign them to order types they can handle, and track their performance.

### Core Capabilities

- **Add Team Members** - Register agents in the system
- **Assign Order Types** - Define which order types each member can handle
- **Manage Roles** - Set member roles (OPS_AGENT, OPS_HEAD, STORE_ADMIN)
- **View Performance** - See assigned/completed tasks and SLA metrics

### What It's NOT

- ❌ Not a complex skill proficiency system
- ❌ Not an assignment recommendation engine
- ❌ Not availability/shift scheduling (that's Roster)
- ❌ Not leave management

---

## 🚀 Quick Start

### For Product Managers
- [What users can do](FEATURE_SPEC.md)
- [How it integrates](FEATURE_SPEC.md#integration)

### For Developers
- [Technical design](TECHNICAL_SPEC.md)
- [Database schema](TECHNICAL_SPEC.md#database-schema)
- [API endpoints](TECHNICAL_SPEC.md#api-endpoints)

### For Operations
- [Implementation timeline](IMPLEMENTATION_ROADMAP.md)
- [What gets built each week](IMPLEMENTATION_ROADMAP.md#timeline)

---

## 📊 Key Metrics

Team members display:
- **Tasks Assigned** (this month/week)
- **Tasks Completed** (this month/week)
- **SLA Compliance %** (how many met deadline)
- **Avg Completion Time** (how fast they work)

---

## 🔧 Main Pages

### `/head/teams/members` - Members List
- View all team members
- Filter by store or role
- Add/remove members
- Quick stats for each member

### `/head/teams/members/{id}` - Member Detail
- Full member profile
- Order types assigned
- Assign/remove order types
- Performance metrics
- Update role/capacity

---

## 📋 Core Workflows

### Add a Team Member
1. Go to `/head/teams/members`
2. Click "+ Add Member"
3. Enter user info (name, email, role, store)
4. Set max concurrent tasks (default: 5)
5. Assign order types they can handle

### Assign Order Type to Member
1. Go to member detail page
2. Click "+ Assign Order Type"
3. Select order type from list
4. Done - they can now receive tasks of that type

### View Member Performance
1. Go to member detail page
2. See this month/week stats:
   - How many tasks assigned/completed
   - What % met SLA deadline
   - How long tasks take on average

---

## 🔗 Integration

**With Task Rules**: Rules check if member has required order type  
**With Engine**: Assignment filters members by assigned order types  
**With Analytics**: Performance metrics come from task data  

---

## ⚡ Implementation

**Timeline**: 2 weeks  
**Effort**: ~20 engineer-days  
**Team**: 1 backend + 1 frontend + 1 QA  

See [Implementation Roadmap](IMPLEMENTATION_ROADMAP.md) for details.

---

## 📚 Documentation

- [FEATURE_SPEC.md](FEATURE_SPEC.md) - What users can do
- [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) - How it's built
- [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) - When and how

---

**Status**: Ready for development  
**Next**: Technical review → Database schema → Development starts
