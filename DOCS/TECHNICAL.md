# TaskOS System Architecture

**Architect**: Manjul  
**Last Updated**: May 2, 2026

---

## Table of Contents
1. [System Overview](#system-overview)
2. [Technology Stack](#technology-stack)
3. [Core Components](#core-components)
4. [Data Flow](#data-flow)
5. [Database Design](#database-design)
6. [Security](#security)
7. [Performance](#performance)
8. [Scalability](#scalability)

---

## System Overview

TaskOS is a **task management and automation platform** built for operations teams. It consists of six integrated features:

1. **Command Center** - Real-time operations dashboard
2. **All Tasks** - Task board with filtering and status management
3. **Task Rules** - Rule-based task auto-creation
4. **Teams** - Team member management and roster status control
5. **Analytics** - Performance metrics and reporting
6. **Engine** - Background processing and automation

### Architecture Pattern

```
┌─────────────────────────────────────────┐
│        React Frontend (Browser)          │
│  Components: All Tasks, Rules, Analytics│
└──────────────────┬──────────────────────┘
                   │ (HTTP/REST)
┌──────────────────▼──────────────────────┐
│      Next.js API Server (Backend)        │
│  Route Handlers: /api/*                  │
│  Business Logic: /lib/*                  │
└──────────────────┬──────────────────────┘
                   │ (SQL/ORM)
┌──────────────────▼──────────────────────┐
│      PostgreSQL Database                 │
│  Tables: tasks, rules, orders, users,... │
└──────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  Background Processes (Node.js)          │
│  Poller: Every 5 minutes                 │
│  Services: Rule eval, SLA watch, archive │
└──────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  External API Integration                │
│  Labstack: Order data fetching          │
└──────────────────────────────────────────┘
```

---

## Technology Stack

### Frontend
- **React 19.2.4** - UI components and state management
- **TypeScript 5** - Type-safe JavaScript
- **Next.js 15** - Framework (App Router)
- **Tailwind CSS 4** - Utility-first styling
- **React Hooks** - useState, useCallback, useEffect

### Backend
- **Next.js 15** - API routes and SSR
- **TypeScript 5** - Type-safe backend code
- **Node.js 20+** - JavaScript runtime
- **Express** (via Next.js) - HTTP server
- **Prisma 6.19.3** - ORM for database access
- **Node Cron** - Task scheduling

### Database
- **PostgreSQL 14+** - Relational database
- **Prisma** - ORM for type-safe queries
- **Migrations** - Version control for schema

### External Integrations
- **Labstack API** - Order data and status updates
- **Authentication** - JWT-based session management

---

## Core Components

### Frontend Components

#### 1. Command Center
- **Location**: `/src/app/(app)/head/page.tsx`
- **Purpose**: Real-time operations dashboard
- **Displays**: Task counts, team status, alerts, daily summary
- **Refresh**: Auto-refreshes every 60 seconds

#### 2. All Tasks Board
- **Location**: `/src/app/(app)/head/tasks/page.tsx`
- **Purpose**: Comprehensive task management interface
- **Features**: Filtering, sorting, bulk actions, detail panel
- **Views**: Table (paginated) and Kanban (drag-drop)

#### 3. Task Rules Panel
- **Location**: `/src/app/(app)/head/rules/page.tsx`
- **Purpose**: Create and manage automation rules
- **Features**: Rule builder, validation, audit trail

#### 4. Teams Management
- **Location**: `/src/app/(app)/head/team/page.tsx`
- **Purpose**: Team member management and roster control
- **Features**: 
  - View team members with assignments (order types, stores)
  - Create/edit team members with role assignment
  - Roster status management (ACTIVE/OFF overrides)
  - Performance metrics (task load, SLA compliance)
- **Key Endpoints**: `/api/team/*`, `/api/roster/exception/*`

#### 5. Analytics Dashboard
- **Location**: `/src/app/(app)/head/analytics/page.tsx`
- **Purpose**: Performance metrics and reporting
- **Reports**: Agent performance, daily summary, SLA trends

#### 6. Engine Health Monitor
- **Location**: `/src/app/(app)/head/engine/page.tsx`
- **Purpose**: Monitor background processing status
- **Displays**: Cycle duration, tasks created, error logs

### Backend API Routes

```
/api/
├── tasks/                   # Task queries & updates
│   ├── route.ts            # GET /api/tasks, PATCH /api/tasks
│   ├── filters/schema      # GET available filter options
│   ├── saved-filters       # GET/POST saved filter combinations
│   └── status-distribution # GET count per status
│
├── task-rules/             # Rule management
│   ├── route.ts            # POST/GET rules
│   ├── [id]/route.ts       # PATCH/DELETE rule
│   ├── valid-statuses      # GET valid order statuses
│   ├── metadata-fields     # GET available metadata fields
│   └── [id]/audit-log      # GET rule change history
│
├── team/                   # Team member management
│   ├── route.ts            # GET/POST team members
│   ├── [id]/route.ts       # PATCH team member
│   ├── [id]/order-types/   # GET/POST/DELETE order types
│   └── [id]/stores/        # GET/POST/DELETE store assignments
│
├── roster/                 # Roster management
│   ├── schedule/           # Weekly schedule management
│   ├── exception/          # Daily overrides & exceptions
│   └── daily/              # Daily roster status
│
├── dashboard/              # Command center data
│   └── route.ts            # GET dashboard stats
│
├── analytics/              # Analytics data
│   ├── summary             # Daily KPIs
│   ├── agents              # Agent performance
│   └── sla                 # SLA metrics
│
├── engine/                 # Engine monitoring
│   ├── health              # Current status
│   └── logs                # Processing logs
│
├── orders/                 # Order data
│   └── route.ts            # Order operations
│
└── other/                  # Auth, users, config, etc
```

### Business Logic (Lib)

```
/src/lib/
├── db/
│   ├── client.ts           # Prisma client
│   ├── enums.ts            # Enum utilities (OrderType, OrderStatus)
│   └── migrations/         # Database migrations
│
├── engine/                 # Background processing
│   ├── poller.ts           # Main polling cycle (every 5 min)
│   ├── taskCreator.ts      # Rule evaluation & task creation
│   ├── slaWatcher.ts       # SLA breach detection
│   ├── dailySummary.ts     # Daily metrics aggregation
│   ├── archiveScheduler.ts # Old task cleanup
│   ├── labstack.ts         # Labstack API integration
│   └── ruleAudit.ts        # Audit logging
│
├── auth/                   # Authentication
│   ├── session.ts          # JWT session management
│   └── roles.ts            # Role-based access control
│
└── utils/                  # Utilities
    ├── timezone.ts         # IST/UTC conversion
    ├── formatting.ts       # Date & time formatting
    └── validation.ts       # Input validation
```

---

## Data Flow

### Task Creation Flow

```
1. USER ACTION (Browser)
   ├─ Clicks "New Task" button
   └─ Fills form (title, type, priority, SLA)
        ↓
2. API REQUEST (Frontend)
   ├─ POST /api/tasks with task data
   └─ Request includes JWT auth token
        ↓
3. BACKEND PROCESSING
   ├─ Authenticate user
   ├─ Validate input (title, SLA > 0, etc)
   ├─ Create database record
   └─ Calculate slaDeadline = createdAt + slaMinutes
        ↓
4. API RESPONSE
   ├─ Return TaskWithContext
   └─ Include SLA context & aging info
        ↓
5. FRONTEND UPDATE
   ├─ Update task list
   ├─ Refresh counts widget
   └─ Show confirmation message
```

### Rule Evaluation Flow

```
1. POLLER RUNS (Every 5 minutes)
   └─ src/lib/engine/poller.ts
        ↓
2. LOAD RULES
   ├─ Query: SELECT * FROM TaskRule WHERE isActive = true
   └─ Get all rule definitions
        ↓
3. FOR EACH RULE
   ├─ Fetch orders by orderType from Labstack API
   ├─ For each order:
   │  ├─ Check trigger condition (status, time, metadata)
   │  ├─ If matches:
   │  │  ├─ Check for duplicate task
   │  │  └─ If no duplicate: Create task
   │  └─ Log event
   └─ Update rule metrics
        ↓
4. ADDITIONAL PROCESSES
   ├─ SLA Watcher: Detect breached tasks
   ├─ Daily Summary: Aggregate metrics
   └─ Archive Scheduler: Clean up old tasks
        ↓
5. DATABASE UPDATES
   ├─ INSERT new tasks
   ├─ UPDATE task statuses (breaches)
   └─ INSERT audit logs
        ↓
6. METRICS LOGGED
   ├─ Tasks created count
   ├─ Rules evaluated count
   ├─ Cycle duration
   └─ Error count (if any)
```

---

## Database Design

### Entity Relationship Diagram

```
users (id, name, email, role, ...)
  │
  ├─→ tasks (assignedToId)
  │     └─→ taskTypes (taskTypeId)
  │     └─→ orders (orderId)
  │     └─→ taskRules (assignmentRuleId)
  │
  ├─→ taskRules (createdBy, lastModifiedBy)
  │     ├─→ taskTypes (taskTypeId)
  │     ├─→ taskRuleSkills (join → skillTags)
  │     └─→ escalationChains (escalationChainId)
  │
  └─→ taskRuleAudits (changedById)
       └─→ taskRules (ruleId)

orders (id, ...)
  └─→ tasks (orderId)

taskTypes (id, name, ...)
  ├─→ tasks (taskTypeId)
  └─→ taskRules (taskTypeId)

skillTags (id, name, ...)
  └─→ taskRuleSkills (skillTagId)

escalationChains (id, name, ...)
  └─→ taskRules (escalationChainId)

userSavedFilters (userId, ...)
  └─→ users (userId)
```

### Key Tables

| Table | Rows | Purpose |
|-------|------|---------|
| tasks | ~500K | All tasks (active + completed) |
| orders | ~1M | Order references |
| users | ~1K | System users by role |
| taskRules | ~50 | Automation rules |
| taskRuleAudit | ~1K | Rule change history |
| taskTypes | ~20 | Task type definitions |
| skillTags | ~30 | Required skills |

---

## Security

### Authentication
- **Method**: JWT-based tokens
- **Storage**: HttpOnly cookies
- **Expiry**: 24 hours (configurable)
- **Refresh**: Automatic token refresh on activity

### Authorization
- **Model**: Role-Based Access Control (RBAC)
- **Roles**:
  - **OPS_HEAD** - Full system access
  - **STORE_ADMIN** - Store-scoped access
  - **OPS_AGENT** - Own tasks only
  - **USER** - No system access

### API Security
- All endpoints require authentication
- Role checks at route handler level
- Input validation on all endpoints
- SQL injection prevention (via Prisma ORM)

### Data Protection
- Passwords: Bcrypt hashing
- Sensitive data: Encrypted at rest
- Audit logs: All changes logged with user/timestamp

---

## Performance

### Response Time Targets

| Operation | Target | Current |
|-----------|--------|---------|
| GET /api/tasks | <300ms | ~200ms |
| POST /api/tasks | <100ms | ~80ms |
| PATCH /api/tasks | <100ms | ~75ms |
| Full polling cycle | <5min | ~2-3min |
| Dashboard load | <200ms | ~150ms |

### Database Optimization

**Indices**:
- Task queries: indexed on status, priority, assignedToId, slaDeadline, createdAt
- Rule queries: indexed on orderType, isActive
- Audit queries: indexed on ruleId, createdAt

**Caching Strategy**:
- Filter schema: Cached on client (5-minute TTL)
- Enum values: Cached on client (session duration)
- User roles: Cached on request
- Task list: No server-side cache (always fresh)

### Load Testing

- **Concurrent Users**: 500+ tested
- **Task Volume**: 466+ active tasks tested
- **API Throughput**: 100+ requests/second sustained
- **Database Connections**: Connection pooling (default: 10-20 connections)

---

## Scalability

### Current Capacity
- **Tasks**: 500K+ total (466+ active)
- **Rules**: 50+ rules
- **Users**: 1K+ users
- **Concurrent**: 100+ browser connections

### Scaling Strategies

**Vertical Scaling** (currently):
- Increase server resources
- Increase database resources
- Increase connection pools

**Horizontal Scaling** (future):
- Multiple API server instances
- Load balancer (round-robin)
- Database read replicas
- Cache layer (Redis)
- Message queue (Bull/RabbitMQ) for background jobs

### Database Scaling

**Current**: Single PostgreSQL instance

**Future Improvements**:
- Read replicas for analytics queries
- Connection pooling via PgBouncer
- Table partitioning for large tables (tasks, orders)
- Archive old data to cold storage

---

## Deployment Architecture

### Development
```
localhost:3000
  ├─ Frontend: Next.js dev server
  ├─ Backend: Next.js API routes
  └─ Database: Local PostgreSQL
```

### Production
```
AWS / Cloud Infrastructure
  ├─ Frontend: CDN (CloudFront) + S3
  ├─ API: ECS/EKS (containerized Next.js)
  │   ├─ Load Balancer (ALB)
  │   └─ Auto-scaling group (2-10 instances)
  ├─ Database: RDS PostgreSQL (managed)
  │   ├─ Primary instance
  │   ├─ Standby replica
  │   └─ Read replicas for analytics
  ├─ Cache: ElastiCache (Redis)
  ├─ Monitoring: CloudWatch + Sentry
  └─ Background Jobs: ECS scheduled tasks
```

---

## Integration Points

### External Systems
1. **Labstack API** - Order data and status updates
2. **Notification System** - (Planned) Alerts and reminders
3. **Analytics Platform** - (Planned) Event tracking

### Internal Integrations
- All features share: Task model, User model, Auth system
- Engine integrates with: All Tasks (creates), Task Rules (evaluates), Analytics (logs metrics)

---

## Future Improvements

- [ ] Real-time WebSocket updates (replace polling)
- [ ] Distributed task processing (multiple worker nodes)
- [ ] Advanced caching (Redis)
- [ ] Elasticsearch for full-text search
- [ ] GraphQL API (alongside REST)
- [ ] Mobile app (iOS/Android)
- [ ] Multi-tenant support

---

**Related Docs**:
- [Deployment Guide](DEPLOYMENT_GUIDE.md)
- [Development Setup](DEVELOPMENT_SETUP.md)
- [Best Practices](BEST_PRACTICES.md)
