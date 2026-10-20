# Order journey agent — design

Status: proposal (Oct 2026). Builds on the message rules engine (DESIGN.md).

Two asks:
1. **Fewer, shorter messages.** Five samples to check at 9 am should be one
   message, not five, so labs read it and answer it.
2. **Get orders delivered, not just messaged.** The bot should behave like a
   good ops manager: know what each order is waiting for, hold people to what
   they promise ("report by 6 pm"), check back at that time, and escalate
   when things are stuck.

---

## 0. Ground truth that shapes everything

| Fact | Consequence |
|---|---|
| OpsFlow is **read-only on LabStack** (by design; see `engine/labstack.ts`). | The bot cannot move an order to the next stage itself. Today a stage moves only when the **lab** acts in LabStack (the confirmation link) or an **ops agent** does. "Moving the order" = making that happen fast, then confirming it happened. A direct write is a later phase that needs a narrow LabStack API. |
| The rules engine is level-triggered, every minute, with a send ledger. | Batching and follow-ups fit as layers on it: rules decide *what is due*, a new delivery layer decides *how it is grouped and phrased*. |
| Lab replies are already read as facts (eta, phlebo, report shared, …). | Facts with a time in them are **promises**. That is the missing piece for "check back at 6 pm". |
| Calls (Exotel), ops tasks (Task Rules) and the console exist. | The escalation ladder can go beyond WhatsApp without new infrastructure. |

---

## Part 1 — Message UX: short, batched, answerable

### Principles

1. **One message = one ask to one lab.** "What's the status of these 5?" not
   five messages.
2. **Full details once.** The new-order intro carries the address, map, tests.
   Every follow-up is one line per order: ref, first name, time, the one thing
   missing.
3. **Answerable in one line.** Numbered items, and the reply format printed in
   the message: `1 done, 2 not home, 3 at 5 pm`.
4. **Predictable rhythm.** Labs get messages at known slots, not a drip all
   day. Predictability is what builds response habits.
5. **Urgent stays separate.** "Appointment in 10 minutes, no phlebo" goes
   immediately and alone.

### How batching works

Rules keep deciding per order ("order X needs a status check now"). Instead of
sending, a due item goes to an **outbox** keyed by *lab × intent*. A batcher
sends each outbox at its next **slot**:

| Intent | Slot | Max wait |
|---|---|---|
| New orders (intro) | every 15 min | 15 min |
| Unconfirmed reminders | :00 and :30 | 30 min |
| Phlebo / ETA check | :00 and :30 | 30 min (never past the appointment) |
| Status check after visit | :00 and :30 | 30 min |
| Report chase | 10:00, 14:00, 18:00 | next slot |
| Urgent (P0: 10 min to appointment, manager escalation) | immediately | 0 |

- One order appears in at most one message per slot. If it is due for two
  things, the more urgent wins (same rule as today).
- A batch of 1 uses the same short format, so labs see one consistent shape.
- Per-lab **message budget** (e.g. at most 6 messages an hour, 30 a day,
  urgent excluded). Over budget, items roll to the next slot and the ops board
  shows the overflow.
- Each item still writes its own ledger row, so repeats, "stop on answer" and
  retroactive rule edits work exactly as now.

### Template shape

```
🔎 *Status check · 3 orders*

1. #88704 · Manjusha · 7:00 am
2. #88711 · Ravi · 7:30 am
3. #88730 · Asha · 8:00 am

Reply: *1 done, 2 not home, 3 at 5 pm*
or *all done*
```

```
⏰ *Phlebo for today · 2 orders not assigned*

1. #88802 · Neha · 11:00 am · Baner
2. #88810 · Arjun · 12:30 pm · Kothrud

Reply with the name and number:
*1 Ramesh 98xxxxxx01, 2 Suresh 98xxxxxx02*
```

```
📄 *Reports pending · 4*

1. #88501 · Kavita · collected yday 8 am (26 h)
2. #88507 · Sanjay · collected yday 9 am (25 h)
…
Reply: *1 shared, 2 by 6 pm*
```

```
🆕 *New order #88910* — confirm: https://console.labstack.in/confirmation/…
Priya · Sat 11 Oct, 9:00 am
📍 Flat 9, … Dwarka · 🗺️ maps link
🧪 Full Body Check (CBC, LFT, KFT …)
```

Template parts become blocks, so ops can edit wording without breaking the
structure: **header** (`{{intent_title}} · {{count}}`), **item line**
(`{{n}}. #{{order_ref}} · {{first_name}} · {{time}} {{extra}}`), **reply hint**,
**footer**. The full-detail block is used only by the intro and the evening
list.

### Reading batch replies

