# Teams Feature - Product Specification

**Feature**: Comprehensive Team Member Management  
**Version**: 2.0 (Complete Implementation)  
**Status**: ✅ Fully Implemented  
**Last Updated**: May 3, 2026

---

## Overview

The Teams feature provides complete team member lifecycle management with role-based configuration, order type and store assignments, weekly schedule configuration, and real-time roster status management.

**Core Capabilities:**
- ✅ Create and manage team members with email, password, and role assignment
- ✅ Edit team member profiles (name, phone, role, max concurrent tasks, account status)
- ✅ Configure order type assignments (HOME_SAMPLE, CENTER_VISIT, INJECTION)
- ✅ Manage store access and assignments
- ✅ Set up weekly working schedules with break times
- ✅ Override roster status for specific dates
- ✅ View performance metrics and task statistics
- ✅ Real-time roster status tracking and analytics

---

## Main Interface: Team Panel (/head/team)

### Overview
Central dashboard for all team member operations combining member list, analytics, and inline management.

### Layout Structure
```
┌─────────────────────────────────────────────┐
│ HEADER: "Team" + Add Member Button          │
├─────────────────────────────────────────────┤
│ ANALYTICS: Active: 5  |  Off: 3              │
├─────────────────────────────────────────────┤
│ GRID VIEW (Responsive: 1-3 columns)         │
│                                              │
│ ┌─ Member Card ──────────┐                  │
│ │ [Avatar] Name (Role)   │ [Edit] [Status]  │
│ │ Status: ACTIVE         │                  │
│ │ Load: 3/5 ▓▓░░░        │                  │
│ │ Skills: [Skill1] [+2]   │                  │
│ │ Stores: 4              │                  │
│ │ [Status Override Button]│                  │
│ └────────────────────────┘                  │
│                                              │
└─────────────────────────────────────────────┘
```

### Key Features

#### 1. Roster Analytics Section
Shows live counts of team availability:
- **Active**: Members currently scheduled and within working hours
- **Off**: Members not scheduled or outside working hours
- Color-coded: Green for Active, Gray for Off
- Updates automatically when status overrides are changed

#### 2. Member Cards Grid
Displays each team member with:
- **Member Info**: Avatar initial, full name, role badge (OPS_AGENT/STORE_ADMIN)
- **Roster Status**: Visual indicator (green dot = ACTIVE, gray dot = OFF)
- **Status Text**: Current status (ACTIVE, OFF, ON_LEAVE, SICK)
- **Task Load**: Progress bar showing current/max concurrent tasks
  - Green: <60%, Orange: 60-80%, Red: >80%
- **Skills**: Display first 2 skills + count of additional
- **Store Count**: Number of assigned stores
- **Action Buttons**:
  - Edit button (pencil icon) → Opens EditDrawer
  - Status override button (context-aware)

#### 3. Status Override Buttons
Three-case button logic based on schedule and exceptions:

**Case 1: Schedule OFF, No Exception**
- Button: "Mark Active" (green)
- Action: Creates ACTIVE exception to override OFF schedule
- Use Case: Team member unscheduled but available today

**Case 2: Schedule ACTIVE, No Exception**
- Button: "Mark Off" (gray)
- Action: Opens dialog to create OFF exception with optional note
- Use Case: Team member scheduled but unavailable today (sick, leave, etc.)

**Case 3: Exception Exists (Any Type)**
- Button: "Revert Exception" (red)
- Action: Removes the exception, reverts to schedule-based status
- Use Case: Cancel a previous override and return to schedule

#### 4. Add Member Form
Inline form for creating new team members:
- **Full Name**: Text input
- **Email**: Email input (must be unique)
- **Temporary Password**: Password field (min 8 characters)
- **Role**: Dropdown (OPS_AGENT, STORE_ADMIN)
- Validation: All fields required
- Error Handling: Shows duplicate email errors
- Success: Form clears and member added to grid

---

## Edit Member Drawer

Slide-out panel for detailed member editing with four tabs.

### Tab 1: Profile

**Purpose**: Edit member identity and basic configuration

**Fields:**
- **Login Email** (read-only): Username for authentication
- **Full Name** (editable): Member's display name
- **Phone / WhatsApp** (editable): Contact number with placeholder format
- **Role** (dropdown): OPS_AGENT or STORE_ADMIN
- **Max Concurrent Tasks** (number input): 1-20, default 5
  - Controls how many tasks can be assigned simultaneously
- **Active Account** (toggle): Enable/disable account access
  - Inactive accounts cannot login
  - Shows note: "Inactive users cannot log in"

**Reset Password Section:**
- **New Password** (password input): Min 8 characters
- **Note**: "Leave blank to keep current password. Changing will invalidate all active sessions."
- When saved, user will need to re-authenticate with new password

