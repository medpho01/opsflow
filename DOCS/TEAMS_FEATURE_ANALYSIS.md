# TaskOS Teams Feature - Comprehensive Product Analysis

**Date:** May 2, 2026  
**Analysis Scope:** Current user/team structure, skills management, and assignment logic  
**Target:** Feature recommendations for scalable team-based task assignment

---

## PART 1: CURRENT STATE ASSESSMENT

### 1.1 Current User Structure

#### User Model (`/prisma/schema.prisma:70-90`)
```
- id: Int (PK, auto-increment)
- name: String
- email: String (unique)
- phone: String (optional)
- passwordHash: String
- role: UserRole (OPS_HEAD | STORE_ADMIN | OPS_AGENT)
- isActive: Boolean (default: true)
- createdAt: DateTime (default: now)
- updatedAt: DateTime (auto-update)

Relations:
- teamMember: TeamMember? (1:1)
- sessions: Session[] (1:n)
- assignedTasks: Task[] (1:n, via assignedToId)
- taskHistory: TaskHistory[] (1:n)
- notifyLevels: EscalationLevel[] (1:n)
- savedFilters: UserSavedFilter[] (1:n)
- ruleAudits: TaskRuleAudit[] (1:n)
```

**Status:** Currently a basic auth model. User represents both login entity and team member, but team-specific attributes are isolated in the `TeamMember` model.

#### User Roles (Enum)
1. **OPS_HEAD** - Team leader/manager (team management, rule creation, assignment oversight)
2. **STORE_ADMIN** - Store-level manager (basic task reassignment)
3. **OPS_AGENT** - Field agent (task execution, read-only task view)

**Access Control Pattern:**
- OPS_HEAD: Full access to team management, skill assignment, roster
- STORE_ADMIN: Limited task reassignment, some team viewing
- OPS_AGENT: Self-assigned task view only

---

### 1.2 Existing Team/Member Structure

#### TeamMember Model (`/prisma/schema.prisma:125-140`)
```
- id: Int (PK, auto-increment)
- userId: Int (FK -> User.id, unique)
- maxConcurrentTasks: Int (default: 5)
- isActive: Boolean (default: true)
- createdAt: DateTime
- updatedAt: DateTime

Relations:
- user: User (1:1)
- skills: TeamMemberSkill[] (1:n)
- storeAssignments: StoreAssignment[] (1:n)
- dailyRosters: DailyRoster[] (1:n)
- assignedTasks: Task[] (1:n)
```

**Status:** Exists and is properly structured. Acts as bridge between User (auth) and team-specific attributes. Each OPS_AGENT and STORE_ADMIN must have a TeamMember record.

#### StoreAssignment Model (`/prisma/schema.prisma:142-152`)
```
- id: Int (PK)
- teamMemberId: Int (FK)
- storeId: Int (references external labstack public.Store.id)

Constraint: unique(teamMemberId, storeId)
```

**Status:** Enables many-to-many relationship between team members and stores (geographical scoping). Currently used in assignment logic.

#### DailyRoster Model (`/prisma/schema.prisma:176-189`)
```
- id: Int (PK)
- teamMemberId: Int (FK)
- date: DateTime @db.Date
- status: RosterStatus (ACTIVE | ON_FIELD | ON_LEAVE | OFF)
- note: String (optional)
- createdAt: DateTime
- updatedAt: DateTime

Constraint: unique(teamMemberId, date)
```

**Status:** Tracks daily availability. Used by assignment logic to filter eligible agents.

---

### 1.3 Skills Management

#### SkillTag Model (`/prisma/schema.prisma:154-163`)
```
- id: Int (PK, auto-increment)
- name: String (unique, slug format: lowercase with underscores)
- label: String (human-readable label)

Relations:
- skills: TeamMemberSkill[] (1:n)
- taskRules: TaskRuleSkill[] (1:n)
```

**Status:** Well-designed master list. Supports both internal name and user-friendly label.

#### TeamMemberSkill Model (`/prisma/schema.prisma:165-174`)
```
- teamMemberId: Int (FK)
- skillTagId: Int (FK)

Constraint: PK(teamMemberId, skillTagId)
```

**Status:** Junction table for many-to-many relationship. Enables team members to have multiple skills.

#### TaskRuleSkill Model (`/prisma/schema.prisma:253-262`)
```
- taskRuleId: String (FK)
- skillTagId: Int (FK)

Constraint: PK(taskRuleId, skillTagId)
```

**Status:** Defines skill requirements for task rules. Used during assignment to filter agents.

---

### 1.4 Current Assignment Logic

#### Location: `/src/lib/engine/taskCreator.ts:230-280`

**Function:** `pickAssignee(requiredSkillIds: number[], storeId: number | null): Promise<number | null>`

**Current Algorithm:**
1. Load all agents on today's active roster (status: ACTIVE or ON_FIELD)
2. Filter by:
   - User is active and has role OPS_AGENT
   - If storeId provided, agent must have store assignment
   - If requiredSkillIds provided, agent must have ALL required skills
3. Count open tasks per agent (status NOT IN [COMPLETED, CANCELLED])
4. **Return agent with FEWEST open tasks** (least-loaded round-robin)

