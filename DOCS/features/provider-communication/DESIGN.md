# Provider communication rules — design

Status: **stage 1 built** (Oct 2026) — message rules engine on Lab Orders,
built-in rules matching the previous steps, Shadow/Live switch, rules page at
Provider Communication → Message Rules. Stages 2–4 are still proposals.

## 1. The idea in one paragraph

A **communication rule** is a Task Rule whose action is *"send this provider a
WhatsApp message"* instead of *"create a task for an agent"*. It picks a data
source (Lab Orders, Appointments, PharmaOrder, …), filters it by type / status /
store, and fires on the same trigger conditions Task Rules already use. Like
Task Rules, it is **re-evaluated against the current state of every open item on
every cycle**, so adding, editing, pausing or deleting a rule applies to all
relevant orders straight away — retroactively — with no backfill step.

## 2. Why build on Task Rules

Task Rules already solved the three hard parts:

| Need | What Task Rules already have |
|---|---|
| Any data source | `DataSource` registry (`public."Order"`, `public."Appointment"`, `public."PharmaOrder"` are registered); per-source polling with error isolation (`poller.ts → pollNonOrderSources`) |
| Flexible timing | `triggerCondition`: `statusIn`, `minutesSinceCreated`, `minutesSinceStatusUpdated`, `minutesBeforeAppointment`, `minutesAfterAppointment`, `metadataConditions` (`exists`, `equals`, `contains`, `>`, `<`, … with optional time offsets) — evaluated by `evaluateTrigger()` |
| Retroactive | Level-triggered: each cycle asks "does this item match this rule *now*?"; dedup is keyed on `(entityType, ruleId, entityId)` |

What the current provider-communication engine does instead — plan a fixed
schedule when an order arrives — is exactly why rule edits don't reach existing
orders, why it only knows Lab Orders, and why there are three separate
mechanisms (sequence steps, deadline watchers, the digest). This design replaces
those with one.

## 3. The rule

```
CommunicationRule
  name, isActive, version

  -- WHAT IT WATCHES (same as TaskRule)
  dataSourceId                       Lab Orders | Appointments | PharmaOrder | …
  allowedTypes, allowedStatuses,     same semantics as TaskRule (empty = any)
  allowedStores
  allowedProviders                   provider ids (labs, centres, pharmacies); empty = any configured
  triggerCondition                   the TaskRule TriggerCondition, unchanged

  -- WHAT IT DOES
  kind              PER_ITEM | SCHEDULED_SUMMARY
  templateKey       message template (picked as we go)
  pollKey?          optional poll definition attached to the message
  recipient         PROVIDER_GROUP | PROVIDER_MANAGER

  -- HOW OFTEN (PER_ITEM)
  repeatEveryMinutes?   null = send once per item
  maxSends              default 1
  catchUpMinutes        default 30 (see §5)

  -- WHEN (SCHEDULED_SUMMARY)
  sendAt            "19:00" local, per provider
  window            which items to list: e.g. appointment tomorrow, or
                    "statusIn + minutesAfterAppointment" for pending reports
  skipWhenEmpty     default true
```

`PER_ITEM` rules send one message about one order/appointment.
`SCHEDULED_SUMMARY` rules send one message per provider listing the items that
match, at a time of day. The same `triggerCondition` selects items in both.

Two small additions to the shared `TriggerCondition`, useful to Task Rules too:

- `statusNotIn` — "not yet PHLEBO_ASSIGNED" without listing every other status.
- `minutesSinceStatusEntered` alias of `minutesSinceStatusUpdated`, for readability.

## 4. The engine loop (every minute, per source)

```
for each active source:
  items   = open items in a bounded window (appointment ±N days / not closed)
  rules   = active communication rules for this source
  for each (rule, item) that passes type/status/store/provider filters:
    if not evaluateTrigger(item, rule.triggerCondition, now): continue
    occurrence = next occurrence for (rule, item) from the send ledger
    if occurrence > rule.maxSends: continue
    if occurrence > 1 and last send < repeatEveryMinutes ago: continue
    if trigger moment (§5) is older than catchUpMinutes and occurrence == 1: record MISSED, continue
    queue message (template + optional poll) to the provider's group
    write ledger row (rule, ruleVersion, entityType, entityId, occurrence)
```

Then, at most **one message per item per minute** (highest-priority rule wins),
the quiet window, and per-provider send windows apply exactly as today.

Summaries run in the same loop when a provider's `sendAt` slot opens, with the
existing once-per-day key.

### The send ledger replaces the pre-planned schedule

