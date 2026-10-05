# Provider communication rules — design

Status: **proposal, for review.** Nothing here is built yet.

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

## 7. Replies

A rule may attach a poll. Each option is one of:
- **record** — save the answer on the item's timeline (status check today);
- **ask for detail** — save the provider's next message as the reason/ETA;
- **stop this rule** for the item (e.g. "Report shared");
- **stop all chasing** for the item.

Answers are recorded in OpsFlow only. Nothing is written to LabStack.

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
2. **New capabilities.** `statusNotIn`, phlebo fields in templates, ETA reply,
   summaries as rules (pending reports), dry-run preview.
3. **New sources.** Appointments, then PharmaOrder; provider directory;
   EDTA / injection as type filters.

## 11. Open questions

1. Catch-up window: 30 minutes by default — agreed?
2. Phlebo questions to the lab group only, or also direct to the phlebo's number
   (different channel, needs consent)?
3. ETA as a poll (on time / 15 / 30+ min late) or free text?
4. Appointments and PharmaOrder: which field identifies the provider, and which
   statuses mean "pickup pending" for injection / EDTA services?
5. Should Task Rules and communication rules share one editor (one rule, two
   possible actions), or stay as two lists over the same building blocks?