**Code Excerpt:**
```typescript
async function pickAssignee(
  requiredSkillIds: number[],
  storeId: number | null
): Promise<number | null> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const rosterEntries = await prisma.dailyRoster.findMany({
    where: {
      date: { gte: today, lt: tomorrow },
      status: { in: ["ACTIVE", "ON_FIELD"] },
      member: {
        user: { isActive: true, role: "OPS_AGENT" },
        ...(storeId !== null
          ? { storeAssignments: { some: { storeId } } }
          : {}),
        ...(requiredSkillIds.length > 0
          ? { skills: { some: { skillTagId: { in: requiredSkillIds } } } }
          : {}),
      },
    },
    include: {
      member: {
        include: {
          user: { id: true },
          _count: {
            select: {
              assignedTasks: {
                where: { status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
              },
            },
          },
        },
      },
    },
    orderBy: { member: { user: { id: "asc" } } },
  });

  if (rosterEntries.length === 0) return null;

  // Pick agent with fewest open tasks
  rosterEntries.sort(
    (a, b) => a.member._count.assignedTasks - b.member._count.assignedTasks
  );

  return rosterEntries[0].member.user.id;
}
```

**Status:** Functional but simple. Uses load-based round-robin (least-loaded agent). No priority weighting or skill preference optimization.

---

### 1.5 Task Assignment in Context

#### Task Model (`/prisma/schema.prisma:286-336`)
```
Key assignment fields:
- assignedToId: Int? (FK -> User.id)
- teamMemberId: Int? (FK -> TeamMember.id) — APPEARS UNUSED, exists for future use
- assignedAt: DateTime?
- assignmentMethod: String? ("auto" | "manual" | null)
- assignmentRuleId: String? (which rule auto-assigned it)
```

**Status:** Task can be auto-assigned at creation time (via `createTask()`) or manually reassigned later via PATCH `/api/tasks/[id]`.

#### Assignment Workflow
1. **Automatic (Engine):** During polling, `evaluateAndCreateTasks()` calls `createTask()` → `pickAssignee()` → assigns if eligible agent found
2. **Manual (API):** OPS_HEAD or STORE_ADMIN can PATCH `/api/tasks/[id]` with `assignedToId` to reassign
3. **Task History:** Assignment tracked in `TaskHistory` with change reason and timestamp

---

### 1.6 Existing APIs

#### Team Management

**`GET /api/team`** - List active team members
- Returns: members with skills, store assignments, today's roster status, open task count
- Auth: Authenticated users
- Used in: `/src/components/head/TeamPanel.tsx`
- Location: `/src/app/api/team/route.ts:11-42`

**`POST /api/team`** - Create new team member
- Input: name, email, password, role, storeIds[], skillTagIds[], maxConcurrentTasks
- Auth: OPS_HEAD only
- Returns: newly created user + teamMember record
- Location: `/src/app/api/team/route.ts:44-87`

**`PATCH /api/team/[id]`** - Update team member profile
- Input: name, phone, isActive, maxConcurrentTasks, resetPassword
- Auth: OPS_HEAD only (cannot modify own account)
- Location: `/src/app/api/team/[id]/route.ts`

**`POST /api/team/[id]/skills`** - Assign skill to team member
- Input: skillTagId
- Auth: OPS_HEAD only
- Idempotent (upsert)
- Location: `/src/app/api/team/[id]/skills/route.ts:11-34`

**`DELETE /api/team/[id]/skills`** - Remove skill from team member
- Input: skillTagId
- Auth: OPS_HEAD only
- Location: `/src/app/api/team/[id]/skills/route.ts:36-56`

**`GET /api/roster?date=YYYY-MM-DD`** - View roster for a specific date
- Returns: all team members with roster status, open task count, skills
- Auth: OPS_HEAD only
- Location: `/src/app/api/roster/route.ts:21-71`

**`POST /api/roster`** - Update roster entry for a team member
- Input: teamMemberId, date, status, note
- Auth: OPS_HEAD only
- Upsert (create or update)
- Location: `/src/app/api/roster/route.ts:73-100`

#### Skill Tag Management

**`GET /api/skill-tags`** - List all available skill tags
- Auth: Authenticated users
- Location: `/src/app/api/skill-tags/route.ts:10-16`

**`POST /api/skill-tags`** - Create new skill tag
- Input: name (slug-ified), label (display name)
- Auth: OPS_HEAD only
- Location: `/src/app/api/skill-tags/route.ts:18-32`

#### Task Assignment APIs

**`PATCH /api/tasks/[id]`** - Update task (status, reassign, checklist, notes)
- Input: status, assignedToId, checklistItemId, isDone, note
- Reassignment: OPS_HEAD or STORE_ADMIN only
- Agent can only update their own tasks
- Location: `/src/app/api/tasks/[id]/route.ts:45-150`

---

### 1.7 Existing UI Components

#### TeamPanel.tsx (`/src/components/head/TeamPanel.tsx`)
- **Purpose:** Manage team members, assign skills, update availability, set max tasks
- **Features:**
  - Edit drawer for member details
  - Skill assignment UI
  - Store assignment UI
  - Password reset
  - Member activation/deactivation
- **Auth:** Used in OPS_HEAD dashboard

#### Roster Management UI
- **Location:** `/src/app/(app)/head/roster/page.tsx`
- **Purpose:** Daily roster management (ACTIVE, ON_FIELD, ON_LEAVE, OFF)
- **Features:** Date-based roster view, bulk status updates

#### Team List UI
- **Location:** `/src/app/(app)/head/team/page.tsx`
- **Purpose:** Team member list and management entry point

---