| | Today | Proposed |
|---|---|---|
| Stores | Future messages (`lab_scheduled_actions`) | Past sends only (`provider_message_ledger`) |
| Rule edit | Existing orders keep the old plan | Next cycle uses the new rule |
| Rule deleted | Planned rows still fire unless cleaned up | Nothing to clean up |
| Duplicate guard | Idempotency key per planned row | Unique `(ruleId, entityType, entityId, occurrence)` |

## 5. Retroactive changes, safely

In plain terms: the catch-up window decides what happens when a rule's moment
for an order has **already passed** by the time the rule first sees that order
(a new or edited rule, or the app coming back after downtime). Example — at
3:00 pm you create "remind 1 hour after the order if still unconfirmed":
an order from 2:45 pm is due at 3:45 → sent normally; one from 1:50 pm was due
at 2:50, ten minutes ago → sent now; one from yesterday → skipped and logged.
Without it, a new rule would message every old open order at once.

Because evaluation is continuous, edits apply on their own. What needs a policy
is a rule whose moment **has already passed** for existing items — without one,
creating "remind 1h after order" would message every open order at once.

Every trigger has a computable **trigger moment**: `createdAt + minutesSinceCreated`,
`appointment − minutesBeforeAppointment`, `appointment + minutesAfterAppointment`,
`statusUpdatedAt + minutesSinceStatusUpdated` — the latest of those present.

- **Moment within `catchUpMinutes` (default 30)** → send now.
- **Older** → skip the first send and record it as *missed*; repeats still
  follow from "now" if the rule repeats and the condition still holds.
- **Rule paused or deleted** → nothing further is sent.
- **Rule edited** → bumps `version`; already-sent occurrences are not re-sent
  (the ledger keys on the rule, not the version), but the new timing/condition
  governs every next decision.

**Preview before saving.** The rule editor shows, from a dry run of the same
evaluator: *"Matches 214 open items across 37 providers. 12 would be sent now,
41 skipped as too late, 161 later."* — the Task Rule simulator already does
this for tasks.

## 6. Recipients across sources

A rule message goes to the **provider** responsible for the item. Each source
declares how to find it (a field path, configured once per source):

| Source | Provider field | Notes |
|---|---|---|
| Lab Orders | `Order.labId` → Lab | as today |
| Appointments | via `slot_id` / `providerGroup_id` → Provider | **to confirm** |
| PharmaOrder | store / pharmacy id | **to confirm** |

`NonApiLabConfig` (keyed by labId) generalises to a **provider directory**:
`(providerKind, providerId) → WhatsApp group / number, manager, active, send window`.
Lab Config becomes the "Labs" view of that directory.

## 7. Replies — free text, about anything

Decision: replies are **free text**, and not only answers to a question. Every
message from a provider in its group (or from its named individuals) is
captured and attributed to the item it is about:

1. **Which item.** The reply quotes our message (WhatsApp reply-to), or names an
   order id / patient, or is the only open question in that group. Otherwise it
   is attached to the provider, unassigned, for the desk.
2. **What it says.** An extraction step (Claude — the gateway already uses it)
   turns the text into **facts** on the item, each with the source message and
   a confidence: `eta`, `phlebo_name`, `phlebo_phone`, `delay_reason`,
   `sample_collected`, `patient_unavailable`, `new_appointment_time`,
   `report_shared`, `cannot_fulfil`, free `note`.
3. **What it changes.** Rules can use facts in conditions, exactly like source
   fields: e.g. "stop the report chase when `report_shared` is set", "if
   `eta` is later than the appointment + 30 min, alert the desk". Facts never
   write to LabStack.

Polls stay available for yes/no style questions where a one-tap answer is
enough, but they are optional, not the main channel.

## 7b. Recipients

Decision: everything goes to the **lab's group** or to **named individuals at
the lab** (manager, coordinator). Never to phlebos or patients directly.

## 7c. Toward agents

The rules stay the predictable **trigger layer**. An agent is a new kind of
**action** a rule can hand off to, with a goal and limits:

```
rule fires → WhatsApp → no useful reply in N min
  → agent, goal: "get the phlebo's name and ETA for order 87668"
      allowed: nudge group → message manager → call lab (Exotel) →
               transcribe + extract → create an OpsFlow task with everything tried
      limits:  max attempts, max calls, working hours, cost cap
```

Already in place: Exotel calls with per-order call history and recordings,
Whisper transcription, Claude in the gateway, OpsFlow tasks with assignment and
escalation, the per-item timeline as the audit trail.

To build: the agent loop (goal + tools + stop conditions), per-rule guardrails
("may call", "ask a human first"), and later a live voice agent (today calls are
transcribed after the fact). Independent actions in LabStack itself (reassign,
reschedule) need write APIs that OpsFlow deliberately does not have today — until
then the agent's strongest move is putting the right human on it with full
context.

