# All Tasks - Feature Documentation

Welcome to the All Tasks feature documentation! This directory contains everything you need to understand, develop, and extend the task management and operations board.

## 📚 Documentation Structure

| Document | Purpose | Audience |
|----------|---------|----------|
| [FEATURE_SPEC.md](FEATURE_SPEC.md) | Product requirements, UI/UX, use cases | Product Managers, Designers, Developers |
| [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) | Architecture, APIs, database, components | Backend & Frontend Developers |
| [API_ENDPOINTS.md](API_ENDPOINTS.md) | All endpoints for task operations | API Consumers, Frontend Developers |
| [TESTING_GUIDE.md](TESTING_GUIDE.md) | Unit, integration, E2E testing strategy | QA Engineers, Developers |
| [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) | Phases, effort, team assignments | Project Managers, Tech Leads |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common issues and debug guides | Support, DevOps, Developers |

## 🎯 Feature Overview

The **All Tasks** feature provides operations teams with a comprehensive, real-time view of all tasks across the TaskOS system. It enables:

- ✅ **Task Listing with Advanced Filtering** - View, sort, and filter tasks by status, priority, assignee, and more
- ✅ **Multiple View Modes** - Table view with pagination and Kanban board for drag-and-drop status updates
- ✅ **SLA Monitoring** - Real-time SLA countdown with color-coded risk indicators
- ✅ **Task Assignment** - Assign tasks manually or via auto-assignment rules
- ✅ **Bulk Actions** - Reassign, cancel, or block multiple tasks at once
- ✅ **Filter Persistence** - Save and reuse filter combinations
- ✅ **Task Detail Panel** - View comprehensive task information in right sidebar

## 🚀 Quick Start for Developers

### Where is the code?
```
src/
├── app/(app)/head/tasks/page.tsx        # Main page component
├── components/head/                      # All task board components
│   ├── AllTasksBoard.tsx               # Main orchestrator
│   ├── UnifiedFilterBar.tsx            # Filter UI
│   ├── KanbanBoard.tsx                 # Kanban view
│   ├── TaskDetailPanel.tsx             # Right sidebar
│   └── ...                             # Other sub-components
├── app/api/tasks/                       # API endpoints
│   ├── route.ts                        # GET /api/tasks (main endpoint)
│   ├── filters/schema/route.ts         # GET /api/tasks/filters/schema
│   ├── saved-filters/route.ts          # GET/POST /api/tasks/saved-filters
│   └── status-distribution/route.ts    # GET /api/tasks/status-distribution
└── lib/                                 # Business logic
```

### How to run locally?
```bash
# Start development server
npm run dev

# Visit in browser
http://localhost:3000/head/tasks

# Run tests
npm test -- all-tasks
```

### Key Concepts
- **Status Flow**: CREATED → ASSIGNED → IN_PROGRESS → (BLOCKED) → COMPLETED | BREACHED
- **SLA Management**: Calculated at task creation, tracked at query time
- **Task Aging**: Time spent in current status, with color-coded thresholds
- **Role-Based Access**: Different visibility for OPS_AGENT, STORE_ADMIN, OPS_HEAD

## 🏗️ Architecture Overview

```
Browser (React)
    ↓
AllTasksBoard Component
├─ UnifiedFilterBar (manage filters)
├─ ViewToggle (table/kanban)
├─ TaskTable or KanbanBoard (display)
├─ TaskDetailPanel (right sidebar)
└─ StatusDistribution (widget)
    ↓ (fetch /api/tasks?filters=...)
API Layer (Next.js Route Handlers)
    ├─ /api/tasks (main query endpoint)
    ├─ /api/tasks/filters/schema (dropdown options)
    ├─ /api/tasks/saved-filters (user filters)
    └─ /api/tasks/status-distribution (counts per status)
    ↓ (SQL)
PostgreSQL Database
```

## 📊 Key Metrics

- **Supported Tasks**: 466+ concurrent active tasks
- **Status States**: 7 distinct states
- **View Modes**: Table (paginated) and Kanban (drag-drop)
- **Filter Types**: 6+ concurrent filters with persistence
- **Response Time Target**: <300ms for task queries
- **Update Frequency**: Manual refresh (WebSocket planned)

## 🔗 Related Features

- **Task Rules**: Auto-assignment of tasks based on rules → [Task Rules Docs](../task-rules/)
- **Command Center**: Dashboard overview of all operations → [Command Center Docs](../command-center/)
- **Engine**: Background polling that evaluates rules and creates tasks → [Engine Docs](../engine/)

## 📖 Reading Guide

**New to the project?**
1. Start with [FEATURE_SPEC.md](FEATURE_SPEC.md) - Understand what users do
2. Read [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) - Understand how it works
3. Check [API_ENDPOINTS.md](API_ENDPOINTS.md) - See all available endpoints

**Want to enhance a feature?**
1. Read [FEATURE_SPEC.md](FEATURE_SPEC.md) for requirements
2. Review [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) for architecture
3. Check [TESTING_GUIDE.md](TESTING_GUIDE.md) for test patterns
4. Follow [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) phases

**Running into problems?**
1. Check [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
2. Review error logs in browser console
3. Check API responses in Network tab

## 🧪 Testing

This feature includes:
- ✅ Unit tests for filters, SLA calculations, aging logic
- ✅ Integration tests for API endpoints with different roles
- ✅ E2E tests for complete user workflows
- ✅ Manual testing checklist for QA

See [TESTING_GUIDE.md](TESTING_GUIDE.md) for detailed testing strategy.

## 🚦 Status

| Component | Status | Notes |
|-----------|--------|-------|
| Task Listing | ✅ Production | Stable, handles 466+ tasks |
| Filtering | ✅ Production | Full multi-select support |
| Kanban View | ✅ Production | Drag-drop with optimistic updates |
| Real-time Updates | ⏳ Planned | WebSocket/SSE implementation coming |
| Mobile View | ⏳ Future | Not yet optimized for mobile |

## 💬 Questions?

- **Product Questions**: Contact Abhishek (Product Manager)
- **Technical Questions**: Contact Manjul (Tech Architect)
- **Implementation Questions**: Contact Mayur (Senior Developer)

---

**Last Updated**: May 2, 2026  
**Documentation Version**: 1.0