## PART 2: GAP ANALYSIS

### 2.1 What's Missing

#### 1. Team Hierarchy & Structure
- **Current:** Flat structure (User → TeamMember)
- **Missing:**
  - No team grouping (e.g., "North Region", "Hyderabad Store Team")
  - No sub-teams or squads
  - No role-based team permissions (e.g., team lead can manage only their team)
  - No team-level analytics or KPIs

#### 2. Skills Management Gaps
- **Current:** Binary skill presence (has/doesn't have)
- **Missing:**
  - No skill proficiency levels (e.g., Junior, Mid, Expert)
  - No skill certification dates or expiry
  - No skill deprecation tracking
  - No skill hierarchy or dependencies (e.g., "Advanced Phlebotomy" requires "Basic Phlebotomy")
  - No skill verification or training records

#### 3. Advanced Assignment Logic
- **Current:** Simple least-loaded round-robin with skill matching
- **Missing:**
  - Skill preference weighting (prefer expert for complex tasks)
  - Availability scheduling (shift-based assignment)
  - Geographic optimization (prefer nearby agents)
  - Task affinity (re-assign to same agent for continuity)
  - Load balancing by task complexity, not just count
  - Fairness metrics (prevent overloading high-performers)
  - Dead-letter queue for unassignable tasks
  - Auto-assignment retry logic

#### 4. Team Capacity & Planning
- **Current:** Individual maxConcurrentTasks only
- **Missing:**
  - Team-level capacity planning
  - Forecasting based on order volume
  - Workload prediction
  - Shift planning UI
  - Vacation/leave management
  - Overtime tracking

#### 5. Performance & Analytics
- **Current:** Basic open task count
- **Missing:**
  - Agent productivity metrics (tasks completed per hour)
  - SLA compliance per agent
  - Skill utilization (% of assigned tasks using their skills)
  - Team capacity utilization
  - Task cycle time analytics
  - Agent availability analytics
  - Custom dashboards

#### 6. Audit & Governance
- **Current:** Basic creation/update timestamps
- **Missing:**
  - Skill assignment audit trail (who added/removed skill, when, why)
  - Team membership audit (who joined/left team, when)
  - Reassignment audit trail (who reassigned, from whom, to whom, reason)
  - Compliance reporting
  - Data retention policies

#### 7. Integration & Workflows
- **Current:** Manual team member creation
- **Missing:**
  - Bulk user import (CSV, API)
  - SSO/LDAP integration
  - Webhook notifications for team changes
  - Team member lifecycle workflows (onboarding, offboarding)
  - Integration with HR systems

#### 8. API & Scalability
- **Current:** Basic CRUD APIs
- **Missing:**
  - Bulk skill assignment
  - Batch roster updates
  - Query optimization for large teams (1000+)
  - Caching strategy
  - Rate limiting
  - API pagination optimization

---

### 2.2 Database Scalability Concerns

| Issue | Current | Impact at 1000+ Members |
|-------|---------|------------------------|
| **N+1 queries in team list** | GET /api/team includes nested skills, stores | Could cause 1000+ additional queries |
| **Skill matching in assignment** | Loads all roster entries, filters in memory | Large IN clauses, full table scans |
| **Daily roster query** | Queries dailyRosters every assignment | Heavy on roster date indexes |
| **Store assignment filter** | Uses SOME relation in nested query | Index needed on (teamMemberId, storeId) |
| **Task count aggregation** | _count in nested include | Expensive for agents with 100+ tasks |

---

## PART 3: FEATURE RECOMMENDATIONS

### 3.1 Core Features (Phase 1 - MVP)

#### Feature 1.1: Team Grouping & Organization
**Priority:** High  
**Effort:** Medium

**Description:** Allow organizing agents into named teams with team leads

**Components:**
- Team model (id, name, description, leaderId, isActive)
- TeamMembership model (teamId, memberId, joinedAt)
- Relationship: User → Teams (many-to-many via TeamMembership)

**Benefits:**
- Cleaner organizational structure
- Foundation for team-level permissions
- Enables team-specific dashboards

**Integration Points:**
- Assignment: Filter eligible agents from specific team(s)
- Dashboard: Team-level KPIs
- Roster: Team-focused roster management

---

#### Feature 1.2: Skill Proficiency Levels
**Priority:** High  
**Effort:** Low

**Description:** Add proficiency levels to skills (ENTRY, INTERMEDIATE, EXPERT)

**Changes to TeamMemberSkill:**
```
Current:
- teamMemberId (PK)
- skillTagId (PK)

Add:
- proficiencyLevel: Enum (ENTRY | INTERMEDIATE | EXPERT)
- certifiedAt: DateTime (when certified at this level)
- expiresAt: DateTime? (for recertification requirements)
```

**Benefits:**
- More intelligent skill matching
- Can require "EXPERT" level for complex tasks
- Tracks skill recertification dates

---

#### Feature 1.3: Advanced Assignment Engine
**Priority:** High  
**Effort:** High

**Description:** Intelligent task assignment with multiple factors

**New Assignment Algorithm:**
```
Input:
  - requiredSkillIds (with minimum proficiency levels)
  - taskPriority (URGENT, HIGH, MEDIUM, LOW)
  - taskComplexity (SIMPLE, MEDIUM, COMPLEX)
  - preferenceType (LEAST_LOADED, SKILL_MATCH, BALANCED)

Process:
1. Filter eligible agents:
   - On roster (ACTIVE, ON_FIELD)
   - Below maxConcurrentTasks
   - Have required skills at minimum proficiency
   - Within store assignment (if specified)

2. Score each agent:
   - Load factor: openTasks / maxConcurrentTasks (0-1)
   - Skill match: % of expert skills for this task type
   - SLA compliance: recent task completion rate
   - Experience: avg task cycle time
   - Fairness: recent assignment history

3. Select based on preferenceType:
   - LEAST_LOADED: weight by load only
   - SKILL_MATCH: weight by skill proficiency
   - BALANCED: weighted combination

4. Return top candidate or NULL if none qualified

Error handling:
- No eligible agent → add to dead-letter queue
- Alert escalation if unassigned >30m
```

**Implementation Location:** New file `/src/lib/engine/assignmentEngine.ts`

**Benefits:**
- More sophisticated matching
- Reduces manual reassignments
- Better SLA compliance
- Fair workload distribution

---

#### Feature 1.4: Availability Scheduling
**Priority:** Medium  
**Effort:** Medium

**Description:** Time-based availability beyond just daily roster

**New Model: AgentAvailability**
```
- id: Int (PK)
- teamMemberId: Int (FK)
- dayOfWeek: Int (0-6)
- startTime: Time (e.g., 09:00)
- endTime: Time (e.g., 17:00)
- timezone: String (e.g., Asia/Kolkata)
```

**Additional Enhancement: ShiftPattern**
```
- id: Int (PK)
- name: String (e.g., "Morning Shift", "Weekend Flex")
- teamId: Int (FK)
- rules: Json (cron-like recurring pattern)
```

**Benefits:**
- Assign agents only during their working hours
- Support for shift-based teams
- Foundation for overtime tracking

---

#### Feature 1.5: Skill-Based Task Rule Configuration
**Priority:** High  
**Effort:** Low

**Description:** Allow rules to specify skill requirements with proficiency levels

**Add to TaskRule:**
```
- skillRequirements: Json
  Example: [
    { skillId: 1, minProficiency: "INTERMEDIATE", required: true },
    { skillId: 2, minProficiency: "ENTRY", required: false }
  ]
```

**Benefits:**
- Rules define skill needs explicitly
- Enables proficiency-based filtering
- Audit trail of what skills were required

---

### 3.2 Enhancement Features (Phase 2)

#### Feature 2.1: Bulk Team Operations
- Bulk skill assignment (CSV import)
- Batch roster updates
- Bulk agent activation/deactivation

#### Feature 2.2: Team Analytics Dashboard
- Agent productivity (tasks/hour)
- SLA compliance rates
- Skill utilization metrics
- Capacity heatmaps

#### Feature 2.3: Audit & Compliance
- Skill assignment audit trail
- Team membership changes log
- Reassignment history with reasons
- Compliance export

#### Feature 2.4: Leave & Vacation Management
- Leave request workflow
- Automatic roster updates
- Coverage planning

---

### 3.3 Advanced Features (Phase 3+)

#### Feature 3.1: Task Affinity & Continuity
- Track which agent completed previous order task
- Prefer same agent for follow-ups

#### Feature 3.2: Geographic Optimization
- Agent location tracking
- Prefer nearby agents for same-day tasks
- Route optimization

#### Feature 3.3: ML-Based Assignment
- Learn assignment patterns
- Predict optimal assignments
- Detect assignment anomalies

#### Feature 3.4: Integration APIs
- SSO/LDAP integration
- Webhook notifications for team changes
- HR system integration

---

## PART 4: DATABASE SCHEMA CHANGES

### 4.1 New Models to Add

#### Team Model
```prisma
model Team {
  id           Int      @id @default(autoincrement())
  name         String   @unique
  description  String?
  leaderId     Int?     // FK to User (OPS_HEAD or OPS_AGENT with lead role)
  isActive     Boolean  @default(true)
  storeIds     Json?    // JSON array of associated store IDs (optional scoping)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  lead         User?           @relation("TeamLead", fields: [leaderId], references: [id], onDelete: SetNull)
  members      TeamMembership[] 
  
  @@map("teams")
}

model TeamMembership {
  id           Int      @id @default(autoincrement())
  teamId       Int
  memberId     Int       // FK to TeamMember, not User
  joinedAt     DateTime @default(now())
  leftAt       DateTime?
  
  team         Team       @relation(fields: [teamId], references: [id], onDelete: Cascade)
  member       TeamMember @relation(fields: [memberId], references: [id], onDelete: Cascade)
  
  @@unique([teamId, memberId])
  @@map("team_memberships")
}
```

#### Availability Scheduling
```prisma
model AgentAvailability {
  id             Int      @id @default(autoincrement())
  teamMemberId   Int
  dayOfWeek      Int      // 0-6 (Mon-Sun)
  startTime      String   // HH:mm format
  endTime        String   // HH:mm format
  timezone       String   @default("Asia/Kolkata")
  isRecurring    Boolean  @default(true)
  createdAt      DateTime @default(now())
  
  member         TeamMember @relation(fields: [teamMemberId], references: [id], onDelete: Cascade)
  
  @@unique([teamMemberId, dayOfWeek])
  @@map("agent_availabilities")
}

model ShiftPattern {
  id           Int      @id @default(autoincrement())
  name         String
  description  String?
  teamId       Int?     // Optional team-level pattern
  rules        Json     // Cron-like rules
  isActive     Boolean  @default(true)
  createdAt    DateTime @default(now())
  
  @@map("shift_patterns")
}
```

### 4.2 Modified Models

#### Update TeamMemberSkill
```prisma
model TeamMemberSkill {
  teamMemberId     Int
  skillTagId       Int
  proficiencyLevel String @default("ENTRY") // ENTRY | INTERMEDIATE | EXPERT
  certifiedAt      DateTime?
  expiresAt        DateTime?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  teamMember       TeamMember @relation(fields: [teamMemberId], references: [id], onDelete: Cascade)
  skillTag         SkillTag   @relation(fields: [skillTagId], references: [id], onDelete: Cascade)

  @@id([teamMemberId, skillTagId])
  @@index([expiresAt])  // For finding expired certifications
  @@map("team_member_skills")
}
```

#### Add to TeamMember
```prisma
model TeamMember {
  // ... existing fields ...
  
  // NEW:
  availabilities   AgentAvailability[]
  teamMemberships  TeamMembership[]
  
  // ... existing relations ...
}
```

#### Update Task (tracking)
```prisma
model Task {
  // ... existing fields ...
  
  // NEW: For better assignment auditing
  previousAssigneeId    Int?          // Who had it before current assignment
  reassignmentReason    String?       // Why was it reassigned
  assignmentAttempts    Int @default(0)  // How many times assignment was attempted
  lastAssignmentAttempt DateTime?     // When last attempted to assign
  
  // ... rest of fields ...
}
```

### 4.3 Indexes to Add (Performance)

```prisma
// In TeamMember
@@index([isActive])
@@index([maxConcurrentTasks])

// In TeamMemberSkill
@@index([teamMemberId])
@@index([skillTagId])
@@index([proficiencyLevel])
@@index([expiresAt(sort: Asc)])  // Find expiring certifications

// In DailyRoster
@@index([date])
@@index([status])
@@index([teamMemberId, date])  // For daily queries

// In StoreAssignment
@@index([teamMemberId])
@@index([storeId])

// In Task
@@index([assignedToId, status])  // For agent workload queries
@@index([status, createdAt])     // For unassigned task queries
```

---

## PART 5: API CHANGES & NEW ENDPOINTS

### 5.1 New Team Management APIs

#### POST /api/teams
**Create a new team**
```
Input:
  {
    name: string (required)
    description: string (optional)
    leaderId: number (optional, OPS_HEAD user id)
    storeIds: number[] (optional)
  }

Output:
  { id, name, description, leaderId, isActive, createdAt }

Auth: OPS_HEAD only
```

#### GET /api/teams
**List all teams with member count**
```
Query params:
  - isActive: boolean (optional)
  - leaderId: number (optional, filter by team lead)

Output:
  {
    teams: [
      {
        id, name, description, leaderId, memberCount, storeIds, isActive, createdAt
      }
    ]
  }

Auth: OPS_HEAD or team member
```

#### GET /api/teams/[id]
**Get team details with members**
```
Output:
  {
    team: {
      id, name, description, leaderId, isActive,
      members: [
        {
          id, userId, name, email, phone, skills, storeIds,
          maxConcurrentTasks, rosterStatus, openTaskCount
        }
      ]
    }
  }

Auth: Team member or OPS_HEAD
```

#### POST /api/teams/[id]/members
**Add member to team**
```
Input:
  { memberId: number }

Auth: Team lead or OPS_HEAD
```

#### DELETE /api/teams/[id]/members/[memberId]
**Remove member from team**
```
Auth: Team lead or OPS_HEAD
```

### 5.2 Enhanced Skill APIs

#### POST /api/team/[id]/skills
**Enhanced skill assignment with proficiency**
```
Input:
  {
    skillTagId: number,
    proficiencyLevel: "ENTRY" | "INTERMEDIATE" | "EXPERT",
    expiresAt: DateTime (optional)
  }

Auth: OPS_HEAD
```

#### GET /api/team/[id]/skills
**Get agent's skills with proficiency levels**
```
Output:
  {
    skills: [
      {
        id, skillTag: { id, name, label },
        proficiencyLevel, certifiedAt, expiresAt, expirationDaysRemaining
      }
    ]
  }

Auth: Authenticated
```

### 5.3 Assignment API

#### POST /api/assignments/recommend
**Get assignment recommendation for a task**
```
Input:
  {
    requiredSkillIds: number[] (with proficiency levels),
    taskPriority: string,
    taskComplexity: string,
    storeId: number,
    preferenceType: "LEAST_LOADED" | "SKILL_MATCH" | "BALANCED"
  }

Output:
  {
    recommendedAgentId: number | null,
    alternativeAgents: [
      { agentId, score, reasons }
    ],
    noAgentReason: string (if null)
  }

Auth: OPS_HEAD, STORE_ADMIN
```

#### POST /api/assignments/batch
**Assign multiple tasks at once**
```
Input:
  {
    taskIds: number[],
    assignmentStrategy: "ROUND_ROBIN" | "SKILL_BASED" | "LOAD_BALANCED"
  }

Output:
  {
    assigned: [{ taskId, assignedToId, agentName }],
    unassigned: [{ taskId, reason }]
  }

Auth: OPS_HEAD
```

### 5.4 Availability APIs

#### POST /api/availability/[memberId]
**Set member availability schedule**
```
Input:
  [
    {
      dayOfWeek: number,
      startTime: string,
      endTime: string,
      timezone: string
    }
  ]

Auth: Agent self or OPS_HEAD
```

#### GET /api/availability/[memberId]
**Get member's availability schedule**
```
Output:
  {
    availability: [
      { dayOfWeek, startTime, endTime, timezone }
    ]
  }

Auth: Authenticated
```

---

## PART 6: UI/UX COMPONENTS REQUIRED

### 6.1 Team Management Components

| Component | Location | Purpose |
|-----------|----------|---------|
| **TeamList** | `/src/components/head/TeamList.tsx` | Display all teams with expand/collapse |
| **TeamForm** | `/src/components/head/TeamForm.tsx` | Create/edit team details |
| **TeamMemberManager** | `/src/components/head/TeamMemberManager.tsx` | Add/remove members from team |
| **TeamLeadSelector** | `/src/components/shared/TeamLeadSelector.tsx` | Dropdown/modal to select team lead |

### 6.2 Skills Management Components

| Component | Location | Purpose |
|-----------|----------|---------|
| **SkillProficiencySelector** | `/src/components/shared/SkillProficiencySelector.tsx` | Select skill + proficiency level |
| **SkillMatrix** | `/src/components/head/SkillMatrix.tsx` | Grid showing members → skills with proficiency |
| **SkillGapAnalysis** | `/src/components/head/SkillGapAnalysis.tsx` | Identify skill gaps in team |
| **SkillCertificationTracker** | `/src/components/head/SkillCertificationTracker.tsx` | Track expiring certifications |

### 6.3 Assignment & Capacity Components

| Component | Location | Purpose |
|-----------|----------|---------|
| **AssignmentRecommender** | `/src/components/task/AssignmentRecommender.tsx` | Show recommended assignees with scoring |
| **TeamCapacityHeatmap** | `/src/components/head/TeamCapacityHeatmap.tsx` | Visual capacity utilization by agent |
| **AvailabilityScheduler** | `/src/components/head/AvailabilityScheduler.tsx` | Set shift schedules |
| **WorkloadBalancer** | `/src/components/head/WorkloadBalancer.tsx` | Visual reassignment interface |

### 6.4 Pages

| Page | Location | Purpose |
|------|----------|---------|
| **Teams Hub** | `/src/app/(app)/head/teams/page.tsx` | Central team management page |
| **Team Detail** | `/src/app/(app)/head/teams/[id]/page.tsx` | Team view + member management |
| **Skills Dashboard** | `/src/app/(app)/head/skills/page.tsx` | Org-wide skill view |
| **Capacity Planning** | `/src/app/(app)/head/capacity/page.tsx` | Team capacity and forecasting |

---

## PART 7: ASSIGNMENT LOGIC PROPOSAL

### 7.1 Round-Robin with Skill Matching (Current)

**Algorithm:**
```
Eligible agents = all agents:
  - On roster (ACTIVE, ON_FIELD)
  - Below maxConcurrentTasks
  - Have all required skills
  - Assigned to correct store

Selected agent = agent with minimum openTaskCount
```

**Characteristics:**
- Simple, predictable
- Fair distribution by load
- No skill preference
- No complexity consideration

**Use Case:** Commodity tasks with clear skill requirements

---

### 7.2 Skill-Based Weighted Assignment (Proposed)

**Algorithm:**
```
Eligible agents = same filter as above

Score each agent:
  score = (1 - loadFactor) * 0.3 + skillMatch * 0.5 + slaCompliance * 0.2

  where:
    loadFactor = openTasks / maxConcurrentTasks
    skillMatch = % of required skills at EXPERT or INTERMEDIATE level
    slaCompliance = % of recently completed tasks without SLA breach

Sort by score (descending)
Return top agent
```

**Characteristics:**
- Balances load with skill quality
- Prefers specialists for complex work
- SLA-aware
- More intelligent but slightly slower

**Use Case:** Complex tasks where skill quality matters

---

### 7.3 Skill Expertise with Fallback (Advanced)

**Algorithm:**
```
Define task complexity: SIMPLE, MEDIUM, COMPLEX

Tier 1 (COMPLEX tasks):
  - Only match EXPERT level skills
  - Filter by: skillMatch >= 70%
  - Select lowest loadFactor

Tier 2 (MEDIUM tasks):
  - Match INTERMEDIATE or EXPERT
  - Filter by: skillMatch >= 50%
  - Select weighted by skill & load

Tier 3 (SIMPLE tasks):
  - Match ENTRY or higher
  - Filter by: has required skills
  - Select by load only

Fallback (all tiers):
  - If no match, return NULL and alert escalation
```

**Characteristics:**
- Task complexity-aware
- Expert protection (saves experts for hard work)
- Explicit fallback handling
- More complex to configure

**Use Case:** Mixed-complexity workloads with skill diversity

---

### 7.4 Implementation Strategy

**Phase 1 (MVP):** Keep current least-loaded algorithm, add skill proficiency data collection

**Phase 2:** Implement skill-based weighted assignment with configuration

**Phase 3:** Add task complexity scoring and tier-based assignment

**Configuration (in database):**
```
TaskRule:
  assignmentStrategy: "LEAST_LOADED" | "SKILL_WEIGHTED" | "SKILL_TIERED"
  preferredProficiency: "ENTRY" | "INTERMEDIATE" | "EXPERT"
  minimumSkillMatch: number (0-100)
```

---

## PART 8: SCALABILITY PLAN

### 8.1 Database Optimization

#### Current Bottlenecks (at 1000+ members)

| Query | Issue | Solution |
|-------|-------|----------|
| GET /api/team (member list) | N+1 skills/stores | Batch load in 1 query with aggregation |
| pickAssignee (assignment) | Nested SOME filters | Use dedicated stored procedure |
| DailyRoster filter | Full table scan on date | Add composite index on (date, status) |
| Task count per agent | COUNT in nested query | Maintain denormalized count column |

#### Index Strategy
```prisma
// Priority 1: Assignment queries
@@index([status, createdAt])  // For roster queries
@@index([teamMemberId, date])  // Daily roster lookups

// Priority 2: Workload calculations
@@index([assignedToId, status])  // Agent task count
@@index([skillTagId])  // Skill filtering

// Priority 3: Reporting
@@index([createdAt])  // Auditing
@@index([expiresAt])  // Certification tracking
```

### 8.2 Query Optimization

#### Batch Load Pattern
```typescript
// Instead of N+1:
const members = await prisma.user.findMany({
  include: {
    teamMember: {
      include: { skills: true, storeAssignments: true }
    }
  }
})

// Use aggregation:
const teams = await prisma.teamMembership.groupBy({
  by: ['teamId'],
  _count: { memberId: true },
  _max: { joinedAt: true }
})
```

#### Prepared Statements for Assignment
```sql
-- Stored procedure: FindEligibleAgents(requiredSkillIds, storeId, date)
-- Returns agents with open task count, sorted by load
-- Single query instead of multi-step filter
```

### 8.3 Caching Strategy

#### Redis Cache Layers
```
1. Skill tags (TTL: 1 hour)
   Key: "skill_tags:all"
   Invalidate on: new skill created, skill updated

2. Daily roster (TTL: 15 minutes)
   Key: "roster:{date}:{status}"
   Invalidate on: roster entry changed

3. Agent availability (TTL: 1 hour)
   Key: "availability:{memberId}"
   Invalidate on: availability changed

4. Team membership (TTL: 30 minutes)
   Key: "team:{teamId}:members"
   Invalidate on: member added/removed
```

#### Cache Invalidation
```typescript
// On roster update:
await redis.del(`roster:${date}:ACTIVE`)
await redis.del(`roster:${date}:ON_FIELD`)

// On skill assignment:
await redis.del(`availability:${memberId}`)
await redis.del(`team:${teamId}:members`)
```

### 8.4 Load Testing Benchmarks

Target performance at 1000+ members:

| Operation | Target | Current |
|-----------|--------|---------|
| GET /api/team (list all) | <1000ms | ~500ms (needs optimization) |
| GET /api/roster?date=X | <500ms | ~300ms (OK) |
| Assignment pick (pickAssignee) | <100ms | ~200ms (needs stored proc) |
| Bulk roster update (100 entries) | <2000ms | Untested (need implement) |

### 8.5 Horizontal Scaling

#### Stateless API Design
- No in-memory assignment state
- All decisions made from DB queries
- Cache can be externalized to Redis

#### Database Read Replicas
```
Primary DB: Write operations
Read Replica 1: GET /api/team, /api/roster
Read Replica 2: GET /api/skill-tags, /api/availability

Assignment queries: Acceptable to use replica (eventual consistency OK)
```

#### Polling Architecture (unchanged)
- Polling still single-threaded (via PollingLock)
- Assignment happens in memory within polling job
- No new concurrency concerns

---

## PART 9: IMPLEMENTATION PRIORITIES

### Phase 1 (MVP - Weeks 1-4)
**Goal:** Enable basic team organization with skill-based assignment

1. **Database (Week 1)**
   - Add Team model
   - Add TeamMembership model
   - Update TeamMemberSkill with proficiencyLevel
   - Create necessary indexes

2. **API (Week 1-2)**
   - Team CRUD endpoints
   - Enhanced skill assignment API with proficiency
   - GET endpoints for team listing/details

3. **Assignment Engine (Week 2-3)**
   - Add proficiency validation to pickAssignee
   - Implement skill-weighted scoring
   - Add configuration to TaskRule

4. **UI (Week 3-4)**
   - Team list component
   - Team form (create/edit)
   - Enhanced skill selector with proficiency
   - Team dashboard page

5. **Testing & Optimization (Week 4)**
   - Unit tests for assignment logic
   - Integration tests for APIs
   - Performance baseline at 200+ members

---

### Phase 2 (Advanced Features - Weeks 5-8)
**Goal:** Add capacity planning, availability scheduling, analytics

1. **Availability Scheduling (Week 5)**
   - AgentAvailability model
   - Availability API endpoints
   - Availability scheduler UI

2. **Team Analytics (Week 6-7)**
   - Agent productivity metrics
   - SLA compliance tracking
   - Skill utilization dashboard
   - Capacity heatmap

3. **Audit & Compliance (Week 7-8)**
   - Skill assignment audit trail
   - Team membership change log
   - Compliance reporting page
   - Export functionality

---

### Phase 3 (Enterprise Features - Weeks 9+)
**Goal:** Advanced assignment, integrations, ML features

1. **Advanced Assignment (Week 9-10)**
   - Tier-based assignment strategy
   - Task affinity tracking
   - Dead-letter queue for unassignable tasks
   - Auto-retry mechanism

2. **Bulk Operations (Week 10-11)**
   - CSV import for team members
   - Bulk skill assignment
   - Batch roster updates
   - Bulk leave management

3. **Integrations (Week 11-12)**
   - SSO/LDAP support
   - HR system integration
   - Webhook notifications
   - API rate limiting

4. **ML Features (Post-Week 12)**
   - Assignment prediction model
   - Anomaly detection
   - Workload forecasting
   - Churn prediction

---

### Effort Estimate

| Feature | Phase | Story Points |
|---------|-------|--------------|
| Team Model & CRUD | 1 | 5 |
| Skill Proficiency | 1 | 3 |
| Enhanced Assignment | 1 | 8 |
| Team UI Components | 1 | 8 |
| Availability Scheduling | 2 | 8 |
| Analytics Dashboard | 2 | 13 |
| Audit Trail | 2 | 5 |
| Bulk Operations | 3 | 8 |
| Integrations | 3 | 13 |
| ML Features | 3+ | 21+ |

**Phase 1 Total:** ~24 SP (3 weeks for 2-person team)

---

## PART 10: RISK ASSESSMENT & MITIGATION

### 10.1 Technical Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **Assignment query timeout at scale** | High | Implement stored procedure + redis cache |
| **Data inconsistency with bulk updates** | Medium | Transaction wrappers, audit logging |
| **Skill proficiency data quality** | Medium | Validation rules, certification workflow |
| **Complex migration from flat to team structure** | Medium | Gradual rollout, "default team" for existing users |

### 10.2 Product Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **Over-engineering before product-market fit** | Medium | MVP focuses on core features only |
| **User adoption of new team model** | Medium | Training materials, UI guidance, gradual rollout |
| **Complex assignment rules confuse users** | Low | Sensible defaults, clear configuration UI |

### 10.3 Operational Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **Skill data becomes stale** | Low | Expiration tracking, audit alerts |
| **Unassignable tasks queue grows** | Medium | Daily alert if unassigned >1 hour |
| **Team lead workload increases** | Low | Bulk operations, reporting automation |

---

## SUMMARY TABLE: Current vs. Proposed

| Dimension | Current State | Phase 1 (Proposed) | Benefit |
|-----------|-------|--------|---------|
| **Team Structure** | Flat (User → TeamMember) | Organized (User → Teams → TeamMembers) | Scalable, grouped teams |
| **Skills** | Binary (has/doesn't) | Proficiency levels + expiry | Better matching, compliance |
| **Assignment** | Least-loaded + skills | Weighted by skill + load + SLA | More intelligent |
| **Capacity** | Per-agent maxTasks | Per-agent + team capacity | Better planning |
| **Availability** | Daily roster only | Shift-based scheduling | More flexibility |
| **Analytics** | Open task count | Productivity, SLA, skill metrics | Data-driven decisions |
| **Audit** | Creation timestamps | Full audit trail | Compliance, debugging |
| **Scalability** | ~100-200 members | 1000+ members | Enterprise-ready |

---

## FILES REFERENCED IN ANALYSIS

### Database
- `/Users/maverick/Documents/TaskOs/prisma/schema.prisma` — Prisma schema (User, TeamMember, SkillTag, Task models)

### Assignment Logic
- `/Users/maverick/Documents/TaskOs/src/lib/engine/taskCreator.ts` — Task creation and `pickAssignee()` function

### APIs
- `/Users/maverick/Documents/TaskOs/src/app/api/team/route.ts` — Team list and create
- `/Users/maverick/Documents/TaskOs/src/app/api/team/[id]/route.ts` — Team member update
- `/Users/maverick/Documents/TaskOs/src/app/api/team/[id]/skills/route.ts` — Skill assignment
- `/Users/maverick/Documents/TaskOs/src/app/api/roster/route.ts` — Roster management
- `/Users/maverick/Documents/TaskOs/src/app/api/skill-tags/route.ts` — Skill tag CRUD
- `/Users/maverick/Documents/TaskOs/src/app/api/tasks/[id]/route.ts` — Task update (assignment)

### UI Components
- `/Users/maverick/Documents/TaskOs/src/components/head/TeamPanel.tsx` — Team member editor
- `/Users/maverick/Documents/TaskOs/src/app/(app)/head/team/page.tsx` — Team list page
- `/Users/maverick/Documents/TaskOs/src/app/(app)/head/roster/page.tsx` — Roster management page

### Types
- `/Users/maverick/Documents/TaskOs/src/types/index.ts` — TypeScript interfaces (TeamMemberStatus, TaskRuleWithRelations)

---

## CONCLUSION

TaskOS has a solid **foundation** for team management with existing TeamMember, SkillTag, and basic assignment logic. The current system supports up to 100-200 team members effectively.

**Key strengths:**
- TeamMember model properly separates auth (User) from team attributes
- Skill matching already integrated into assignment logic
- Daily roster provides availability basis
- Store assignment enables multi-location teams

**Key gaps:**
- No team grouping/hierarchy
- Skills lack proficiency levels and expiry
- Assignment logic is simple (least-loaded only)
- No advanced analytics or audit trails
- Database not optimized for 1000+ members

**Recommended approach:**
1. **Phase 1 (4 weeks):** Add teams, skill proficiency, and weighted assignment
2. **Phase 2 (4 weeks):** Add availability scheduling and analytics
3. **Phase 3+ (ongoing):** Advanced features based on user feedback

This phased approach allows rapid time-to-value while building a scalable, enterprise-ready foundation.

