# OpsFlow — Product Requirements Document

**Product Name:** OpsFlow
**Version:** 1.0 — Draft for PM Review
**Date:** April 25, 2026
**Prepared by:** Product Team
**Status:** For Review

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Background & Problem Statement](#2-background--problem-statement)
3. [Product Vision & Goals](#3-product-vision--goals)
4. [User Personas](#4-user-personas)
5. [Core Concepts & Glossary](#5-core-concepts--glossary)
6. [Feature Specifications](#6-feature-specifications)
   - [6.1 Automatic Task Creation](#61-feature-automatic-task-creation)
   - [6.2 Task Rules & Configuration](#62-feature-task-rules--configuration)
   - [6.3 Team & Roster Management](#63-feature-team--roster-management)
   - [6.4 Alert & Escalation System](#64-feature-alert--escalation-system)
   - [6.5 Ops Head — Command Center](#65-feature-ops-head--command-center-dashboard)
   - [6.6 Ops Agent — Task Interface](#66-feature-ops-agent--task-interface)
   - [6.7 Store Admin — Store Dashboard](#67-feature-store-admin--store-dashboard)
   - [6.8 Analytics & Reporting](#68-feature-analytics--reporting)
7. [Key User Journeys](#7-key-user-journeys)
8. [Information Architecture](#8-information-architecture)
9. [Out of Scope](#9-out-of-scope)
10. [Phased Roadmap](#10-phased-roadmap)
11. [Open Questions & Decisions Needed](#11-open-questions--decisions-needed)

---

## 1. Executive Summary

LabStack operates a network of healthcare home-service orders — home blood sample collections, centre visit bookings, and injection administration at home. Each order type has a defined set of operations steps, strict time windows, and handoff points that the operations team must execute without fail.

Today, the operations team works entirely reactively — manually scanning order queues, tracking SLA deadlines in their heads or on WhatsApp, and escalating through informal channels. There is no system that tells an agent what to do next, no mechanism that catches a missed action before it becomes a patient problem, and no visibility for the Ops Head into what is at risk until something has already gone wrong.

**OpsFlow** is a purpose-built operations task management product that sits alongside the existing LabStack system. It watches every order in real time, automatically creates structured work items (tasks) for the operations team when action is needed, assigns those tasks to the right person based on skill and availability, tracks whether they are completed within the required time, and alerts the Ops Head when things are slipping.

The result: operations becomes systematic instead of instinctive. Every order gets the attention it needs. SLA compliance becomes measurable. The Ops Head leads proactively instead of fighting fires.

---

## 2. Background & Problem Statement

### 2.1 How Operations Works Today

LabStack's operations team is responsible for a set of critical actions that must happen at precise points in an order's lifecycle. For a home blood sample collection, for example, the team must confirm the order with the lab within 30 minutes of it being placed, verify the booking again the evening before the appointment, check that the phlebotomist has started within 30 minutes of the appointment window, track the sample through to the lab, and follow up until the report is delivered. For injection orders, the team must validate the prescription, call and assign a medic, send them detailed instructions, and confirm administration.

These are not optional steps. Failing any one of them can mean a patient arriving at a centre that doesn't have their booking, a phlebotomist never showing up, or a medic administering the wrong dosage.

### 2.2 What Is Broken

**No structured to-do list exists.** When an order is placed, no one is told to act on it. An agent must remember to check, or happen to spot it while scanning a queue. If the queue is large or the agent is busy, things get missed.

**SLAs are tracked informally.** The 30-minute confirmation SLA, the T-1 day verification, the pre-visit window — these exist as written SOPs but are enforced only by individual memory. There is no system counting down to a deadline or firing an alert when one is breached.

**There is no assignment system.** Tasks are distributed by verbal instruction, WhatsApp message, or personal initiative. The Ops Head has no visibility into whether a task has been picked up, is in progress, or has been forgotten.

**The Ops Head has no real-time view.** The only way to know the health of today's operations is to manually ask each agent or spot a patient complaint. By that point, the SLA has already been missed and the patient is already affected.

**Escalation leaves no trail.** When something goes wrong, it is escalated via WhatsApp. There is no audit of what happened, when it was escalated, who picked it up, and how it was resolved. This makes it impossible to identify patterns, train the team, or improve.

### 2.3 The Cost

- Orders confirmed late → lab portal slots lost → patients need to be rescheduled last-minute
- Phlebotomists not tracked → patients waiting at home with no update
- Reports not followed up → completed orders left in limbo, patient dissatisfied
- Medic not called properly for injection orders → clinical safety risk
- No data → Ops Head cannot make roster decisions, identify weak spots, or reward top performers

### 2.4 The Opportunity

The LabStack system already records every order event with timestamps. The information to know *what needs to happen next and when* already exists. OpsFlow consumes that information and turns it into structured, assigned, time-bound work — automating what is today done by memory, intuition, and hope.

---

## 3. Product Vision & Goals

### 3.1 Vision Statement

> *Every order status change becomes a task. Every task has an owner, a deadline, and a consequence if missed. The system reflects reality at all times.*

### 3.2 Product Goals

| # | Goal | What It Means in Practice |
|---|---|---|
| G1 | Zero missed SLAs due to human oversight | No order should miss a deadline because someone forgot to act — the system ensures every action is visible and assigned |
| G2 | Every task has a named owner at all times | Ambiguity about responsibility is eliminated — if a task exists, someone owns it |
| G3 | The Ops Head sees risk before it becomes failure | The command center shows what is about to breach, not just what has already breached |
| G4 | Operations performance is measurable | SLA compliance, team workload, and order health are tracked numbers, not gut feelings |
| G5 | The system is self-configuring for new SOPs | When LabStack introduces a new order type or process, OpsFlow can be configured to handle it without a software release |

### 3.3 Success Metrics

| Metric | Baseline (Today) | Phase 1 Target | Phase 3 Target |
|---|---|---|---|
| 30-minute order confirmation SLA compliance | Unknown — not tracked | ≥ 85% | ≥ 95% |
| Orders with missed pre-visit action | Unknown | < 5% | < 1% |
| Time Ops team spends manually scanning queues | ~40% of shift | < 15% of shift | < 5% of shift |
| Ops Head visibility into real-time risk | None | Full risk zone view | Predictive (next 2 hours) |
| Average task assignment time | Manual / untracked | < 3 minutes | < 30 seconds (auto) |
| SLA breaches requiring patient escalation | Frequent | 50% reduction | 80% reduction |
| Team SLA compliance trackable per person | No | Yes | Yes + trend |

---

## 4. User Personas

### 4.1 Persona: Ops Head

**Name:** Rahul Kumar *(representative)*
**Role:** Head of Operations, responsible for the full operations team across all stores

**A day in their life today (without OpsFlow):**
Rahul starts each morning by asking his team over WhatsApp what's pending. He checks a few queue screens manually, flags orders that look at risk, and delegates verbally or over chat. Throughout the day, he gets messages like "can't reach the lab," "phlebo hasn't started," or "patient is calling." By the time he learns about a problem, the SLA has almost always already been missed. His evening is a mix of reviewing what went wrong and trying to ensure tomorrow's orders are confirmed. He has no structured way to know how his team is performing — he goes by instinct and memory.

**Goals:**
- Know what is at risk *before* it becomes a problem
- Know which team members are overloaded and which have capacity, at any moment
- Be able to hold people accountable with data, not impressions
- Stop being the last person to know when something goes wrong
- Understand patterns: which task types keep failing, which stores need more support

**Frustrations:**
- "I only find out something is wrong when the patient calls"
- "I have no idea who was supposed to do what"
- "I can't tell if today is going well or badly until the day is over"
- "Escalations happen on WhatsApp and then disappear"

**What success looks like:**
Rahul opens his dashboard in the morning and immediately sees the health of all orders across all stores. He sees a risk zone that tells him exactly what is about to breach. He does not need to ask his team what they're working on — the system tells him. At the end of the day, he receives a summary of SLA compliance, task completion, and any unresolved items. He uses weekly performance data to coach his team.

---

### 4.2 Persona: Ops Agent

**Name:** Riya Sharma *(representative)*
**Role:** Operations Agent — front-line executor of SOPs across Home Sample, Centre Visit, and Injection orders

**A day in their life today (without OpsFlow):**
Riya starts her shift by looking at multiple queue screens and trying to identify what needs action. She has a rough mental list of what the SOPs require but depends on memory for timing. When she gets busy, lower-priority tasks slip. She sometimes discovers an order that should have been confirmed 45 minutes ago — and now it may be too late to get the slot. She receives delegated tasks over WhatsApp with no tracking of whether she's completed them. If she gets stuck — a lab portal is down, or a medic is unavailable — she doesn't have a structured way to escalate; she just messages the group.

**Goals:**
- Know exactly what she needs to do right now, in priority order
- Have all the information she needs to complete a task in one place
- Not miss an SLA because no one told her something was urgent
- Have a record of what she's done if questioned

**Frustrations:**
- "I'm juggling so many things and don't always know what's most urgent"
- "I have to switch between multiple screens to find the information I need to make a call"
- "Sometimes I do something and there's no record that I did it"
- "I don't know if I'm performing well or not"

**What success looks like:**
Riya arrives at her desk and sees a clean task list — sorted by urgency, with a countdown to each SLA. Each task contains everything she needs: the patient's name, the order details, the lab contact, the exact steps to follow. She works through tasks one by one. When she completes one, she adds a short note, and it's logged. When she is stuck, she marks a task as blocked and the system routes it to the Ops Head. At the end of the shift, she can see she completed 14 tasks with a 94% SLA rate.

---

### 4.3 Persona: Store Admin

**Name:** Nidhi Patel *(representative)*
**Role:** Store Admin for Store 1 — manages operations and team for one specific store location

**A day in their life today (without OpsFlow):**
Nidhi is responsible for everything that happens at her store, but her visibility is limited to what her agents tell her and what she can piece together from the main LabStack screen. She can't see which tasks are pending for her store's orders, can't tell which of her team members is stretched, and learns about SLA breaches the same way Rahul does — after the fact. She manually assigns work to her two agents each morning based on how many orders are on the roster that day, but has no real view of workload distribution through the day.

**Goals:**
- See the health of her store's orders at a glance
- Know which of her team members has capacity and who is at full load
- Be able to intervene quickly when a task is stuck or unassigned at her store
- Show performance data to her agents and have productive review conversations

**Frustrations:**
- "I can't tell if my team is keeping up or falling behind unless I ask them directly"
- "If Riya is at full capacity and a new urgent task comes in, I don't know that until it's too late"
- "I have no data to bring to performance reviews"

**What success looks like:**
Nidhi sees a store-level dashboard that shows today's order health broken down by order type, her team's current workload, and any tasks that are unassigned or at risk. When a task goes unassigned because both agents are full, she gets an alert and can manually reassign or handle it herself. At the end of the week, she reviews a performance summary for her store.

---

## 5. Core Concepts & Glossary

Before reading the feature specifications, the following concepts are important to understand. These are the building blocks of OpsFlow and are referenced throughout the document.

| Term | Definition |
|---|---|
| **Order** | An active service request in the LabStack system — a home blood collection, a centre visit booking, or a home injection. Each order has a status that changes as the service progresses. |
| **Order Type** | The category of service: Home Sample Collection, Centre Visit, or Injection at Home. Each type has its own set of operations steps and SLA timelines. |
| **Task** | The core unit of work in OpsFlow. A specific, actionable item that an operations agent must complete — e.g., *"Confirm Order #4821 with SRL Labs."* Every task has a title, steps, a deadline, an assigned agent, and a status. |
| **Task Type** | A template category for tasks. Examples: *Confirm with Lab*, *Pre-Visit Call*, *Assign Medic*. Task types carry a standard description and checklist. |
| **SLA** | The time window within which a task must be completed. If a task is not completed within its SLA, it is considered *breached*. |
| **SLA Health** | A percentage score representing how many tasks were completed within their SLA out of all tasks due. Below 80% is considered a concern. |
| **Rule** | A configuration that tells OpsFlow *when* to automatically create a task — what condition triggers it, what task to create, how long the agent has, and who should receive it. |
| **Checklist** | A set of mandatory steps that must be ticked off before a task can be marked complete. |
| **Assignment** | The act of connecting a task to a specific agent. Can be automatic or manual. |
| **Roster** | The schedule of which team members are on duty on which day and at what times. |
| **Capacity** | The maximum number of tasks an agent can hold simultaneously. When full, new tasks go to the unassigned queue. |
| **Skill Tag** | A label indicating a team member's specific capability (e.g., *Lab Portal: SRL*, *Injection Assignment*). Task rules can require certain skills. |
| **Escalation** | The process of elevating an unresolved or breached task to a higher level — triggered automatically at SLA breach or manually by a blocked agent. |
| **Risk Zone** | A curated view of orders and tasks that are in immediate danger of breaching their SLA or have already breached. The highest-priority section of the Ops Head dashboard. |
| **Blocking** | When an agent cannot complete a task due to an external obstacle, they mark it Blocked with a reason, surfacing it to the Ops Head for intervention. |

---

## 6. Feature Specifications

---

### 6.1 Feature: Automatic Task Creation

#### Overview

OpsFlow monitors the LabStack order system continuously. Every few minutes, it checks whether any order has reached a state that requires an operations action — and if so, automatically creates a task for the team. This replaces the current manual process of agents scanning queues to find what needs attention.

#### User Stories

- *As an Ops Agent, I want to receive a task automatically whenever an order needs my attention, so that I don't miss anything by failing to check the right queue at the right time.*
- *As an Ops Head, I want confidence that every order that needs attention has a task created and assigned to someone, so that nothing slips through the cracks without a record.*
- *As a Store Admin, I want tasks created automatically for my store's orders, so that my team is always working from a complete picture.*

#### How It Works

OpsFlow checks the LabStack order system on a fixed interval — every 5 minutes. On each check, it evaluates all active orders against a set of rules. For every order that matches a rule's trigger condition and does not already have an open task of that type, a new task is created.

The system never creates duplicate tasks. If a task for a particular order and action already exists and is open, the system skips that order on the next cycle.

Once created, a task is immediately assigned to a team member and a notification is sent to that person. If no eligible team member is found, the task is placed in an *Unassigned Queue* and an alert is sent to the Ops Head immediately.

#### Tasks Created Automatically — Home Sample Collection

| When this happens | Task created | Must be done within |
|---|---|---|
| New order arrives | Confirm order with lab / verify via portal | 30 minutes of order creation |
| Order confirmed, appointment is tomorrow | T-1 day verification check | By end of today's shift |
| 30 minutes before appointment, phlebo not confirmed as started | Check phlebo status with lab | 10-minute action window |
| Phlebo started but no sample collected update for 60 minutes | Follow up on collection status | 15 minutes |
| Sample collected but not marked dispatched for 2 hours | Follow up on sample movement | 20 minutes |
| Sample delivered, no report ETA captured | Capture report ETA from lab | 30 minutes |
| Report ETA has passed, report not received | Follow up on delayed report | 30 minutes |
| Any change detected on a confirmed order | Reconfirm updated details with lab | 20 minutes |

#### Tasks Created Automatically — Centre Visit

| When this happens | Task created | Must be done within |
|---|---|---|
| New order arrives | Confirm centre booking | 30 minutes of order creation |
| Order confirmed, appointment is tomorrow | T-1 day verification with centre | By end of today's shift |
| 2 hours before appointment | Call centre, confirm appointment and payment clarity | 15 minutes |
| 1 hour after appointment time, no completion noted | Call centre or patient to confirm completion | 20 minutes |
| Any change detected | Reconfirm with centre | 20 minutes |

#### Tasks Created Automatically — Injection at Home

| When this happens | Task created | Must be done within |
|---|---|---|
| Appointment created | Validate prescription and check for special requirements | 30 minutes of creation |
| Prescription validated | Assign medic — call to confirm, send WhatsApp instructions | 30 minutes |
| 60 minutes before appointment | Pre-visit confirmation call to medic | 15-minute window |
| 60 minutes before appointment | Pre-visit confirmation call to patient | 15-minute window |
| 30 minutes before appointment, medic not marked as started | Call medic, update status manually | 10 minutes |
| Appointment time passed, medic not marked as reached | Call medic, inform patient if needed | 10 minutes |
| 90 minutes after appointment, no completion status | Confirm injection was administered | 15 minutes |
| Any change to the appointment | Call medic, resend instructions | 15 minutes — CRITICAL |

#### Acceptance Criteria

- A task is created within one polling cycle (≤ 5 minutes) of the trigger condition being met
- No duplicate tasks are created for the same order and action
- If no eligible agent is available, the task is created in an Unassigned state and the Ops Head is alerted within the same cycle
- Tasks are scoped to the correct store — agents only see tasks for orders on stores they are assigned to
- The task creation log is recorded and accessible to the Ops Head

#### Edge Cases & Exceptions

| Scenario | Expected Behaviour |
|---|---|
| Order is cancelled after a task was already created | Task is automatically cancelled and the assigned agent is notified |
| Order is rescheduled while a pre-visit task is in progress | Existing task is cancelled; a new task with the updated appointment time is created |
| An order is edited (test changed, time changed) | The *Order Edit* task is created regardless of any other open tasks — this takes priority |
| Task is completed but the order status hasn't changed yet | Task remains complete; no new task is created until the status updates |
| System experiences a polling failure for one cycle | On next successful cycle, all missed triggers are evaluated; no events are skipped |
| Order is in a terminal state (Cancelled, Completed) | No new tasks are created |

---

### 6.2 Feature: Task Rules & Configuration

#### Overview

Task Rules are the instructions that tell OpsFlow when to create which task. They are configured in the product and can be edited, added, or deactivated by the Ops Head without any software development work.

#### User Stories

- *As an Ops Head, I want to add a new task rule when a new SOP step is introduced, without needing to ask an engineer.*
- *As an Ops Head, I want to temporarily deactivate a rule during a process change without deleting the configuration.*
- *As an Ops Head, I want to adjust the SLA duration for a specific task type without affecting other rules.*
- *As an Ops Head, I want to see which rules are currently active and what they will create.*

#### Rule Fields

Each rule is defined by the following fields:

| Field | Description |
|---|---|
| Trigger entity | Order, Appointment, or Pharma Order |
| Trigger condition | Plain-language selection: status, order type, time condition |
| Task to create | Choose from existing task types or create new |
| Task title template | With variables e.g. *"Confirm Order #{order_id} — {patient_name}"* |
| Checklist steps | Mandatory steps the agent must confirm |
| SLA duration | How long the agent has to complete from task creation |
| Priority level | Critical, High, Medium, or Low |
| Eligible assignees | Filter by role and/or skill tag |
| Assignment method | Automatic (load-balanced) or Manual queue |
| Escalation chain | What happens when SLA is breached |

#### Priority Levels

| Level | Meaning | Typical SLA |
|---|---|---|
| Critical | Patient safety or appointment failure at risk | 0–15 minutes |
| High | Will cause downstream failure if delayed | 15–60 minutes |
| Medium | Important but not immediately time-sensitive | 1–4 hours |
| Low | Should be done today | Before end of shift |

#### Acceptance Criteria

- A new rule created by the Ops Head takes effect within the next polling cycle with no restart required
- Editing an SLA on a rule does not retroactively change the deadline on already-created tasks
- Pausing a rule does not cancel open tasks created by that rule — they continue until resolved
- The rule list can be filtered by order type, priority level, and active/paused status
- A rule cannot be saved if required fields are missing — the form shows inline validation

---

### 6.3 Feature: Team & Roster Management

#### Overview

OpsFlow maintains a profile for each member of the operations team, defines when they are scheduled to work, and uses this information to automatically route tasks to the right person at the right time.

#### User Stories

- *As an Ops Head, I want to set up team member profiles with their skills so the system only assigns tasks they are capable of handling.*
- *As an Ops Head, I want to build weekly shift schedules so the system knows who is available at any given time.*
- *As an Ops Head, I want to mark a team member as on leave so their tasks are re-routed automatically.*
- *As a Store Admin, I want to see and manage the roster for my team only.*

#### Team Member Profile

Each team member has:

- **Name and contact** — for display and notification routing
- **Role** — job designation
- **Stores assigned** — which store locations they cover
- **Skill tags** — capabilities (e.g., *Lab Portal: SRL Labs*, *Injection Assignment*, *Hindi Speaker*)
- **Maximum concurrent tasks** — cap on open tasks (default: 5; configurable per person)
- **Active / Inactive** — whether they are available for assignment

#### Shift Management

- **Shift Templates** — reusable templates with name, days of week, start/end time, and break window
- **Daily Roster** — per-day confirmation of who is working which shift; leave can be marked here
- A team member is considered available only when: within their shift hours, not on leave, and below their task maximum

#### Assignment Logic

When a new task is created, OpsFlow:

1. Filters for team members with all required skill tags
2. Filters for team members assigned to the relevant store
3. Filters for team members currently on duty
4. Selects the one with the fewest open tasks (load-balanced)
5. In a tie — rotates round-robin
6. If no eligible member found — task is placed Unassigned and the Ops Head is alerted immediately

**Manual Override:** The Ops Head and Store Admin can reassign any task at any time. Overrides are logged.

#### Skill Gap Warnings

OpsFlow warns the Ops Head when a task type has no eligible assignee at any point during the day — displayed at shift start and again when the gap period begins.

#### Acceptance Criteria

- A team member receives tasks only while their shift is active and they are not on leave
- When a team member is marked On Leave mid-day, their incomplete tasks return to the Unassigned queue
- Skill tags are open-ended — the Ops Head can create any new skill tag at any time
- Changes to the daily roster take effect immediately

---

### 6.4 Feature: Alert & Escalation System

#### Overview

OpsFlow proactively notifies the right people when things are going wrong — before they become patient-facing problems. Alerts are fired based on defined conditions, sent through the right channels, and require acknowledgement so nothing can be silently ignored.

#### User Stories

- *As an Ops Head, I want to be alerted when a task's SLA is about to breach so I can intervene before the patient is affected.*
- *As an Ops Agent, I want to receive a warning before my task's deadline so I can prioritise it.*
- *As an Ops Head, I want to be notified immediately if a task goes unassigned due to no team capacity.*
- *As an Ops Head, I want escalations to be logged so I can review what happened and when.*

#### Alert Types

| Alert | When It Fires | Who Receives It | Channel |
|---|---|---|---|
| SLA Warning | 10 minutes remaining on SLA | Assigned agent | In-app notification |
| SLA Urgent | 5 minutes remaining on SLA | Assigned agent | In-app + push |
| SLA Breached | Deadline passed, task still open | Assigned agent + Ops Head + Store Admin | In-app + WhatsApp |
| Task Unassigned | No eligible agent found at task creation | Ops Head + Store Admin | In-app + WhatsApp — immediate |
| Agent at Full Capacity | Agent reaches maximum task count | Ops Head + Store Admin | In-app |
| Order Stuck | Order in critical status too long with no update | Ops Head + Store Admin | In-app + WhatsApp |
| Skill Gap | Required skill has no shift coverage for upcoming window | Ops Head | In-app + daily digest |
| Daily Summary | End of each shift | Ops Head + Store Admin | WhatsApp + in-app |

#### Escalation Chains

An escalation chain defines the sequence of actions that happen automatically when a task's SLA is breached. Example for a 30-minute confirmation SLA:

| Time after breach | Action |
|---|---|
| Immediately | Task flagged as Breached. Agent receives urgent notification. Task turns red in all dashboards. |
| +15 minutes | Ops Head and Store Admin notified via WhatsApp with order details. |
| +30 minutes | Task appears in critical banner on Ops Head dashboard. Backup agent (if available) notified. |
| +45 minutes | Task flagged as SLA Violation Incident and logged permanently for reporting. |

#### Alert Fatigue Protection

- Repeated alerts for the same task fire no more than once every 30 minutes
- Agents receive at most 2 escalation notifications per task before alerts escalate only to the Ops Head
- Daily summary digests consolidate low-priority items rather than firing individual alerts
- The Ops Head can mute a specific alert type for a defined time window without affecting other alerts

#### Acceptance Criteria

- A breached task's alert fires within 2 minutes of the SLA expiring
- Alert content includes all required context (order ID, patient, type, task, time overdue)
- Every alert is logged with timestamp, recipient, and channel — even if the notification failed to deliver
- Acknowledging an alert from WhatsApp is reflected in the in-app alert log within 5 minutes

---

### 6.5 Feature: Ops Head — Command Center Dashboard

#### Overview

The Command Center is the Ops Head's primary workspace — a live, always-updating view of the health of all operations across all stores. It is designed to answer one question at all times: *What is about to go wrong, and what do I need to do about it?*

#### User Stories

- *As an Ops Head, I want to see — in one view — everything that is at risk right now, so I can intervene without having to dig.*
- *As an Ops Head, I want to see who on my team is available, at capacity, and at risk of being overwhelmed.*
- *As an Ops Head, I want to see the health of all orders across all order types and stores.*
- *As an Ops Head, I want to be able to reassign any task to any team member directly from this screen.*

#### Dashboard Sections

**Section A — Top Summary Bar**
Five live numbers, always visible: total active orders, total open tasks, tasks SLA breached (red), tasks SLA warning (amber), overall SLA health percentage (colour-coded). Updates automatically.

**Section B — Risk Zone**
A prioritised list of every task or order that is either breached or within 15 minutes of breaching. Sorted by severity — unassigned items first, then by how overdue or close to breach.

Each row shows: priority indicator, order number and task name, patient name and appointment detail, order type, rule name, time remaining or overdue, assigned agent (or "Unassigned"), and action buttons — *View*, *Escalate* or *Reassign*.

**Section C — Live Order Board**
A status-column view of all active orders grouped by their current lifecycle status. Each order tile is colour-coded (green/amber/red) based on how long it has been in its current status vs. expected. Filterable by order type and store.

**Section D — Team Status Panel**
Live view of every team member: shift status, open tasks vs. capacity, capacity bar, SLA compliance today. Skill gap warning displayed below if any required skill lacks coverage for the next 2 hours.

**Section E — Charts**
- *SLA Compliance by Task Type (Today):* Bar chart — red bars indicate task types performing below target
- *Task Volume This Week:* Line chart — tasks created vs. completed each day

**Section F — Recent Alerts Feed**
Compact list of the most recent alerts, with links to the full alerts log.

#### Key Interactions

- **Escalate from Risk Zone:** One click opens an escalation flow — notify a WhatsApp group, send a message, assign to a different agent, all in one modal
- **Reassign from Risk Zone:** One click opens an agent selector showing eligible agents with current capacity
- **Click through to order:** Any order ID opens the full order detail in the LabStack console
- **Filter by store:** Updates all sections simultaneously

#### Acceptance Criteria

- Dashboard data is no more than 5 minutes old at all times
- The Risk Zone shows a *"All tasks within SLA"* confirmation message when empty
- Reassigning from the dashboard notifies both the old and new assignee
- Fully functional on standard laptop browsers at 1280px wide or above

---

### 6.6 Feature: Ops Agent — Task Interface

#### Overview

The Ops Agent's interface is their primary workspace throughout the day — designed for focus and speed. The agent sees exactly what they need to do next, in priority order, with all information required to complete each task in one place.

The interface follows a two-panel layout: task list on the left, task detail on the right — similar to a modern email client.

#### User Stories

- *As an Ops Agent, I want my tasks presented to me in the right order so I always work on the most urgent thing first.*
- *As an Ops Agent, I want to see all the information about an order inside the task without switching to a different screen.*
- *As an Ops Agent, I want to follow a clear step-by-step checklist so I don't miss anything.*
- *As an Ops Agent, I want to add a note when completing a task so there is a record of what I did.*
- *As an Ops Agent, I want to flag a task as blocked when I can't progress so the Ops Head can help.*

#### Left Panel — Task List

All tasks assigned to the logged-in agent, sorted by urgency:
- Critical SLA tasks with less than 10 minutes remaining — always at top
- Breached tasks — shown above all other open tasks
- Remaining tasks by priority then time remaining

Each row shows: priority pill, task title, order number, patient name, appointment time, SLA countdown, colour-coded left border (red / amber / grey).

**Tabs:** All, Urgent, Done Today.

#### Right Panel — Task Detail

**Header:** Task title, priority, SLA countdown (large, top right), rule name.

**Order Context Block:** Patient name, appointment date/time, lab/centre name, tests/procedure, patient address, order ID with link to the LabStack console.

**Checklist:** Mandatory steps defined by the task type. All steps must be ticked before the task can be marked complete. Steps cannot be skipped.

**Completion Note:** Text field for a short note on what was done. Saved to the order record in LabStack automatically.

**Action Buttons:**
- *Mark Complete* — enabled only when all checklist steps are ticked
- *Mark Blocked* — opens a reason form; alerts Ops Head
- *Reassign* — text link for situations where the agent knows they cannot complete the task

#### Acceptance Criteria

- The task list updates in real time — a new assigned task appears within the current polling cycle without a page refresh
- The *Mark Complete* button is disabled until all checklist items are ticked
- A blocked task remains visible in the agent's list, visually distinguished
- Completion notes are optional for most task types; mandatory for high-risk types (to be confirmed — see Open Questions)
- Completed tasks remain visible under the *Done Today* tab for the rest of the shift
- The agent can only see tasks assigned to them

---

### 6.7 Feature: Store Admin — Store Dashboard

#### Overview

The Store Admin's view is a store-scoped version of the Ops Head's Command Center. It shows everything happening on their store's orders and their store's team — nothing else.

#### User Stories

- *As a Store Admin, I want to see all tasks and orders for my store in one place.*
- *As a Store Admin, I want to assign unassigned tasks to my team members.*
- *As a Store Admin, I want to see my team's workload so I can redistribute if someone is overloaded.*
- *As a Store Admin, I want to see how my store is performing on SLA week over week.*

#### Dashboard Sections

**Section A — Store Summary Bar:** Active orders, open tasks, SLA breaches today, SLA health, team members on duty.

**Section B — Order Type Health Cards:** One card per order type (Home Sample, Centre Visit, Injection) — count of active orders and current SLA compliance %, colour-coded green/amber/red.

**Section C — Store Task Table:** All open tasks for this store's orders, sorted by urgency. Each row shows priority, task name, order and patient, SLA countdown, assignee (or Assign button), and action buttons.

**Section D — My Team Panel:** Name, shift status, task count vs. capacity, capacity bar, SLA compliance today. Store team only.

**Section E — SLA Trend Chart:** Line chart of this store's SLA compliance over the past 7 days.

**Section F — Order Health Funnel:** Step-by-step funnel from order creation to completion — count and average time at each stage for the last 30 days (selectable).

**Section G — Recent Alerts:** Store-scoped alert feed for the last few hours.

#### Acceptance Criteria

- The Store Admin can only see data for stores they are assigned to
- Assigning a task from the Store Admin view updates the agent's task list in real time
- The funnel data respects the selected time range and updates immediately on change

---

### 6.8 Feature: Analytics & Reporting

#### Overview

The reporting module gives the Ops Head and Store Admins structured data to identify trends, root-cause problems, evaluate team performance, and make informed decisions about rostering, SLA targets, and process improvements. There are four report areas: SLA Performance, Team Performance, Order Health, and Incident Log.

---

#### 6.8.1 SLA Performance Report

**Purpose:** Understand how well the team is meeting SLA targets.

| Metric | Description |
|---|---|
| Overall SLA compliance | Percentage of tasks completed within SLA for the selected period |
| SLA compliance by task type | Which task types are consistently on time, which are not |
| SLA compliance by order type | Home Sample vs. Centre Visit vs. Injection |
| SLA compliance by store | How each store is performing |
| SLA compliance over time | Daily trend line — improving, stable, or declining |
| Average completion time per task type | Actual vs. SLA — helps calibrate SLA settings |
| Breach count and breach rate | Total breaches and breach rate as a percentage of tasks due |
| Near-miss count | Tasks completed within the last 5 minutes of their SLA |

**Filters:** Date range, store, order type, task type, team member.

> **Why near-misses matter:** High near-miss counts signal a team under pressure even when the headline SLA number looks acceptable.

---

#### 6.8.2 Team Performance Report

**Purpose:** Objective data on each team member's operational output — for coaching, rewarding, and resourcing decisions.

| Metric | Description |
|---|---|
| Tasks completed per agent | Total tasks completed in the selected period |
| SLA compliance per agent | Percentage of tasks each agent completed within SLA |
| Average time-to-complete per agent | Per task type — how long each agent takes on average |
| Breach count per agent | How many tasks each agent allowed to breach |
| Escalation rate per agent | Percentage of their tasks that were escalated |
| Block rate per agent | Percentage of their tasks they marked as Blocked |
| Tasks per shift hour | A productivity rate for comparing similar agents on similar shifts |
| Skill utilisation | Which skill tags are being used and which aren't |

> **Note for Ops Head:** Agent metrics must be interpreted in context. An agent handling injection assignments will naturally have lower throughput than one handling confirmations. Compare within the same task type only.

---

#### 6.8.3 Order Health Report

**Purpose:** Understand how orders are progressing through their lifecycle.

| Metric | Description |
|---|---|
| Orders created vs. completed | Total orders and how many reached a completed state |
| Cancellation rate | Percentage cancelled, with reason breakdown |
| Average time per lifecycle stage | How long orders spend at each status transition |
| Stage bottleneck flag | Automatically highlights which stage has the longest average dwell vs. expected |
| Order health funnel | Visual funnel from creation to completion with count and average time per stage |
| Rescheduled order count | How many orders were rescheduled, with reason breakdown |
| Failed visit count | For home visits — how many times a phlebo or medic could not complete the visit |
| Report turnaround time | Average time from sample delivered to report delivered, by lab partner |

**Filters:** Date range, order type, store, lab partner.

---

#### 6.8.4 Incident Log

**Purpose:** A permanent, searchable record of every SLA breach, escalation, and unassigned task event.

Each incident record includes:
- Incident type (SLA Breach / Escalation / Unassigned Task / Agent Block)
- Order and task details
- Rule involved
- Assigned agent at time of incident
- Time of breach and time of resolution
- Breach duration
- Root cause tag (applied after resolution)
- Resolution notes

**Root Cause Tags (default set):**
- Patient not reachable
- Lab portal down / API failure
- Medic unavailable
- Team capacity — no available agent
- Team capacity — agent at full load
- SOP misunderstood by agent
- Order data incorrect at source
- External delay (lab, courier, etc.)
- Other

> Over time, root cause data reveals systemic patterns — e.g., if 40% of breaches are tagged *"Lab portal down / API failure,"* that is a strong signal to negotiate an API reliability SLA with the lab partner.

---

#### 6.8.5 Automated Reports & Digests

**Daily End-of-Shift Summary** — sent to Ops Head and Store Admin(s) at configurable shift-end time via WhatsApp and in-app:
- Total orders active, tasks created / completed / breached
- SLA compliance for the day
- Unresolved tasks carried forward to next shift
- Top 3 incidents of the day
- Team attendance summary

**Weekly Performance Summary** — sent every Monday morning covering the prior week, with trend comparison to the previous week.

**Custom Report Export** — any report view can be exported as CSV or PDF, respecting current filters.

#### Acceptance Criteria

- All reports reflect data up to the most recent polling cycle
- Exports generate within 30 seconds for up to 90 days of data
- The incident log retains records for a minimum of 12 months
- Root cause tags can be applied or changed up to 7 days after resolution
- Team performance data is visible to Ops Head (all agents), Store Admin (own store's agents), and not to agents about each other

---

## 7. Key User Journeys

---

### Journey 1: New Home Sample Order — Confirmed on Time

**Scenario:** A home blood collection order is placed at 2:00 PM. The lab API is down, requiring manual portal booking. The ops agent confirms it within the SLA window.

| Step | What Happens | Who Acts |
|---|---|---|
| 2:00 PM | Order placed with status: Pending | Patient / LabStack |
| 2:02 PM | OpsFlow detects the new Pending order | System |
| 2:02 PM | Task created: *"Confirm Order #4821 with SRL Labs"* — SLA: 30 min — Priority: Critical | System |
| 2:02 PM | Assignment engine selects Riya (on duty, 2/5 tasks, SRL portal skill) | System |
| 2:02 PM | Riya receives in-app notification: new Critical task assigned | System → Riya |
| 2:05 PM | Riya opens the task, reviews order context, starts checklist | Riya |
| 2:06 PM | API returns error. Riya ticks Step 1 and Step 2 of checklist. | Riya |
| 2:09 PM | Riya logs into SRL portal, finds no existing booking | Riya |
| 2:11 PM | Riya manually books the slot for the same date and time | Riya |
| 2:13 PM | Riya updates order status to Confirmed in LabStack console | Riya |
| 2:14 PM | Riya ticks remaining steps, adds note: *"Booked via SRL portal. Ref: SRL/4821/AP"*, marks complete | Riya |
| 2:14 PM | Task closed. Completion time: 12 min. SLA of 30 min: ✓ Met | System |
| 2:14 PM | Completion note written to order record in LabStack | System |

---

### Journey 2: SLA Breach — No Medic Available for Injection Order

**Scenario:** An injection appointment is booked for 5:00 PM. The medic assignment task is created but both eligible agents are at full capacity. The Ops Head must intervene.

| Step | What Happens | Who Acts |
|---|---|---|
| 3:30 PM | Appointment confirmed for Meena Sharma — Insulin injection, 5:00 PM | Store / LabStack |
| 3:32 PM | Task created: *"Assign & Call Medic — Appt #891"* — SLA: 30 min — Requires: Injection Assignment skill | System |
| 3:32 PM | Assignment engine checks — Riya at 5/5, Arjun on leave. No eligible agent. | System |
| 3:32 PM | Task placed Unassigned. Alert fires to Rahul and Nidhi via in-app + WhatsApp | System → Rahul, Nidhi |
| 3:32 PM | Task appears at top of Risk Zone with red "Unassigned" badge | System |
| 3:35 PM | Rahul sees the WhatsApp alert, opens Command Center | Rahul |
| 3:35 PM | Rahul sees Riya is at 5/5 but her top task is nearly complete | Rahul |
| 3:36 PM | Riya completes her task, drops to 4/5 | Riya |
| 3:36 PM | Rahul manually assigns Appt #891 to Riya from Risk Zone | Rahul |
| 3:36 PM | Riya receives notification: *"New Critical task — 26 minutes remaining"* | System → Riya |
| 3:37 PM | Riya follows checklist: checks medic proximity, calls Raju P., confirms understanding, sends WhatsApp instructions | Riya |
| 3:58 PM | Riya completes task, adds note: *"Medic Raju P. confirmed. WhatsApp sent at 3:57 PM."* | Riya |
| 3:58 PM | Task closed. 22 min from assignment, 26 min from creation. SLA: 30 min. ✓ Met | System |
| 3:58 PM | Incident log records: unassigned for 4 min → manually assigned by Ops Head | System |

---

### Journey 3: T-1 Day Confirmation Batch

**Scenario:** At 4:30 PM Thursday, 6 home sample orders are scheduled for Friday. A batch T-1 confirmation task is created.

| Step | What Happens | Who Acts |
|---|---|---|
| 4:30 PM Thu | OpsFlow finds 6 Friday orders in Confirmed status with no T-1 task yet | System |
| 4:30 PM Thu | Batch task created: *"T-1 Confirmation — 6 orders for Fri 26 Apr"* — SLA: by 7:00 PM today | System |
| 4:30 PM Thu | Task assigned to Sneha (available, correct store) | System |
| 5:15 PM Thu | Sneha opens the task. Checklist has a sub-item for each of the 6 orders. | Sneha |
| 5:45 PM Thu | Sneha works through all 6. Order #4903 not found in portal — rebooked manually. | Sneha |
| 5:46 PM Thu | Sneha adds note: *"All 6 confirmed. #4903 rebooked via portal. Ref: SRL/4903/FRI."* Marks complete. | Sneha |
| 5:46 PM Thu | Task closed. SLA: 7 PM. ✓ Met | System |
| Next morning | Pre-visit and phlebo tracking tasks auto-created as appointment windows approach | System |

---

### Journey 4: SLA Breach with Full Escalation Chain

**Scenario:** An order confirmation task is missed by the assigned agent. The full escalation chain fires.

| Step | What Happens | Who Acts |
|---|---|---|
| 10:00 AM | New home sample order. Task created: confirm within 30 min. Assigned to Arjun. | System |
| 10:20 AM | SLA Warning: 10 min remaining. In-app notification sent to Arjun. | System → Arjun |
| 10:25 AM | SLA Urgent: 5 min remaining. Push notification sent. | System → Arjun |
| 10:30 AM | SLA deadline passed. Task not completed. Status: Breached. | System |
| 10:30 AM | Level 1: Arjun receives breach alert. Rahul and Nidhi receive WhatsApp. Task turns red everywhere. | System → All |
| 10:45 AM | Level 2 fires: task still open 15 min after breach. Rahul receives a second WhatsApp. Sneha receives a notification asking if she can take over. | System → Rahul, Sneha |
| 10:47 AM | Rahul reassigns task to Sneha from the Command Center | Rahul |
| 10:47 AM | Sneha confirms order via portal in 6 minutes | Sneha |
| 10:53 AM | Sneha marks task complete. Breach duration: 23 minutes. Incident logged. | Sneha |
| Later | Rahul reviews incident log, tags root cause: *"Team capacity — agent at full load."* Flags for roster review. | Rahul |

---

### Journey 5: Agent Blocks a Task

**Scenario:** An agent cannot reach the lab to follow up on a report. They flag it so the Ops Head can intervene.

| Step | What Happens | Who Acts |
|---|---|---|
| 2:00 PM | Report ETA passed on Order #4698. Task created: *"Follow up on delayed report."* Assigned to Riya. | System |
| 2:05 PM | Riya opens the task. Calls lab SPOC — no answer. Calls again — voicemail. | Riya |
| 2:10 PM | Riya clicks *Mark Blocked*. Reason: *"Lab not reachable — not answering calls or WhatsApp."* | Riya |
| 2:10 PM | Task status changes to Blocked. Rahul and Nidhi receive in-app alert. | System → Rahul, Nidhi |
| 2:12 PM | Rahul calls the lab relationship manager directly. Gets commitment for report by 4 PM. | Rahul |
| 2:13 PM | Rahul unblocks the task, adds management note, reassigns back to Riya with updated context. | Rahul |
| 2:13 PM | Riya notified: task unblocked and updated. | System → Riya |
| 4:05 PM | Report arrives. Riya uploads it and marks the task complete. | Riya |

---

## 8. Information Architecture

### 8.1 Navigation Structure

```
OpsFlow
│
├── Ops Head
│   ├── Command Center          ← Default landing page
│   ├── All Tasks
│   ├── Order Board
│   ├── Team
│   │   ├── Roster
│   │   └── Team Members
│   ├── Alerts
│   ├── Analytics
│   │   ├── SLA Report
│   │   ├── Team Performance
│   │   ├── Order Health
│   │   └── Incident Log
│   └── Configuration
│       ├── Task Rules
│       ├── Task Types
│       └── Escalation Chains
│
├── Ops Agent
│   ├── My Tasks                ← Default landing page
│   ├── Order Lookup
│   ├── Activity Log
│   └── Alerts
│
└── Store Admin
    ├── Store Overview          ← Default landing page
    ├── Store Tasks
    ├── Order Board
    ├── Team
    │   ├── Roster
    │   └── Team Members
    ├── Alerts
    └── Analytics
        ├── SLA Report
        ├── Team Performance
        ├── Order Health
        └── Incident Log
```

### 8.2 Screen Inventory

| Screen | Available To | Primary Purpose | Key Actions |
|---|---|---|---|
| Command Center | Ops Head | Real-time health of all ops | Escalate, Reassign, Filter by store |
| All Tasks | Ops Head | Full task list, all agents, all stores | Filter, Reassign, Bulk actions |
| Order Board | Ops Head, Store Admin | Visual status of active orders | Click through to order, Filter |
| My Tasks | Ops Agent | Personal task queue | View, Complete, Block, Reassign |
| Order Lookup | Ops Agent | Find any order by ID or name | Read-only order view |
| Activity Log | Ops Agent | Personal task history | Read-only review |
| Team Roster | Ops Head, Store Admin | Schedule and availability management | Mark leave, Edit shift |
| Team Members | Ops Head, Store Admin | Skill and capacity management | Edit profile, Add/remove skills |
| Alerts | All | Full alert feed | Acknowledge, View linked task |
| SLA Report | Ops Head, Store Admin | Historical SLA data | Filter, Export |
| Team Performance | Ops Head, Store Admin | Agent output metrics | Filter, Export |
| Order Health | Ops Head, Store Admin | Order lifecycle analytics | Filter, Export |
| Incident Log | Ops Head, Store Admin | Breach and escalation history | Filter, Tag root cause, Export |
| Task Rules | Ops Head only | Create and manage automation rules | Create, Edit, Pause, Delete |
| Task Types | Ops Head only | Manage checklist templates | Create, Edit |
| Escalation Chains | Ops Head only | Configure escalation behaviour | Create, Edit |
| Store Overview | Store Admin | Store-level health summary | Same as Command Center, store-scoped |
| Store Tasks | Store Admin | All tasks for this store | Assign, Reassign, Escalate |

### 8.3 Access Control Summary

| Feature Area | Ops Head | Store Admin | Ops Agent |
|---|---|---|---|
| View all stores' data | ✓ | ✗ own store only | ✗ own tasks only |
| View team performance data | ✓ all agents | ✓ own store's agents | ✗ |
| Reassign any task | ✓ | ✓ own store only | ✗ |
| Create / edit task rules | ✓ | ✗ | ✗ |
| Configure escalation chains | ✓ | ✗ | ✗ |
| Manage team profiles and skills | ✓ | ✓ own store only | ✗ |
| Manage roster | ✓ | ✓ own store only | ✗ |
| View and acknowledge alerts | ✓ all | ✓ store | ✓ own |
| Export reports | ✓ | ✓ | ✗ |
| View incident log | ✓ | ✓ own store | ✗ |
| Tag root causes on incidents | ✓ | ✓ | ✗ |
| Complete tasks | ✗ | ✗ | ✓ |
| Block tasks | ✗ | ✗ | ✓ |

### 8.4 Task Status Flow

```
CREATED
   │
   ├──► ASSIGNED ──► IN PROGRESS
   │                  /    │    \
   │           COMPLETE  BREACHED  BLOCKED
   │               │        │         │
   │           [closed]  [escalation  (Ops Head
   │                      chain]       unblocks)
   │                         │            │
   │                    REASSIGNED ◄──────┘
   │                         │
   │                    IN PROGRESS
   │                         │
   │                    COMPLETE [closed]
   │
   └──► CANCELLED [closed]
        (order cancelled or rule paused)
```

**Terminal states:** COMPLETE, CANCELLED
**States requiring action:** CREATED (unassigned), BREACHED, BLOCKED

---

## 9. Out of Scope

The following items are explicitly excluded from this version of OpsFlow.

| Item | Reason for Exclusion |
|---|---|
| User authentication and login management | LabStack's existing authentication system will be used. OpsFlow will not build its own sign-in flow in v1. |
| Patient-facing communications | Patient notifications (SMS, WhatsApp, calls) remain handled by LabStack's existing communication layer. |
| Lab partner portal integrations | OpsFlow creates tasks for humans to perform portal actions — it does not automate the portal actions themselves. |
| Phlebo or medic-facing app | Field staff use the existing LabStack app. OpsFlow tracks what ops agents do about field staff, not field staff directly. |
| Financial tracking or invoicing | Order financials, payment collection, and settlements remain in the existing LabStack system. |
| Prescription validation logic | OpsFlow creates a task to validate a prescription — it does not validate prescriptions itself. Clinical decisions remain human. |
| Camp order management (v1) | Camp orders have unique multi-phlebo logistics. Planned for Phase 5 after core order types are stable. |
| Multi-language support (v1) | Initial release in English only. Hindi and regional language support planned for a future version. |
| Mobile native application | OpsFlow is a desktop-first web application. Mobile-responsive web is in scope; dedicated iOS/Android apps are not. |
| Automated report upload to LabStack | OpsFlow creates a task for a human to upload reports. Automated report fetching is a separate engineering track. |
| Performance-based pay or incentive management | Team performance data is for operational insight, not payroll calculation. |
| Customer or patient access | OpsFlow is exclusively for internal operations staff. |
| WhatsApp Business account management | OpsFlow uses the existing LabStack WhatsApp Business account and messaging infrastructure. |

---

## 10. Phased Roadmap

### Phase 1 — Foundation: Stop Missing SLAs *(Weeks 1–8)*

**Goal:** Replace manual queue scanning with automatic task creation for Home Sample Collection orders.

**What ships:**
- Automatic task creation for all 8 Home Sample Collection task types
- Task list for Ops Agents — sorted by priority, with SLA countdown
- Task detail view — order context, checklist, completion note, mark complete / block
- SLA tracking — countdown, 10-min warning, breach detection
- WhatsApp alert on SLA breach — fires to Ops Head and Store Admin
- Unassigned task alert — fires immediately when no agent is available
- Manual assignment by Ops Head
- Risk Zone panel on Ops Head view
- Completion notes written to the order record in LabStack

**Phase 1 Success Gate:** 85% of HC_CONFIRM_30MIN tasks completed within SLA. Zero home sample orders missing a task at any point in their lifecycle.

---

### Phase 2 — Assignment Engine: Work Finds the Right Person *(Weeks 9–14)*

**Goal:** Eliminate verbal task delegation. Tasks go to the right person automatically.

**What ships:**
- Team member profiles with skill tags and store assignments
- Shift templates and daily roster management
- Automatic assignment engine — load-balanced, skill-matched, store-scoped
- Capacity tracking per agent
- Skill gap warnings
- Leave management with auto-rerouting
- Team Status panel on Ops Head and Store Admin dashboards
- Reassignment from dashboard

**Phase 2 Success Gate:** 100% of new tasks auto-assigned without Ops Head manual intervention on at least 90% of days.

---

### Phase 3 — Full SOP Coverage: All Order Types *(Weeks 15–20)*

**Goal:** Extend OpsFlow to all three SOP types and add escalation chains.

**What ships:**
- Centre Visit rules (5 task types)
- Injection at Home rules (7 task types), including correlated tracking across appointment and pharma order
- T-1 confirmation batch task (Home Sample and Centre Visit)
- Escalation chain configuration
- Rule Builder UI — Ops Head can create and edit rules without engineering
- Task Types management — checklist template editor
- Full Store Admin dashboard — overview, task table, team panel, order health funnel

**Phase 3 Success Gate:** Operations team stops using WhatsApp to delegate tasks. 100% of assignments go through OpsFlow.

---

### Phase 4 — Analytics: See the Patterns *(Weeks 21–26)*

**Goal:** Turn operational data into insight that drives decisions.

**What ships:**
- SLA Performance Report (all filters + export)
- Team Performance Report (per agent, by task type, with trend)
- Order Health Report (funnel, stage timings, bottleneck flags)
- Incident Log (searchable, with root cause tagging)
- Automated daily end-of-shift summary
- Automated weekly performance digest
- Report ETA accuracy sub-report for lab partner reviews
- Near-miss tracking

**Phase 4 Success Gate:** Ops Head uses OpsFlow reports in at least one team review or lab partner meeting before Phase 5 begins.

---

### Phase 5 — Intelligence: The System Gets Smarter *(Ongoing)*

**Goal:** Move OpsFlow from reactive tracking to proactive prediction.

**Planned (in order of priority, sequenced based on data from Phases 1–4):**
- Workload forecasting — predict tomorrow's task volume; flag if today's roster is insufficient
- Anomaly detection — surface unusual patterns automatically (e.g., breach rate spiking on a specific task type)
- Camp order support — multi-phlebo, bulk order management
- Root cause trend summaries — automated digest of what is causing the most breaches
- Cross-store benchmarking — compare SLA health and order health across store locations
- SLA auto-calibration suggestion — if a task type consistently takes longer than its SLA, surface a recommendation to adjust
- Mobile-responsive optimisation for agents not always at a desk

---

## 11. Open Questions & Decisions Needed

The following questions require a decision before development begins on the relevant phase.

---

**Q1 — How long should the polling interval be?**

A shorter interval means faster task creation but higher system load. Proposed default: 5 minutes for most task types. The pre-visit task (10-minute action window) may need a 2-minute interval.

*Decision needed:* Confirm acceptable polling interval per task type, or confirm a single interval applies to all.

---

**Q2 — Should agents be able to update order status from within OpsFlow?**

- **Option A:** Agents update status in the LabStack console directly. Simpler; clear separation of systems.
- **Option B:** Agents can update certain order statuses from OpsFlow. Reduces screen-switching, speeds up completion.

*Decision needed:* Which option for Phase 1?

---

**Q3 — How do we handle the Injection order entity relationship?**

An injection-at-home service involves both an Appointment (the visit) and a Pharma Order (the drug). Some tasks depend on both being in the correct state.

*Decision needed:* Should OpsFlow treat the Appointment as primary and check the Pharma Order as a condition, or treat both equally?

---

**Q4 — Who manages the daily roster?**

- **Option A:** Only the Ops Head manages the roster for all stores.
- **Option B:** Store Admins manage their own team's roster; Ops Head has read-only visibility and override capability.

*Decision needed:* Which model reflects how LabStack's operations team works day-to-day?

---

**Q5 — Should task completion notes be mandatory or optional?**

Proposed approach: notes are optional but strongly prompted for most task types; mandatory for high-risk types (injection assignment, order edit handling).

*Decision needed:* Confirm which task types require mandatory notes.

---

**Q6 — Should the Ops Agent see other agents' tasks in read-only mode?**

- **Option A:** Agents see only their own tasks — clean and focused.
- **Option B:** Agents can see a read-only "Team Queue" for their store — useful for informal cover.

*Decision needed:* Which model fits the team's working style?

---

**Q7 — What happens to in-progress tasks at shift end?**

- **Option A:** Tasks remain assigned to the agent; the next shift picks them up after an Ops Head alert.
- **Option B:** At shift-end, incomplete tasks are automatically returned to the Unassigned queue and the incoming team is notified.

*Decision needed:* Define the shift-handover behaviour.

---

**Q8 — Which WhatsApp number should OpsFlow alerts use?**

OpsFlow needs to send alerts via WhatsApp. LabStack already has a WhatsApp Business account.

*Decision needed:* Confirm OpsFlow can use the existing LabStack WhatsApp Business account, and confirm ops team numbers are registered in the LabStack system.

---

**Q9 — What is the SLA for each task type — confirmed numbers?**

The spec uses SLA values derived from existing SOPs. These should be formally confirmed by the Ops Head as enforceable targets before development begins.

*Decision needed:* Review and sign off on the SLA matrix for all task types across all three order types.

---

**Q10 — Is the pilot store-scoped or cross-store from Day 1?**

- **Option A:** Pilot on one store first. Lower risk, faster iteration.
- **Option B:** Roll out to all stores on Day 1. More data, faster validation.

*Decision needed:* Confirm pilot scope before Phase 1 development begins.

---

*End of Document — OpsFlow Product Requirements v1.0*
*For questions or feedback, contact the Product Team.*
