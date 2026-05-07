# Roster Feature - Product Specification

**Feature**: Weekly Schedule Management & Daily Roster Exceptions  
**Version**: 1.0  
**Status**: Design  
**Last Updated**: May 3, 2026

---

## Overview

The Roster feature provides a simple and efficient way to manage team member availability. Each team member defines their weekly working schedule (days and times), and can mark exceptions (leaves, sick days, etc.) for specific dates. The system automatically displays what each team member is scheduled to work, with easy override capabilities for absences.

---

## Core Concept

```
WeeklySchedule (Template)
├─ Monday:    9 AM - 5 PM (with 1-2 PM break)
├─ Tuesday:   9 AM - 5 PM (with 1-2 PM break)
├─ Wednesday: 9 AM - 5 PM (no break)
├─ Thursday:  9 AM - 5 PM (with 1-2 PM break)
├─ Friday:    9 AM - 5 PM (with 1-2 PM break)
├─ Saturday:  OFF
└─ Sunday:    OFF

RosterException (Overrides)
├─ May 5:     ON_LEAVE (scheduled to work Mon, but marked off)
├─ May 10:    SICK (scheduled to work, but unavailable)
└─ May 15:    OFF (scheduled to work, but marked off)
```

---

## Key Features

### 1. Weekly Schedule Configuration

**What**: Define working days and times for each team member.

**Where**: Team Member Edit Screen → Schedule Tab

**Details**:
- Per day of week (Monday through Sunday)
- Toggle: Working / Not Working
- If working:
  - Start time (e.g., 9:00 AM)
  - End time (e.g., 5:00 PM)
  - Optional break: Start time and End time (e.g., 1 PM - 2 PM)
- All times in 24-hour format (HH:MM)
- Save all 7 days as a template

**Example**:
```
Monday:
  ☑ Working
  Start: 09:00
  End: 17:00
  Break: 13:00 - 14:00

Saturday:
  ☐ Off
```

### 2. Daily Roster Display

**What**: Show each team member's schedule for a given date.

**Where**: Daily Roster Page (/head/roster)

**Display Logic**:
1. For selected date, get day of week
2. Fetch WeeklySchedule for that day
3. Check if RosterException exists for that date
4. Display:
   - If exception exists → Show exception status (ON_LEAVE, SICK, OFF)
   - If no exception → Show scheduled times from WeeklySchedule

**Example Display**:
```
Monday, May 5, 2026

Abhishek Rajpoot (OPS_AGENT)
Scheduled: 9:00 AM - 5:00 PM (Break: 1-2 PM)
Current Status: ON_LEAVE (overrides schedule)
[Remove Leave] [Mark as Sick] [Mark as Off]

Datha (OPS_AGENT)
Scheduled: 9:00 AM - 5:00 PM
Current Status: ACTIVE (no exceptions)
[Mark as Leave] [Mark as Sick] [Mark as Off]

Kratika (STORE_ADMIN)
Scheduled: OFF (not scheduled to work today)
[Mark as Working] (optional - override the schedule)
```

### 3. Roster Exceptions

**What**: Mark team members as absent on specific dates when they can't work their scheduled shift.

**Where**: Daily Roster Page (quick action buttons)

**Exception Types**:
- `ON_LEAVE` - Planned leave (vacation, personal day)
- `SICK` - Unplanned absence (illness)
- `OFF` - Last-minute cancellation or schedule change

**Actions**:
- Click button to mark exception for a date
- Add optional note (reason for exception)
- Remove exception (revert to scheduled time)
- View exceptions for a date range

**Example**:
```
May 5: Mark Abhishek as "ON_LEAVE"
May 10: Mark Datha as "SICK" (note: "Fever")
May 15: Mark Kratika as "OFF" (note: "Called in sick last minute")
```

---

## User Workflows

### Workflow 1: Configure Weekly Schedule (One-time Setup)

**Actor**: Team Manager (OPS_HEAD)

**Steps**:
1. Open Team Management
2. Click Edit on a team member
3. Open "Schedule" tab
4. For each day of week:
   - Toggle "Working" / "Off"
   - If working, set Start time, End time, Break times
5. Click Save
6. Schedule is now the roster template for this person

**Result**: WeeklySchedule saved for all 7 days

---

### Workflow 2: View Today's Roster

**Actor**: Team Manager or Ops Head

**Steps**:
1. Navigate to Daily Roster page
2. Date defaults to today (can change date with picker)
3. See all team members with:
   - Scheduled times (from WeeklySchedule)
   - Any exceptions marked for today
   - Quick action buttons to add exceptions

**Result**: Clear visibility of who's working today and when

---

### Workflow 3: Mark Team Member as Absent

**Actor**: Team Manager, Agent, or OPS_HEAD

**Steps**:
1. Open Daily Roster page
2. Find team member
3. Click one of:
   - [Mark as Leave]
   - [Mark as Sick]
   - [Mark as Off]
4. Optional: Add note/reason
5. Exception is recorded for that date

**Result**: RosterException created, Daily Roster updated instantly

---

### Workflow 4: Remove Exception (Revert to Schedule)

**Actor**: Team Manager

**Steps**:
1. Open Daily Roster page (on date with exception)
2. Find team member with exception status
3. Click [Remove Exception] or [Revert to Schedule]
4. Exception is deleted

**Result**: Team member reverts to their scheduled time

---

## Data Model

### WeeklySchedule
- **Purpose**: Template of working days and times
- **Records**: One per team member per day of week (7 maximum)
- **Fields**:
  - teamMemberId (FK to TeamMember)
  - dayOfWeek (0-6: Sun-Sat)
  - isWorking (boolean)
  - startTime (HH:MM format, only if isWorking)
  - endTime (HH:MM format, only if isWorking)
  - breakStart (HH:MM format, optional)
  - breakEnd (HH:MM format, optional)

