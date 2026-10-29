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

## 3b. The store desk grades itself

Every store question gets a draft from the desk, live or in shadow; the team's
own reply is kept beside it; a judge says whether they agree
(`store/readiness.ts`, `agent_shadow_evals`). Nightly, and on "Grade now" on
Agents › Desks, that becomes a readiness score per kind of question —
coverage (did the desk have a reply) and correctness (nothing wrong among its
replies). A kind is marked ready at 85+, 15+ asked, nothing wrong in 3 days.
A LIVE desk can be scoped to the kinds it is good at (`liveIntents`); a
question of any other kind is handed to the team members who answer in that
group, by name, quoting the store's message.

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

## The wording

Every message kind has a contract (`agents/style`): what it must carry (the
order id, the name, the phone, the visit date), what it may carry, how long it
may be. The wording inside the contract is learned: nightly the Brain scores
each kind's engagement over 14 days (a lab reply within 2 h; a store that
stayed quiet after an answer), promotes or retires the variant on trial, and
where nothing is on trial writes a challenger that goes to half the labs or
stores. Every send is logged against the wording it used
(`agent_message_sends`). `scripts/style.ts` shows the arms; the Templates
page still edits the live body by hand, and a trial written against an older
body is never promoted over an edit.

## The metric

`OPS-EFFICIENCY.md` — one index, six components, stable definition.

## Operating it

| When | What | Where |
|---|---|---|
| Any time | Is everything running? | `scripts/health.ts` (every 5 min in the worker; alerts to AGENT_BRIEF_JIDS and AGENT_ALERT_WEBHOOK_URL) |
| Daily | The brief with the index and lessons | WhatsApp, 21:30; Agents › Brief |
| Daily | What the ops group was asked | the "Internal <> ops" group |
| Weekly | The index day by day | `scripts/efficiency.ts 7` |
| Before LIVE | Is a store's desk ready? | Agents › Desks (readiness per kind; "Grade now"); detail: `scripts/store-desk-readiness.ts <storeId> 1` |
| Weekly | Proposals to approve | Agents › SOPs |
| Weekly | Which wording is winning | `scripts/style.ts` |
| Before a reader change | The eval gate | `scripts/eval-run.ts <cases> --gate` |

Settings: `AGENT_OPS_GROUP_JID` (optional; else the INTERNAL group named like
"Internal <> ops"), `AGENT_LEARN_CRON` (default hourly at :07), `AGENT_BRIEF_JIDS`,
`AGENT_ALERT_WEBHOOK_URL`.

## When the store desk stays quiet (28 Oct 2026, Plum's first live afternoon)

The desk's facts were right on its first live day; its sense of when to speak was not. Rules added, all in `src/lib/agents/store/scope.ts` and the reader:

- **For a named person, not for us.** A store message that @mentions a team member, says "as discussed", or replies to a team member's message is theirs. The request is still tracked (the team is reminded if it goes unanswered) but the desk neither answers nor chases on it.
- **A grievance is a complaint.** "Not done", "collected but cancelled", "dummy order", "no one is assigned", "last time also" make the message a complaint whatever else it looks like, so it goes to a person instead of getting a status line. Closed-order answers now carry their intent too, so the same scope applies there.
- **Labs the bot cannot work with.** An order whose lab has no API and no connected WhatsApp group with a live desk is handed to the team, order by order, never "checking with <lab>". For Plum that keeps Thyrocare, Redcliffe and Orange with the desk and sends Suburban, Apollo and the like to a person. The store summary counts such visits instead of listing them as "on it with the lab".
- **Who is tagged on a handoff:** the team member the store mentioned → whoever last wrote about that order in the group → the two most recent team writers.
- **No duplicates.** The same reply to the same order is never sent twice in a day. An "on it" (checking / noted) waits three minutes and is dropped if a team member answered in the group a few minutes before or after.
- **Every id or none.** "Any update?" quoting a message that named two orders is about both.
- **A move the store asked for** is confirmed as "done — moved to … as requested", not announced as the lab's reschedule with the patient's name and "please let the customer know".
- **The grader sees it.** A new verdict, UNWANTED (answered a message meant for a person, or an "on it" within two minutes of the team's answer), counts as wrong in the readiness score; staying quiet on such a message is not graded at all.

## Coaching from WhatsApp (28 Oct 2026)

A team member ticked **coach** on Connections › Team (a flag on the roster, never a number in code) can correct the agent where the work happens, and it follows the lesson at once:

- **Reply to one of the agent's messages**, in any connected group: "this was for Sushma, not you", "too long — just the id and the time".
- **Or write in the internal ops group** with a prefix: "bot: never say 'chasing' to Plum unless the lab group is live", "bot: pause store plum", "bot: resume lab star", "bot: pause all".

Within the next store pass (seconds): the words become a lesson (`agent_coaching`: kind, one-line rule, scope — this store, this lab or all); the rule is read into every model prompt ahead of everything else (the reader that classifies messages, the judge that grades the desk, the Brain that rewrites wording); a trial wording the coach disliked is retired; pause/resume flips the kill switches; and the coach hears "📝 Noted — from now, …" in the internal group. Replying **undo** to that post drops the lesson. The weekly review counts coaching as causes (weighted ×3) so recurring lessons become SOP proposals. `scripts/coaching.ts` lists and retires lessons.

Limits, stated plainly: lessons steer the model-driven parts at once; a rule that only code enforces (a cap, a template) is proposed by the review, not changed live.

**The agent's name.** Set on Agents › Controls, or from the internal group with "bot: your name is Asha". Every message the engine sends is then signed "_Asha, Labstack Operations_" (the gateway reads `agent_settings.agentName` on each drain; a person's console message keeps their own name), and a coach can address it as "Asha: …", "@Asha …" or "hey Asha, …". Nothing is renamed in code: the name is a setting.