## 8. Your six communications as rules

| # | Source · filter | Trigger condition | Send / repeat |
|---|---|---|---|
| 1 | Lab Orders · HOME_SAMPLE | `statusIn` any open, `minutesSinceCreated: 0` | once: new-order message with confirmation link |
| 1b | same | `statusIn [PENDING, CREATED]`, `minutesSinceCreated: 60` | every 120 min, max 3: reminder |
| 2 | Lab Orders | summary: appointment tomorrow, not cancelled | daily 19:00 per lab |
| 3 | Lab Orders | `statusNotIn [PHLEBO_ASSIGNED, …collected]`, `minutesBeforeAppointment: 120` | every 30 min, max 3: "assign a phlebo" |
| 3b | Lab Orders | `statusIn [PHLEBO_ASSIGNED]`, `minutesBeforeAppointment: 60` | once: phlebo name/number from LabStack + "on time?" poll (ETA as detail) |
| 4 | Lab Orders | `statusNotIn [collected…]`, `minutesAfterAppointment: 30` | once: status check + poll |
| 5 | Lab Orders | `statusIn [SAMPLE_COLLECTED … PROCESSED]`, `minutesAfterAppointment: 720` | every 180 min, max 4: report chase |
| 6 | Lab Orders | summary: collected, not REPORT_DELIVERED, `minutesAfterAppointment: 720` | daily, per lab: pending reports |
| — | Appointments · HOME_VISIT / INJECTION | same building blocks | per the flow |

## 9. What happens to what exists

- **Built-in steps** (new order, 1h/3h/5h, status check, evening list) become
  **seeded rules** on the Lab Orders source with today's timings — same
  messages, nothing visible changes on day one.
- **Deadline watchers** become ordinary rules (they are already "condition +
  repeat").
- `lab_scheduled_actions`, the ladder, the status-check sweep and the per-lab
  SLA minutes retire once the ledger engine is live.
- Conversations (`lab_communication_workflows`) stay as the per-item timeline,
  keyed by `(entityType, entityId)` instead of `orderId`.
- Templates keep working; variables come from the source's
  `metadataFieldMapping`, so a new source brings its own fields.

## 10. Stages

1. **Engine on Lab Orders, behaviour-identical.** Rule model, ledger, catch-up,
   seeded rules matching today, rules page in plain language. Retroactive edits
   land here.
2. **New capabilities.** `statusNotIn`, phlebo fields in templates, free-text
   reply capture + fact extraction, summaries as rules (pending reports),
   dry-run preview.
3. **New sources.** Appointments, then PharmaOrder; provider directory;
   EDTA / injection as type filters.
4. **Agent actions.** Escalation beyond WhatsApp: individual nudges, calls,
   task hand-off, with per-rule guardrails.

Status (Oct 2026): stages 1 and 2 are built, and message rules are the only way
labs are messaged. On first boot a one-time move (`ensureMigratedToRules`) seeds
the built-ins, gives labs with custom timings their own copies, converts timed
rules and deadline watchers, credits earlier sends to the rule that now owns
them (so nothing is sent twice) and retires the old scheduler's queue.

### Testing it locally

`npm run test:comms` (`scripts/provider-comms-sim.sh`) creates orders in a
throwaway LabStack copy (`labstack_sim`), runs the real minute tick through a
simulated day against a scratch OpsFlow DB, plays lab replies and poll taps,
and prints what each lab would receive, without sending anything:

```
[Wed 7 Oct 10:00] Message 2 → Sim Lab A group: Reminder — 1 hour after the order · order-2
[Wed 7 Oct 14:00] Message 4 → Sim Lab A manager: Final reminder — 5 hours after the order · order-2
```

Each scenario states the messages it expects and the run fails on any
difference: new order + confirmation, 1h/3h/5h, evening list, phlebo assign and
ETA stopped by replies, status check answered by poll, report chase stopped by
a reply, pending-reports list, retroactive rule edit, cancelled order and
paused rule, and the upgrade from the old scheduler. Patient details are never
printed. Pass a word to run matching scenarios only (`npm run test:comms -- phlebo`).

## 11. Decisions and open questions

Decided (Oct 2026):
- Catch-up window: 30 minutes default (a safety setting, see §5).
- Recipients: lab groups and named individuals at the lab only.
- Replies: free text about anything, extracted into facts (§7).
- Task Rules and communication rules: two separate lists for now.
- Agent behaviour (§7c) is the direction; the rule engine is built so an
  "agent" action can be added later.

Later:
- Appointments and PharmaOrder: provider field and "pickup pending" statuses.
- LabStack write access for agent actions.