### RosterException
- **Purpose**: Store overrides for specific dates
- **Records**: One per exception (no set limit)
- **Fields**:
  - teamMemberId (FK to TeamMember)
  - date (YYYY-MM-DD format)
  - status ("ON_LEAVE" | "SICK" | "OFF")
  - note (optional reason/details)
  - createdAt (who created it)
  - updatedAt (when last modified)

---

## UI Components

### 1. Schedule Tab (Team Edit Drawer)

**Location**: Team Management → Edit Member → Schedule Tab

**Layout**:
```
Weekly Schedule Configuration

┌─────────────────────────────────────────────────┐
│ Monday                                          │
│ ☑ Working                                       │
│ Start Time:    [09:00]                          │
│ End Time:      [17:00]                          │
│ Break Start:   [13:00]    Break End: [14:00]   │
│                                                 │
│ Tuesday                                         │
│ ☑ Working                                       │
│ Start Time:    [09:00]                          │
│ End Time:      [17:00]                          │
│ Break Start:   [----]     Break End: [----]    │
│                                                 │
│ Wednesday                                       │
│ ☑ Working                                       │
│ Start Time:    [10:00]                          │
│ End Time:      [18:00]                          │
│ Break Start:   [----]     Break End: [----]    │
│                                                 │
│ Thursday                                        │
│ ☑ Working                                       │
│ Start Time:    [09:00]                          │
│ End Time:      [17:00]                          │
│ Break Start:   [13:00]    Break End: [14:00]   │
│                                                 │
│ Friday                                          │
│ ☑ Working                                       │
│ Start Time:    [09:00]                          │
│ End Time:      [17:00]                          │
│ Break Start:   [13:00]    Break End: [14:00]   │
│                                                 │
│ Saturday                                        │
│ ☐ Off                                           │
│                                                 │
│ Sunday                                          │
│ ☐ Off                                           │
│                         [Save Changes]          │
└─────────────────────────────────────────────────┘
```

### 2. Daily Roster Page

**Location**: /head/roster

**Layout**:
```
Daily Roster
Set who's available for task assignment each day.

Monday, May 5, 2026  [← Today →]

┌─────────────────────────────────────────────────────┐
│ Abhishek Rajpoot (OPS_AGENT) | 0/5 tasks           │
├─────────────────────────────────────────────────────┤
│ Scheduled: 09:00 - 17:00 (Break: 13:00-14:00)     │
│ Status: ⚠ ON_LEAVE                                │
│ [Remove Leave]  [Mark as Sick]  [Mark as Off]    │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ Datha (OPS_AGENT) | 0/5 tasks                      │
├─────────────────────────────────────────────────────┤
│ Scheduled: 09:00 - 17:00 (Break: 13:00-14:00)     │
│ Status: ✓ ACTIVE (no exceptions)                  │
│ [Mark as Leave]  [Mark as Sick]  [Mark as Off]   │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ Kratika (STORE_ADMIN) | 0/5 tasks                  │
├─────────────────────────────────────────────────────┤
│ Scheduled: OFF (not scheduled today)               │
│ Status: ✓ OFF (as scheduled)                      │
│ [Override - Mark as Working]                      │
└─────────────────────────────────────────────────────┘
```

### 3. Exception Dialog

**Triggered**: When clicking exception button

```
┌──────────────────────────────────────┐
│ Mark as Leave                        │
├──────────────────────────────────────┤
│ Abhishek Rajpoot                     │
│ Monday, May 5, 2026                  │
│ Scheduled: 09:00 - 17:00             │
│                                      │
│ Add note (optional):                 │
│ [__________ vacation ________]       │
│                                      │
│ [Cancel]  [Mark as Leave]            │
└──────────────────────────────────────┘
```

---

## Integration Points

### 1. Task Assignment Engine
- When assigning tasks, check:
  - Is agent scheduled to work at task time?
  - Are they marked as exception (LEAVE/SICK/OFF)?
  - If yes → Don't assign to this agent

### 2. Daily Roster Display
- When loading Daily Roster page:
  - Fetch WeeklySchedule for date's day
  - Fetch RosterException for that date
  - Calculate and display merged view

### 3. Team Management
- When editing team member:
  - Show Schedule tab with WeeklySchedule editor
  - Allow bulk configuration of all 7 days

### 4. Analytics
- Track how often exceptions occur
- Identify patterns (e.g., who frequently marks as sick)

---

## Success Criteria

- ✅ Team members can configure weekly schedule once
- ✅ Schedule automatically applies to daily rosters
- ✅ Managers can quickly mark exceptions for specific dates
- ✅ Task engine respects roster (doesn't assign to OFF/LEAVE agents)
- ✅ Daily Roster page is fast and intuitive
- ✅ Changes take effect immediately (no page refresh needed)

---

## Constraints & Assumptions

- All times in 24-hour format (HH:MM)
- Break times are optional
- Maximum one exception per person per date
- Exceptions override scheduled times (exceptions take priority)
- Weekly schedule applies indefinitely (until changed)
- No timezone complexity (all times in system timezone)

---

## Future Enhancements (Not in MVP)

- [ ] Recurring exceptions (e.g., every Friday at 3 PM off)
- [ ] Shift swaps between team members
- [ ] Rostering request workflow (agent requests leave, manager approves)
- [ ] Calendar view of all exceptions
- [ ] Export roster as PDF/CSV
- [ ] Notifications when schedule changes