**Coaching by direct message.** A coach can also write to the ops number directly. The gateway keeps only coaches' 1:1 chats (as a `wa_groups` row of role IGNORE named "Coaching · <name>"; every other direct message is still dropped). There, every message is coaching — no prefix — and the agent answers in the same chat. A lesson that names a store or lab ("…to Plum…") is scoped to it; otherwise it applies everywhere. The internal group is not needed for this.

## Real-time chasing, no slots (29 Oct 2026)

Status, phlebo, ETA and report asks used to wait for fixed slots (status at 11:00, 13:30, 16:00, 18:30; reports at 10:30 and 16:30) — the rhythm of the hand-sent batches the agent replaced. The journey engine notices a late milestone within minutes of it being late; holding the ask for a slot threw that away. Now a routine ask goes as soon as it has gathered for `batching.gatherMin` (15 min, so a morning's lateness at one lab is one combined message), and a lab hears at most `batching.perHourCap` (3) messages an hour and `batching.perDayCap` (10) a day; urgent asks (a store waiting, a visit long past) still go at once. All three are SOP parameters with bounds the Brain may tune. The night hold (21:00–07:00) stands. `DAILY_SLOTS` remain only for the legacy message rules, the evening list and the weekly scorecard.

## One WhatsApp group, several labs (29 Oct 2026)

Orange's four city labs share "Labstack <> Orange Ops"; connecting it to Orange Mumbai used to disconnect it from Orange Bangalore, so the agent had no desk for the others and told Plum "asking the lab now" with nowhere to ask. A provider group may now serve any number of labs: each lab's config points at the group (`nonApiLabConfig.waGroupJid`), the group row names only the first. Chaseability, lab silence and the store summary look at the lab's config, and a reply in a shared group is attributed to the lab its order belongs to — by the batch it quotes, else by the order id or lab reference it names. The urine re-collection flow is then end to end: store says the sample was missed → the lab's group is asked for a slot within the gather window → the lab's slots (text or a screenshot, read by the vision model) are relayed to the store with "reply with the customer's preferred slot" → a person books the pick → the move is confirmed.

## Why no status checks reached any lab (29 Oct 2026)

After a visit the first open milestone is usually "phlebo reached" (due slot + 15 min), whose ask is an ETA ("phlebo on the way?"). Since 26 Oct the dispatcher drops ETA and PHLEBO asks once the visit time has passed, so every such ask was queued and thrown away — and the milestone never closed (LabStack rarely marks "visited"), so the "collected?" ask on sample_collected was never reached. Now any ask after the visit time, whatever pre-collection milestone is open, goes as a STATUS ask ("collected?"). Two related fixes the same day: a urine re-collection is its own RECOLLECT ask (a STATUS ask was dropped as settled once the blood was collected), and a journey closed when its order left the window is reopened when the order comes back (a reschedule) instead of being skipped for good.

## Fewer deploys (29 Oct 2026)

The worker (every agent decision and send) and the WhatsApp gateway now read their code from the checkout, as scripts already did: `bash scripts/update.sh` on the VM pulls and restarts only the container whose code changed — seconds, no image build. It stops and says so when a change needs the full deploy: the web app (`src/app`, `src/components`), the database schema (`prisma/`), dependencies, or the images; then `scripts/deploy.sh` with a package built at the same commit, as before. The console's pages keep the image's copy of `src/lib` until the next full deploy; the agent runs the new code at once.

## What the bot is for, and what it stays quiet about (29 Oct 2026)

Decided with the head of ops after a morning in which 22 of 54 Plum messages were the bot's, 12 of them reschedule/cancel relays:

1. **Track every order against its milestones; check with the lab when one is missed.** Manual labs (no API: Advaith, Star, …) get the full chase at every milestone — a person's check is the only source of status. API labs (Orange, Thyrocare, Redcliffe) are read from LabStack, and asked in their group only when the console goes quiet past a milestone.
2. **Relay what the store must act on, batch the rest.** At once: answers to the store's own questions, and failures the customer must act on (RNR with the lab's slots, a sample owed, the lab cannot do it). LabStack's own reschedules and cancellations go in the 9 / 12 / 4 summary (`storeRelay.consoleChanges`, SOP; "immediate" restores one message each). A change the store asked for is never relayed back.
3. **Service agent = relay + tracking.** Questions that need the lab are relayed to the lab group and answered when the lab replies. Reschedules, cancellations and test changes are done by people: the bot posts nothing (handoffs are silent — `AGENT_HANDOFF_TAG=1` restores the tag), and tracks the request until LabStack shows it done.
4. **Learn what, how and when to ask** from replies, corrections and what people still do by hand.