**Behavior:**
- Changes are draft-only until "Save Changes" is clicked
- All profile changes saved with single click
- Success message appears for 2.5 seconds

### Tab 2: Order Types

**Purpose**: Configure which order types team member can handle

**Display:**
- Horizontal button grid: HOME_SAMPLE, CENTER_VISIT, INJECTION
- Visual feedback: 
  - Assigned: Green background with checkmark (✓)
  - Unassigned: Dark background with plus sign (+)
- Hover state: Changes color on hover
  - Assigned: Green → Red on hover (indicates clickable to remove)
  - Unassigned: Gray → Blue on hover

**Interaction:**
- Click button to toggle assignment on/off
- Changes are draft until "Save Changes"
- No immediate API call (optimistic, batch with other changes)

**Use Cases:**
- Assign: Member can now accept tasks of this type
- Remove: Member can no longer accept tasks of this type
- Example: "HOME_SAMPLE" = member can conduct home sampling

### Tab 3: Store Access

**Purpose**: Assign team member to specific stores

**Display:**
- List of all configured stores
- Checkbox for each store
- Store name and store ID visible
- If no stores configured: "No stores configured yet"
- Scrollable if many stores
- Shows hover effect for better UX

**Interaction:**
- Check box = assign store
- Uncheck box = remove store access
- Changes are draft until "Save Changes"
- Batch updates with profile changes

**Use Cases:**
- Assign member to multiple stores they service
- Remove when member changes territory
- Example: Member works at "Store #7, Store #39, Store #19"

### Tab 4: Schedule

**Purpose**: Configure team member's weekly working schedule

**Display:**
- 7-day weekly schedule (Sunday through Saturday)
- For each day:
  - **Day Toggle**: Checkbox to mark working/off
  - **Start Time**: Time input (HH:MM format)
  - **End Time**: Time input (HH:MM format)
  - **Break Times** (optional):
    - Break Start: Time input
    - Break End: Time input
  - **Copy From Button**: Copy schedule from another working day

**Example Configuration:**
```
Monday:    Working, 09:00 - 17:00, Break 13:00 - 14:00
Tuesday:   Working, 09:00 - 17:00, Break 13:00 - 14:00
...
Saturday:  Off
Sunday:    Off
```

**Features:**
- **Copy Schedule**: Click "Copy From" button
  - Opens modal showing available working days
  - Click a day to copy its times to current day
  - Helpful for repetitive schedules

**Behavior:**
- Changes are draft until "Save Changes"
- Time validation: Break times must be within working hours
- Saved schedule applies to all future weeks
- Daily exceptions override schedule

**Integration with Status:**
- Schedule determines baseline roster status
- If working 09:00-17:00 and current time is 14:00 → ACTIVE
- If working 09:00-17:00 and current time is 08:00 → OFF
- If on break 13:00-14:00 and current time is 13:30 → OFF

---

## Data Flow

### Creating a New Team Member
```
1. User fills "Add Member" form
2. Click "Create Member"
3. API POST /api/team with: name, email, password, role
4. Server validates and creates user record
5. Automatically creates teamMember record with default config
6. Grid updates with new member (ACTIVE status)
7. Form clears, success message shown
```

### Editing Team Member (All Changes via Single Save)
```
1. Click member's edit button → EditDrawer opens
2. User modifies any tabs:
   - Profile: name, phone, role, password, max tasks, active toggle
   - Order Types: toggle assignments
   - Stores: toggle assignments
   - Schedule: configure days, times, breaks
3. Click "Save Changes"
4. API calls (sequential):
   a. PATCH /api/team/{userId} - profile changes
   b. POST/DELETE /api/team/{userId}/order-types - sync order types
   c. POST/DELETE /api/team/{userId}/stores - sync stores
   d. POST /api/roster/schedule/{userId} - save schedule
5. Success message appears (2.5 sec auto-dismiss)
6. Drawer refreshes with latest data
7. Main grid updates with new stats and status
```

### Roster Status Override
```
Case 1: Schedule OFF → Click "Mark Active"
   → POST /api/roster/exception {status: "ACTIVE"}
   → Button changes to "Revert Exception"

Case 2: Schedule ACTIVE → Click "Mark Off"
   → Opens exception dialog
   → Enter optional note
   → POST /api/roster/exception {status: "OFF"}
   → Button changes to "Revert Exception"

Case 3: Exception exists → Click "Revert Exception"
   → DELETE /api/roster/exception/{userId}/{date}
   → Button changes based on schedule
```

---

## Status Management

### Roster Status Values
- **ACTIVE**: Team member is available and within working hours
- **OFF**: Team member is not scheduled (schedule-based)
- **ON_LEAVE**: Team member has approved leave (exception-based)
- **SICK**: Team member is unavailable (exception-based)

