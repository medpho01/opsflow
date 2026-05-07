# TaskOS Documentation Hub

Welcome to the TaskOS documentation! This is your complete guide to understanding, developing, and operating the task management and automation platform.

## 🚀 Getting Started

**New to TaskOS?** Start here:
1. **[System Architecture](#system-architecture)** - Understand how TaskOS works
2. **[Feature Overview](#feature-overview)** - See what TaskOS can do
3. **[Quick Links](#quick-links)** - Find what you need

**Role-Specific Guides:**
- 👔 **[For Product Managers](#for-product-managers)**
- 👨‍💻 **[For Developers](#for-developers)**
- 🧪 **[For QA Engineers](#for-qa-engineers)**
- 🔧 **[For DevOps/System Admins](#for-devopsystem-admins)**

---

## 📚 System Architecture

TaskOS is a **task management and automation platform** that helps operations teams:

1. **Create & Manage Tasks** - Comprehensive task board with advanced filtering
2. **Automate Task Creation** - Rules-based system that auto-creates tasks
3. **Track SLA & Aging** - Real-time monitoring of deadlines and task lifecycle
4. **Analyze Performance** - Detailed analytics and reporting
5. **Monitor Operations** - Central command center dashboard

### Technology Stack
- **Frontend**: React 19, TypeScript, Tailwind CSS
- **Backend**: Next.js 15, TypeScript, Node.js
- **Database**: PostgreSQL with Prisma ORM
- **Background**: Node Cron, Labstack API integration
- **Real-time**: WebSocket planned (currently polling-based)

### Core Components

```
┌──────────────────────────────────────────────────────┐
│                    Browser (React)                   │
│  ┌─────────────────────────────────────────────────┐ │
│  │  Command Center    │  All Tasks  │  Task Rules   │ │
│  │  Analytics         │  Engine     │  Profiles     │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
                        ▼ (HTTP/JSON)
┌──────────────────────────────────────────────────────┐
│              Next.js API Server (Backend)            │
│  ┌─────────────────────────────────────────────────┐ │
│  │  /api/tasks          /api/task-rules             │ │
│  │  /api/dashboard      /api/analytics              │ │
│  │  /api/engine         /api/orders                 │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
                        ▼ (SQL)
┌──────────────────────────────────────────────────────┐
│            PostgreSQL Database                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │  Tasks  Rules  Orders  Users  Analytics  Audit  │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

---

## 🎯 Feature Overview

### 1. Command Center (HEAD Dashboard)
Central operations hub with:
- Real-time task statistics
- Team capacity overview
- Critical alerts
- Previous day's summary

📖 **[Command Center Docs](features/command-center/)**

### 2. All Tasks (Task Board)
Comprehensive task management with:
- Advanced filtering and sorting
- Table and Kanban views
- Drag-and-drop status updates
- Bulk actions
- Task detail sidebar
- Filter persistence

📖 **[All Tasks Docs](features/all-tasks/)**

### 3. Task Rules (Automation Engine UI)
Rule-based task auto-creation with:
- Status-based triggers
- Time-based conditions
- Metadata filtering
- Skill requirement routing
- Rule builder UI
- Audit trail

📖 **[Task Rules Docs](features/task-rules/)**

### 4. Analytics (Reporting)
Performance metrics and insights with:
- Agent performance reports
- Daily summaries
- SLA analytics
- Task aging distribution
- Custom date ranges

📖 **[Analytics Docs](features/analytics/)**

### 5. Engine (Background Processing)
Autonomous task processing with:
- 5-minute polling cycle
- Rule evaluation
- Task auto-creation
- SLA monitoring
- Daily summaries
- Health monitoring

📖 **[Engine Docs](features/engine/)**

### 6. Teams (Team Management & Skills)
Hierarchical team organization with:
- Team grouping and hierarchy
- Skill proficiency levels (Entry, Intermediate, Expert)
- Intelligent task assignment based on skills
- Availability scheduling and shift patterns
- Team performance analytics
- Bulk team operations and training tracking

📖 **[Teams Docs](features/teams/)**

---

## 🔗 Quick Links

### Feature Documentation
| Feature | Overview | Technical | APIs/Roadmap |
|---------|----------|-----------|------|
| **Command Center** | [README](features/command-center/README.md) | [Spec](features/command-center/TECHNICAL_SPEC.md) | [Endpoints](features/command-center/API_ENDPOINTS.md) |
| **All Tasks** | [README](features/all-tasks/README.md) | [Spec](features/all-tasks/TECHNICAL_SPEC.md) | [Endpoints](features/all-tasks/API_ENDPOINTS.md) |
| **Task Rules** | [README](features/task-rules/README.md) | [Spec](features/task-rules/TECHNICAL_SPEC.md) | [Roadmap](features/task-rules/IMPLEMENTATION_ROADMAP.md) |
| **Analytics** | [README](features/analytics/README.md) | [Spec](features/analytics/TECHNICAL_SPEC.md) | [Endpoints](features/analytics/API_ENDPOINTS.md) |
| **Engine** | [README](features/engine/README.md) | [Spec](features/engine/TECHNICAL_SPEC.md) | [Architecture](features/engine/ARCHITECTURE.md) |
| **Teams** | [README](features/teams/README.md) | [Spec](features/teams/TECHNICAL_SPEC.md) | [Roadmap](features/teams/IMPLEMENTATION_ROADMAP.md) |

### System Documentation
- [Architecture & Design](ARCHITECTURE.md)
- [API Reference](API_REFERENCE.md)
- [Best Practices](BEST_PRACTICES.md)
- [Development Setup](DEVELOPMENT_SETUP.md)
- [Deployment Guide](DEPLOYMENT_GUIDE.md)

---

## 👔 For Product Managers

**Understand the Product:**
1. [Feature Overview](#feature-overview) - What TaskOS does
2. [All Tasks Feature Spec](features/all-tasks/FEATURE_SPEC.md) - Task management
3. [Task Rules Feature Spec](features/task-rules/FEATURE_SPEC.md) - Automation rules
4. [Analytics Overview](features/analytics/README.md) - Reporting

**Common Questions:**
- How do tasks get created? → [Task Rules](features/task-rules/README.md)
- What can I filter on? → [All Tasks Filtering](features/all-tasks/FEATURE_SPEC.md#section5)
- How are SLA deadlines calculated? → [SLA Management](features/all-tasks/FEATURE_SPEC.md#section3)

---

## 👨‍💻 For Developers

**Get Started:**
1. [Development Setup](DEVELOPMENT_SETUP.md) - Local environment
2. [Architecture Overview](ARCHITECTURE.md) - System design
3. **Pick a feature** and read its docs:
   - [All Tasks Technical Spec](features/all-tasks/TECHNICAL_SPEC.md)
   - [Task Rules Technical Spec](features/task-rules/TECHNICAL_SPEC.md)
   - [API Reference](API_REFERENCE.md)

**Common Tasks:**
- Add a new task filter → [All Tasks API](features/all-tasks/API_ENDPOINTS.md)
- Create a new rule trigger → [Task Rules Spec](features/task-rules/TECHNICAL_SPEC.md)
- Add an API endpoint → [Best Practices](BEST_PRACTICES.md#api-design)

**Codebase Structure:**
```
/src
├── app/(app)/                    # User-facing pages
│   ├── head/                    # HEAD role dashboard
│   │   ├── page.tsx             # Command Center
│   │   ├── tasks/               # All Tasks
│   │   ├── rules/               # Task Rules
│   │   ├── analytics/           # Analytics
│   │   └── engine/              # Engine health
│   └── agent/                   # Agent-specific UI
│
├── app/api/                     # API routes
│   ├── tasks/                  # Task endpoints
│   ├── task-rules/             # Rule endpoints
│   ├── dashboard/              # Dashboard data
│   ├── analytics/              # Analytics data
│   └── engine/                 # Engine monitoring
│
├── components/                  # React components
│   ├── head/                   # HEAD dashboard components
│   ├── task-rules/             # Rule builder components
│   ├── shared/                 # Reusable components
│   └── ...                     # Other feature components
│
└── lib/                        # Business logic
    ├── db/                     # Database utilities
    ├── engine/                 # Engine/polling logic
    ├── auth/                   # Authentication
    └── ...                     # Other utilities
```

---

## 🧪 For QA Engineers

**Testing Strategy:**
- [All Tasks Testing Guide](features/all-tasks/TESTING_GUIDE.md)
- [Task Rules Testing Guide](features/task-rules/TESTING_GUIDE.md)
- [Best Practices - Testing](BEST_PRACTICES.md#testing)

**Common Test Scenarios:**
- Creating and filtering tasks
- Rule creation and validation
- SLA calculation and breach detection
- Agent assignment and reassignment

**Manual Testing:**
```bash
# Start dev server
npm run dev

# Access as different roles:
# - Head:       http://localhost:3000/head
# - Agent:      http://localhost:3000/agent
# - Store Admin: http://localhost:3000/store
```

---

## 🔧 For DevOps/System Admins

**Deployment:**
1. [Deployment Guide](DEPLOYMENT_GUIDE.md) - Production setup
2. [Development Setup](DEVELOPMENT_SETUP.md) - Database & migrations
3. [Engine Monitoring](features/engine/TECHNICAL_SPEC.md) - Background processes

**Monitoring & Alerts:**
- Engine health: `/head/engine` or `GET /api/engine/health`
- System logs: Check `/var/log/taskos/`
- Database: Monitor PostgreSQL connection pool

**Troubleshooting:**
- [Engine Troubleshooting](features/engine/TROUBLESHOOTING.md)
- [All Tasks Troubleshooting](features/all-tasks/TROUBLESHOOTING.md)
- [Task Rules Troubleshooting](features/task-rules/TROUBLESHOOTING.md)

---

## 📖 Documentation Organization

```
DOCS/
├── README.md                    (This file - Start here!)
├── ARCHITECTURE.md              (System design)
├── API_REFERENCE.md            (All endpoints)
├── BEST_PRACTICES.md           (Development standards)
├── DEVELOPMENT_SETUP.md        (Local dev)
├── DEPLOYMENT_GUIDE.md         (Production)
│
└── features/                   (Feature-specific docs)
    ├── all-tasks/
    ├── task-rules/
    ├── command-center/
    ├── analytics/
    ├── engine/
    └── teams/
```

Each feature directory contains:
- `README.md` - Feature overview & navigation
- `FEATURE_SPEC.md` - Product requirements
- `TECHNICAL_SPEC.md` - Architecture & design
- `API_ENDPOINTS.md` - API contract
- `TESTING_GUIDE.md` - Test strategy
- `IMPLEMENTATION_ROADMAP.md` - Phases & effort (for features)
- `TROUBLESHOOTING.md` - Common issues

---

## ❓ FAQ

**Q: Where do I find API endpoint documentation?**  
A: [API Reference](API_REFERENCE.md) for all endpoints, or check the specific feature's [API_ENDPOINTS.md](features/*/API_ENDPOINTS.md) file.

**Q: How often does the background engine run?**  
A: Every 5 minutes. See [Engine Documentation](features/engine/).

**Q: What database enums do I need to know about?**  
A: OrderType and OrderStatus. Get them dynamically via:
- `GET /api/order-types`
- `GET /api/order-statuses`

**Q: Can I extend the system with new features?**  
A: Yes! Follow the structure of existing features and read [Best Practices](BEST_PRACTICES.md).

**Q: How are user roles defined?**  
A: OPS_HEAD, STORE_ADMIN, OPS_AGENT. See [Architecture](ARCHITECTURE.md#roles).

---

## 📞 Support & Questions

- **Product Questions**: Contact Abhishek (Product Manager)
- **Technical Questions**: Contact Manjul (Tech Architect)
- **Implementation Questions**: Contact Mayur (Senior Developer)
- **QA & Testing**: Contact Mani (QA Lead)

---

## 📅 Documentation Status

**Last Updated**: May 2, 2026  
**Documentation Version**: 1.1  
**Features Documented**: 6/6 (100%)
- ✅ Command Center
- ✅ All Tasks
- ✅ Task Rules
- ✅ Analytics
- ✅ Engine
- ✅ Teams (NEW)

---

**Start with:** [Architecture Overview](ARCHITECTURE.md) or pick a [Feature](#feature-overview)