- The reply quotes the batch, or arrives while one batch is open. The batch's
  item list goes to the reader as context. Claude reads `1 done, 2 not home, 3
  at 5 pm` into one fact set per item; `all done` covers every item.
- An item number it cannot place, or a reply that contradicts LabStack, is not
  guessed. That message goes to the review queue (Part 2, guardrails).
- Per-item outcomes stop that item's repeats only.

---

## Part 2 — The order journey agent

### The mental model

A good ops manager keeps, for every open order:

- **where it is** (stage, from LabStack);
- **what it is waiting for** and **from whom** (lab, phlebo, report desk, us);
- **when that is due**: a rule's deadline, or what someone **promised**;
- **what to do if it does not happen** (check back, nudge, call, escalate).

The agent is that, written down. Each open order has a **journey record**:

| Field | Example |
|---|---|
| stage | SAMPLE_COLLECTED |
| waiting_for | report, from the lab |
| due_at | 18:00 (the lab promised "report by 6 pm") |
| source | promise (from a reply), or rule (TAT default) |
| next_check_at | 18:15 |
| health | on track / at risk / stuck |
| owner | bot / ops agent (when taken over) |
| attempts | 1 of 4 |

### Promises: "report by 6 pm" → check at 6:15

Facts with a time become **commitments**:

| Lab says | Commitment | Kept when | If missed at due + grace |
|---|---|---|---|
| "phlebo reaching by 10:30" | ETA 10:30 | status ≥ SAMPLE_COLLECTED | "Did the phlebo reach #88704?" |
| "report by 6 pm" | report 18:00 | REPORT_DELIVERED, or "shared" | "Report for #88501 was due at 6. Update?" |
| "rescheduled to tomorrow 5 pm" | new visit 17:00 | LabStack shows the new time | Ask ops to update LabStack (bot can't), rebase reminders |
| "will confirm in 1 hour" | confirm +60 min | ORDER_SCHEDULED | reminder at +60 |

- A new promise **supersedes** the old one, and the count of broken promises
  is kept per order and per lab. Two misses means the order goes up the
  ladder, not another polite check.
- Rules get a new timing: **minutes after the commitment's due time**, next
  to "minutes after appointment" and the others. The existing check-back
  messages are ordinary rules on it, editable on the Message Rules page.
- Commitments without a time ("will check", "ok") start a default clock
  (e.g. 2 h) rather than none.

### Auto-replies: confirm what was understood

When the bot reads a reply with confidence, it answers once, briefly:

> ✅ Noted: #88501 report by 6 pm. I'll check back at 6:15.

> ✅ Noted for 3 orders: 1 collected, 2 not home (I'll ask ops to call the
> patient), 3 rescheduled to 5 pm (ops will update LabStack).

This closes the loop, shows the lab that replies are read (which improves
adherence), and lets a lab correct a misreading immediately. Rules:
template-based (no free LLM text), one ack per lab message, none for
"ok"/"thanks", none under the confidence threshold. A misread is corrected by
replying, which supersedes it.

### The escalation ladder (per stage)

Each step runs only if the previous one got no useful answer within its
window.

1. **Ask** in the lab group (batched).
2. **Remind** in the group, mentioning the lab's assigned person by name
   (mentions now resolve).
3. **Manager**: personal WhatsApp to the lab manager (exists today).
4. **Call**: Exotel call to the lab manager. Phase 3 starts with a one-click
   "Call now" task for an ops agent; bot-placed calls come after review.
5. **Ops task**: an OpsFlow task for an ops agent with full context and the
   one action needed (e.g. "Lab says rescheduled to 5 pm — update the
   appointment in LabStack", with the console deep link).
6. **Ops head**: anything stuck past its stage SLA shows in a "Stuck orders"
   view with the full trail.

### Making the order move (the read-only problem)

What moves the stage, in order of when it can ship:

| Phase | How the stage moves | Bot's part |
|---|---|---|
| Now | Lab uses the **confirmation link** | Sends the link, checks the status changed |
| 3 | **Ops agent** acts on a task with a deep link | Writes the task with the exact change, verifies it landed |
| 4 | **More lab action links** from LabStack: collected, reschedule (pick a time), upload or link a report | Puts the right link in each item line; one tap moves the order |
| 5 | **Narrow LabStack write API** for the bot (status + note + audit, 3–4 transitions) | Proposes the change from a reply ("lab says collected"). An ops agent approves with one click; later, high-confidence safe transitions apply automatically |

Phase 4 needs LabStack work, and it is the biggest lever: the lab does the
update itself in one tap, from the message it is already reading.

### Guardrails

**Deterministic decisions, bounded AI.** The state machine and rules decide
*what* happens. Claude only (a) reads replies into facts with a confidence
score and (b) never writes free-form outbound text. All outbound text comes
from templates.

| Guardrail | Detail |
|---|---|
| LabStack wins | A status change in LabStack resolves commitments; the bot never argues with it. |
| Confidence threshold | Facts below threshold (e.g. 0.7) don't act or auto-reply. They go to a **review queue** in the console: accept, correct or dismiss in one click. |
| Message budget | Per lab per hour and day; per order per day; quiet hours; urgent exempt but capped. |
| Recipients | Lab groups and lab managers only. Never patients. Calls only to lab managers on file. |
| Take over | Ops can "take over" an order (bot pauses it) or "snooze until …". Any manual console message on an order pauses its bot follow-ups for 2 h. |
| Shadow first | Each new capability (batching, promises, auto-replies, calls) ships in shadow per lab: it logs what it would do, and the console shows it. It goes live per lab. |
| Kill switches | Global and per capability. |
| Audit | Every action carries its reason: "Checked back because the lab promised the report by 18:00 (reply 14:02, Kavita) and LabStack still shows SAMPLE_COLLECTED." |
| Stop rules | Cancelled or delivered orders stop everything. Order-level attempt caps. Two broken promises escalate instead of repeating. |

### What ops sees

- **Journey timeline** per order: messages, replies, facts, promises,
  missed/kept, bot actions with reasons.
- **Needs attention board**: stuck, at-risk, review queue, overflow, taken
  over. Sorted by appointment and SLA risk.
- **Lab scorecard**: response rate, median response time, promises kept %,
  TAT vs SLA. This feeds the Lab Config priority sort and gives managers a
  fact base for lab conversations.

---

## Data model (additive)

- `order_commitments`: orderId, labId, kind (eta / report / reschedule /
  confirm / custom), dueAt, sourceFactId, status (open / kept / missed /
  superseded), createdAt, resolvedAt.
- `provider_outbox_items`: labId, intent, orderId, ruleId, occurrence,
  payload, slotAt, status (queued / sent / rolled / dropped), batchId.
- `provider_batches`: labId, intent, sentAt, outboundId, itemCount (replies
  map back through the outbound id).
- `order_journeys`: orderId, stage, waitingFor, dueAt, nextCheckAt, health,
  owner (BOT / user id), pausedUntil, attempts.
- `provider_fact_reviews`: the review queue.

The ledger stays the source of truth for "was item X of rule Y sent".

---

## Phased rollout

| Phase | Ships | Measured by | Gate to next |
|---|---|---|---|
| **1. Batching + short templates** (≈2 wks) | Outbox + slots, batch templates, numbered replies, batch reply reading, per-lab budget. Shadow per lab, then live. | Messages per order ↓, lab response rate ↑, time to first response ↓ | Response rate up on pilot labs; no missed urgent sends |
| **2. Promises + auto-replies** (≈2 wks) | Commitments from replies, "after commitment due" timing, check-back rules, template acks, journey timeline, review queue | % promises kept, stuck orders ↓, misreads caught in review | Misread rate under the threshold in review |
| **3. Escalation ladder + hand-off** (≈2 wks) | Mention assigned person, ops tasks with deep links (humans move the stage), bot calls to lab managers, take over / snooze, Needs-attention board, lab scorecard | Time stuck per stage ↓, tasks closed per day | Ops agree the tasks are the right ones |
| ~~**4. Lab action links**~~ deferred: humans move stages (decision 1) | Collected / reschedule / report links in item lines | Stage changes made by labs from messages | LabStack API agreed |
| ~~**5. Assisted writes, then autonomy**~~ deferred | Bot proposes LabStack changes with one-click approval; auto-apply for safe transitions on proven labs; bot-placed calls | Approval rate, reversals | Per lab, per transition |

Each phase is useful alone, and each is behind per-lab flags and shadow mode,
so the current setup keeps working while a pilot runs.

## Phase 1 status (12 Oct 2026): built

- Per lab: **Combined messages** = Off / Preview only (SHADOW) / On (LIVE), and
  a cap of combined messages per slot (default 3), on the Lab Config form,
  with the lab's recent combined messages (sent or preview) listed below it.
- Rules still decide per order; on a LIVE lab a combinable item waits for its
  slot (`provider-rules/batching.ts`) and goes out with the lab's other items
  for the same ask. Each order keeps its own ledger row, message-log row and
  timeline event, so repeats, stop-on-answer and retroactive edits are
  unchanged. Catch-up counts from the slot, plus 60 min of slack.
- Not combined: new-order messages (unlike the table above, intros stay
  per order in Phase 1, because they carry the full details and the confirmation
  link), P0 rules, and summaries.
- Replies: quoting a combined message, or replying right after one, is split
  per number ("1 done, 2 not home"), by order id, or "all …"; each part is read
  into facts for its order and stops that order's repeats. A reply that quotes
  a combined message but cannot be placed is not guessed.
- Templates: `BATCH_*` (one per ask) on the Templates page; the per-order
  line format is fixed in code so numbering can't break.
- Tests: unit tests, scenarios 13–16 (`npm run test:comms`), and
  `COMBINED=1 npm run demo:comms` for the demo labs with full message text.
- Watch: with combined messages on, "Pending reports — morning list" (10:00)
  and the combined report chase (10:00 / 14:00 / 18:00) cover the same
  orders. Keep one of the two on for such labs.

## Decisions (12 Oct 2026)

1. **Moving the stage: humans, for now.** No LabStack action links or write
   API are planned. Stages move when the lab uses the confirmation link or an
   ops agent acts on a task with a console deep link (Phase 3). Phases 4–5
   become "later, if ever"; the bot's job is to get the right human to act
   fast and to verify it happened.
2. **Slots: fixed** (:00 / :30, report chase at 10:00 / 14:00 / 18:00).
3. **Calls: the bot may call lab managers** (Exotel), within the call
   guardrails (budget, hours, lab managers on file only). Moves from Phase 5
   into Phase 3.
4. Pilot labs: still to pick. Every capability ships OFF / SHADOW / LIVE per
   lab, so the pilot is chosen at rollout.

## Phase 1b (20 Oct 2026): built

From the chat review (CHAT-REVIEW-OCT-2026.md):
- **Coordinators**: per lab, picked on Lab Config from the group's members
  (lab people first, busiest first). Every combined message and follow-up
  starts by @mentioning them (`{{coordinator}}`); without one it says "Team".
- **Follow-ups in-thread**: when every order in a send was in one combined
  message in the last 24 h, the bot replies to (quotes) that message, keeps its
  numbers and names only what is open — "@desk still open: 2 🙏"; from the
  third ask, "reminder — 2 still pending since 10:30 am…".
- **Daily rhythm** per ask (`DAILY_SLOTS`): confirmations hourly 09–20,
  escalations every 2 h, phlebo from 08:30 every 2 h, status 11:00 / 13:30 /
  16:00 / 18:30, reports 10:30 / 16:30, overdue 12:00 / 17:00. Nothing before
  08:30 or after 20:00. Asks within 90 min of a visit go immediately.
- **Per-day cap** (default 8, manager escalations exempt). Held items wait for
  their ask's next slot, never sent at an odd hour; combined items may now
  carry over a day instead of being dropped.

## Toward 95% autonomy

The goal (20 Oct 2026): the bot runs ~95% of orders end to end, like a full
ops person, with people needed for the rest only. What a person does today
in the lab groups, and what the bot needs to do it:

| Today, done by a person | Share of team messages* | Bot can do it now? | What it needs |
|---|---|---|---|
| Chase status / reports / phlebo, @mention, hourly | ~40% | **Yes** (Phase 1b) | — |
| Escalate to the lab manager, then call | some | Partly: manager WhatsApp yes | **Bot calls** (approved): Exotel call to the lab manager when the 3rd ask goes unanswered |
| Post patient / booking details for a new booking | ~25% | Partly: new-order message | Send it the moment the order exists, in the format labs already use |
| Serviceability checks (pincode lists) before an order exists | ~8% | No | A source for incoming bookings/requests before they become orders, and a "can you serve X?" ask |
| Act on lab-raised problems ("customer unreachable", "address wrong") | some | No | Read these from replies (the reader already can) **and reach the customer or partner** |
| Reschedule / cancel | few | No | The lab updates its portal (bot asks), or LabStack writes |

*Lab A, 5–20 Oct; categories overlap.

**Decisions needed to get past ~60–70%:**
1. **Customer contact.** May the bot call or WhatsApp the patient when the lab
   can't reach them ("phone switched off"), or message the partner/store group?
   Today it may only talk to labs. This is the largest class of exceptions in
   the chats.
2. **Pre-order bookings.** Where do new bookings/requests come from before
   they are LabStack orders (for serviceability asks)?
3. **Who closes the loop in LabStack.** Labs updating their own portal (the bot
   asks and verifies) works without writes; reschedules and cancellations
   initiated by the bot need either the lab or a LabStack write.

**Autonomy rate** (to track the 95%): orders delivered with no LabStack team
message about them in the lab group. Computable from wa_messages + LabStack;
goes on the lab scorecard.
