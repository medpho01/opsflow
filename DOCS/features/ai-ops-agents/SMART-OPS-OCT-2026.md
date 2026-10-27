# The smart ops build (27 Oct 2026)

What OpsFlow does end to end after this build, where each piece lives, and how
to operate it. The target, in Abhishek's words: a tracker that follows every
order; exceptions that are checked, escalated and told to stores in advance;
store requests serviced and tracked until closed; and a system that learns.

## 1. The order tracker

- Every open order has a journey with checkpoints for its type; the sweep
  reads LabStack fresh and wakes what changed (`journey/`).
- Reports are tracked for 30 days after the visit (`journey/window.ts`), chased
  as one combined list per lab at 10:30 and 16:30, one ladder rung a day.
- Lab replies are linked to orders by: the message they quote, the lab's own
  reference, the order id, the patient's name or phone, a report file named
  after the patient, or what the vision model reads in a screenshot
  (`provider-rules/replies.ts`, `match-patient.ts`, `wa/vision.ts`).
- Every connected lab gets the new-order message (gathered for 10 minutes)
  and the evening "Tomorrow's orders" list, whatever its desk state — no
  per-lab switch. Both are LAB SOP policy (`params.briefings`), as is when each
  checkpoint is due (`asks.<checkpoint>.dueOffsetMin`, by order type and lab)
  and how often a silent manual lab is asked again (`reaskEveryMin`, daily).
  The old message rules now send only what the SOP tells them to; every
  manual lab's Lab desk should be LIVE, and the health check names any that
  is not. The team should not build the list by hand.

## 2. Exceptions

- Lab facts reach the store the moment they land: not reachable (with the lab's
  slots), rescheduled, sample owed, cannot do, cancelled — one coherent alert
  per lab message, never twice in 2 h, never at night (`journey/step.ts`,
  `curateStoreAlerts`).
- A lab's cancellation in the console tells the store with the reason; the ops
  group hears it when the sample was already collected or the area is
  non-serviceable. A customer's own cancellation through the store's API tells
  nobody.
- The ladder: ask → reminder → manager → task → stuck. With no manager number,
  the escalation goes to the ops group; "stuck" always does.
- Stores get their day three times a day (`store/digest.ts`), and the 20:30
  warning the evening before an early visit with no phlebo named.

## 3. Store requests

- Every request opens a thread (`store/threads.ts`, `agent_threads`): the order,
  the kind, who it waits on (the lab for status, slots, reports; our team for
  reschedules, cancels, changes, bookings, serviceability, complaints).
- It closes when the console shows the change, when the agent answered with
  substance, when the task is done, or when a team member answered in the group.
- Open past its time on a LIVE store desk: the lab is asked again, the ops
  group is told after the second reminder (at once when the wait is on us).
- A nudge with no order id lands on the thread it quotes or the only open one,
  and is answered from the thread ("your reschedule request, asked at 10:05,
  is with our team").
- Work for LabStack's own people — a reschedule in the console, a gender
  change, a report upload — is an OpsFlow task **and** a post in the
  "Internal <> ops" group. Nobody is assigned: whoever replies "on it" has it;
  "done" completes it (`ops/post.ts`, `ops/reader.ts`).
- A question a lab or store asks the bot that no fact answers is posted to the
  ops group for a person to answer in the group.

## 4. Learning

- Every executed action is scored two hours later (`brain/outcomes.ts`,
  `agent_actions.effect`): was the ask answered, did the store settle, was the
  task done, did someone take the post.
- Every hour the Brain reads every group's last hour as a transcript, with the
  bot's action log, and writes down what went right, what went wrong (with a
  fix kind), how people behaved, who went unanswered, and the cases worth
  keeping (`brain/learn.ts`, Brain runs of kind `learn`). It slows to every
  four hours after three quiet days and to daily after a quiet week.
- The nightly brief carries the efficiency index and the day's lessons; the
  weekly review turns timing and rule lessons into SOP proposals, still gated
  by replay and bounds.
- The evaluation set: `scripts/eval-build-cases.ts` builds cases from real
  traffic with the lessons attached; `scripts/eval-run.ts` scores the reader
  and linker against them and gates a change (`--gate`). Anonymised cases live
  in `reader/examples.ts` and run as unit tests.

## The metric

`OPS-EFFICIENCY.md` — one index, six components, stable definition.

## Operating it

| When | What | Where |
|---|---|---|
| Any time | Is everything running? | `scripts/health.ts` (every 5 min in the worker; alerts to AGENT_BRIEF_JIDS and AGENT_ALERT_WEBHOOK_URL) |
| Daily | The brief with the index and lessons | WhatsApp, 21:30; Agents › Brief |
| Daily | What the ops group was asked | the "Internal <> ops" group |
| Weekly | The index day by day | `scripts/efficiency.ts 7` |
| Before LIVE | Is a store's desk ready? | `scripts/store-desk-readiness.ts <storeId> 1 --summary` |
| Weekly | Proposals to approve | Agents › SOPs |
| Before a reader change | The eval gate | `scripts/eval-run.ts <cases> --gate` |

Settings: `AGENT_OPS_GROUP_JID` (optional; else the INTERNAL group named like
"Internal <> ops"), `AGENT_LEARN_CRON` (default hourly at :07), `AGENT_BRIEF_JIDS`,
`AGENT_ALERT_WEBHOOK_URL`.