### Status Calculation Priority
```
1. If exception exists for today
   → Use exception status
   
2. Else if no weekly schedule configured
   → Return OFF
   
3. Else if current time within working hours (and not on break)
   → Return ACTIVE
   
4. Else
   → Return OFF
```

### Status Indicators
- Visual dot: Green (ACTIVE), Gray (OFF/absent)
- Text label: ACTIVE, OFF, ON_LEAVE, SICK
- Updated in real-time on main grid

---

## Performance Metrics

Each team member card shows:
- **Task Load**: Visual progress bar (current/max tasks)
- **Skills**: First 2 displayed + count badge
- **Stores**: Count of assigned stores
- **Performance Stats** (in drawer):
  - This Month: Tasks assigned, completed, SLA compliance
  - This Week: Same metrics

---

## UI/UX Details

### Colors & Styling
- Dark theme: Zinc-950 background, zinc-900 cards
- Borders: Zinc-800 default, zinc-600 hover
- Text: White (primary), zinc-500 (labels)
- Accents: Blue-600 (active), Green-600 (success), Red-600 (alert)

### Responsive Design
- Mobile (small): 1 column of cards
- Tablet (medium): 2 columns
- Desktop (large): 3 columns

### Success Notifications
- "Changes saved" message appears below Save button
- Auto-dismisses after 2.5 seconds
- Prevents confusion from persistent notifications

### Error Handling
- Error messages show in red banner
- Specific error details provided (duplicate email, invalid role, etc.)
- Optimistic updates revert on API failure
- User can retry operation

---

## Implementation Status

### ✅ Complete Features

**Core CRUD Operations:**
- ✅ Create team members with role assignment
- ✅ View team members with full details and stats
- ✅ Edit profiles (name, phone, role, password, status, max tasks)
- ✅ Delete/deactivate team members (via isActive toggle)

**Assignments:**
- ✅ Assign/remove order types (HOME_SAMPLE, CENTER_VISIT, INJECTION)
- ✅ Assign/remove store access (multi-store support)
- ✅ Manage up to 20 concurrent tasks per member

**Schedule Management:**
- ✅ Configure weekly schedule (all 7 days)
- ✅ Set working hours per day (start/end times)
- ✅ Configure optional break times
- ✅ Copy schedule between days (reduce repetition)
- ✅ Support for day-off configuration

**Roster Status Management:**
- ✅ Real-time roster status calculation
- ✅ Three-case override logic (Mark Active/Off, Revert Exception)
- ✅ Daily exception management (ON_LEAVE, SICK, OFF, ACTIVE)
- ✅ Roster analytics showing Active/Off counts
- ✅ Exception dialog with optional notes
- ✅ Auto-dismiss success notifications (2.5s)

**Performance & Analytics:**
- ✅ Task load tracking per member
- ✅ SLA compliance metrics (this month, this week)
- ✅ Workload distribution visualization
- ✅ Real-time stats refresh after changes

**UI/UX:**
- ✅ Responsive grid layout (1-3 columns)
- ✅ Dark theme styling (zinc-950)
- ✅ Inline add form with validation
- ✅ Multi-tab edit drawer
- ✅ Single "Save Changes" button for all modifications
- ✅ Optimistic UI updates with error reversion
- ✅ Batch API operations for efficiency

**Bug Fixes & Improvements:**
- ✅ Timezone-aware exception date handling (UTC consistency)
- ✅ Proper ID mapping (userId vs teamMemberId)
- ✅ hasException flag for button logic
- ✅ State synchronization after API updates
- ✅ Auto-dismiss notifications (prevent UI clutter)
- ✅ Copy schedule functionality with modal

### Known Constraints
- Roster overrides are daily (reset at midnight)
- Order types limited to 3 predefined types
- Max concurrent tasks: 1-20 range
- Stores must exist before assigning
- Email must be unique across system
- Password changes invalidate all sessions

---

## Integration Points

### Task Assignment Engine
- Checks member's assigned order types before task assignment
- Verifies member's roster status (must be ACTIVE)
- Respects max concurrent task limit
- Filters eligible members based on schedule + exceptions

### Task Statistics
- Counts tasks assigned to member (currentLoad)
- Calculates SLA compliance from task completion times
- Tracks completed/cancelled tasks per time period

### Schedule System
- Weekly schedule is template for daily availability
- Daily exceptions override weekly schedule
- Current time compared against schedule to determine ACTIVE/OFF

---

**Last Updated**: May 3, 2026  
**Version**: 2.0 - Complete Implementation

See Also: [Technical Specification](TECHNICAL_SPEC.md) | [Implementation Notes](../IMPLEMENTATION_ROADMAP.md)
