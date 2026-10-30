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

## The outcome auditor, and playbooks the Brain can add (29 Oct 2026)

**Auditor (built).** `brain/outcomes-audit.ts` reads every connected store and lab group as a person would — hourly in the day on the last 75 minutes, at 21:50 on the whole day — with the orders those messages name and the orders LabStack shows late, and judges whether the four jobs were done, not whether the agent followed its rules. Output: per job met / partly / missed with quoted evidence, what people did by hand that the agent should have, what the agent sent that was noise, and up to eight ranked proposals (new playbook, change, retire, lesson, wording), each with a trigger, an action, a scope and how to tell it worked. It runs on the strongest model (`AGENT_MODEL_AUDITOR`, default Claude Opus 5.5; `claude-fable-5-1` for the most capable). Proposals feed the weekly review (counted by recurrence) and the nightly brief; a coach can ask the agent "what did you find?" in the direct chat; `scripts/outcomes.ts [run N]` prints or runs it.

**Playbooks (next).** The lab SOP splits into playbooks, one job each — manual-lab chase, API-lab check-in, report chase, re-collection, store updates, store service, lab briefings — under one channel limit per group. The set is not fixed: an auditor proposal of kind `new_playbook` that recurs becomes a draft playbook (trigger, recipient, message, timing, scope) that runs in **shadow** — it records what it would have sent — and is graded the same way against the groups; a person promotes it, changes it or retires it on the Playbooks page, which shows every playbook's messages, replies and corrections. Playbooks the auditor finds adding noise are proposed for retirement the same way.


## From the 10:31 audit (29 Oct 2026)

- **A store's question keeps its lab ask through a reschedule.** LabStack moving the visit withdraws the routine asks, not the one the store's own question started (#93413: "are the samples collected?" was withdrawn as "rescheduled"). A re-route still drops it. And "rescheduled" to a time already gone is not an answer: the lab is asked.
- **A lab's time reaches the store only if it is still ahead,** and never a visit-day time once LabStack moved the visit to another day (#95010, #95226). LabStack's own moves were already in the summary since the 10:02 change.
- **Manual labs that stay silent: the store hears it before the visit.** `store/atrisk.ts`, every 10 minutes from 07:00 to 21:00: a visit within 60 minutes at a lab with no API, which the agent has asked 2+ times with no answer and nothing collected, goes in one message per store — "At risk — the lab hasn't confirmed these visits yet", each order once a day, no one tagged. It skips orders a person on our side already wrote about in the store group. Live store desks (or stores with summaries on) receive it; shadow desks record it. Per-order store warnings stay "suggest" in the guard.
- **No "which order?" when the sender just named one.** A message with no id is about the order its sender named in the last 10 minutes, if exactly one.
- **Re-collection asks: one line, a few words per order** (#94443, 12:03 pm — Khushbu read the old ask as us asking *her* for a time). Now "@coordinator Available slots for urine sample collection?" and one line per order, "BLR… · #94443 · Shiuli · <phone> · Bengaluru · urine pending" — no visit time, no reply instructions. Stored copies nobody edited move to it. If a lab still answers by asking us for the date or time (and offers none), one short reply quoting it: "#94443: please share your available slots for urine sample collection." — or "#94443: customer prefers <time>. Possible?" when the store gave one. The facts that reply restates are kept as a note only, so the store is not told again.
- **"Phlebo on time?" only near the visit** (#95010, 12:30 pm: asked about "tomorrow 8:30 am"). After a visit, the ladder already asks "collected?"; an ETA ask could only go out when a checkpoint's due time had passed while the visit itself was still ahead — a lab's time from before the reschedule. Now the ladder holds an ETA ask until 90 minutes before the visit, and the dispatcher drops any ETA ask for a visit more than 3 hours away.

## From the 12:43 audit (29 Oct 2026)

- **Every LabStack status ranks.** PHLEBO_DISPATCHED, PHLEBO_STARTED, SAMPLE_IN_TRANSIT, PARTIAL_DELIVERED and REPORT_READY were missing, so they "reached" nothing: an order with a partial report was listed to Plum as "not collected yet" (#95247, #94989) and could be asked "collected?". They are now in order, and orders in them stay tracked for their report.
- **A sample owed is dropped from the summary once LabStack moves past delivery after the lab said so** (#95226, SAMPLE_DELIVERED since 11:13, still listed "urine still to collect" at noon).
- **No re-listing within 45 minutes.** An order listed to a lab in any message in the last 45 minutes waits (held, not dropped) unless a store is asking (Thyrocare: 7 check posts in 2 h, the same orders re-listed 32 minutes apart).
- **Reminders name the order, not the list number:** "still open: #94666 (VL168E3D)" — "10 (VL168E3D · #94666)" read as a count.
- **Report chases carry the patient's full name**, as the team's name lists do.
- **A withdrawn ask is asked again when proposed again** (#92602: the 9:39 report chase to Star was withdrawn as "re-routed", never sent, and the ladder counted it as made — no ask until tomorrow). The guard revives an action whose only record is "withdrawn", and its outbox item is queued again with a fresh window.
- **A ladder that ran out before the visit still asks "collected?" once, 30 minutes after it** (#91771: Advaith's 7 am visit — asked the evening before, escalated, "stuck" at 5:00, then nothing all morning while Kavita chased by hand).
- **A withdrawn rung does not count as asked.** Before each step, a ladder rung whose action was withdrawn before it went out is taken back off the count, so the step proposes it again under the same key and the guard revives it (the e92db2a fix alone left #92602 waiting a day: the count still said "asked at 9:39").
- **"Sample collected" waits for the summary** (SOP `storeRelay.collected`, default "digest"; "immediate" restores one message each). Four unasked "collected" posts reached Plum in 30 minutes, one of them wrong (#95227 had a PSA/gender block). A store asking about the order still gets its answer; failures the customer must act on still go at once.
- **The rung gap runs only from an ask that went out.** #92602 showed `report_delivered: { n: 0, at: 9:39 }` — no ask counted, yet the day-long report gap ran from the withdrawn one. With no ask counted there is no gap, and a blocked rung reverted to 0 drops its time.

## Re-collection answers reach the store (30 Oct 2026)

#95568: Plum asked for urine slots at 8:15; the ask reached Orange at 8:16. Orange answered twice and Plum heard neither — the team relayed by hand.
- **8:18, a slot screenshot quoting our ask.** The image reader summed it up as "booking interface with available slots" — no times — so there was nothing to relay. The reader now also returns the times it shows (`Slots: …`) and the one booked (`Booked: …`), appended to the reading.
- **8:25, "Time: 10:15 am", quoting a team member's message.** The re-collection was recognised only from the line of our ask a reply quotes, so this read as a plain note. Now any lab answer within a day of a re-collection ask (`openRecollect`) is read as its answer: one time → "urine re-collection scheduled for 10:15 am", two or more → the slots for the store to pick from. The lab's own words win over a screenshot's times.
- A later "collected" that does not quote the ask is no longer dropped as old news — it may be the re-collection itself.
- Both answers had been drafted by the case worker and held for review; the relay now goes out on its own.
- **The rest of the loop (dry run of the full flow).** The store's pick in any words ("customer prefers 11:45 am", "11:45 works") goes to the lab as "customer picks 11:45 am — please book and confirm" and the store hears "asking the lab to book it"; before, only "schedule/book at …" was understood. The lab's "ok / done" to that time reaches the store as "booked for 11:45 am"; "11:45 not available, can do 1:15 pm" reaches it as a counter-offer to pick from, not "patient not available". A re-collection the lab books itself opens no console task.
- `update.sh` compares with the commit the worker last ran (`.deployed-commit`), so a `git pull` by hand first no longer leaves the worker on old code.
- **Two more stalls, found reading the store side for the replay.** "11:45 works" with no order id is linked to the open slot request and was answered "your slot request is with the lab" — the pick never reached the lab; the pick is now read before that answer. And a report delivered without the urine closed the order's journey, so the lab's slots and the store's pick for it were dropped; a journey closed on delivery reopens while a re-collection asked in the last day is open (`openRecollectFor`).
- `scripts/recollect-replay.ts [days] [ids]` replays the last days' re-collection chats through the current code — no sends, no writes — and marks every message that would get no answer.
- **A store's request to the lab is never dropped at send time** (#95448: Plum's "reschedule to tomorrow same slot" was queued for Orange Hyderabad and dropped — LabStack showed the visit over, and Orange had written about the order in the last two hours). Reschedule, cancel and slot-pick asks carry `storeRequest` and skip the "settled by the console" and "already discussed" checks; a reschedule or cancel goes under its own heading ("reschedule (1)") instead of "quick check — collected?".

## The reader reads in context (30 Oct 2026)

Read alone, a message lost what made it mean something: "11:45 works" after the lab's slots was chatter; Orange's "Time: 10:15 am" quoting a team member was a note; an RNR reply listed blood, urine, stool, swab and sputum as missed on a blood-and-urine order. The reader (`reader/read.ts`, both sides) now gets a context block (`reader/context.ts`) for the order(s) the message is likely about:
- the order: lab, LabStack status, visit, its packages with their tests and tests booked alone;
- what is open: a re-collection asked in the last day, the time the store picked, a move the store asked for, the journey's next step;
- the last 8 messages about it in the past two hours, from both groups, marked store / lab / our team / us;
- for a lab message, what the same person wrote in the 10 minutes before ("Checking." then the answer);
- a screenshot is read with its caption.

The store side guesses the order before linking (ids written, the quoted message, our quoted message's order, the sender's last-named order, the store's open requests) — for context only; linking is unchanged. The context explains the message; the reader is told never to return facts only the context states. The rules added earlier stay as the safety net. With the context, a pick reads as a reschedule with a time; a reschedule while a re-collection is open takes the pick path, answered as a slot request (Plum is live for slots).

`recollect-replay.ts` reads exactly as production does; `-e NO_CONTEXT=1` reads without the context, for a before/after on the same chats.

## "Collected?" half an hour after the visit at API labs too (30 Oct 2026)

Orange #94868, visit 8:00: the console said "phlebo started" at 7:50, which kept the order "live" (updated in the last 90 min, `consoleQuietMin`) until 9:20; the lab was asked at 9:25 — it had marked the customer RNR long before, and the store knew. Now, 30 minutes after the visit (`POST_VISIT_ANSWER_MIN`), only an update made after the visit counts as the console answering; the order is woken at visit + 31 min and the lab asked then (sent within the 10-minute gather, so about visit + 40). An update after the visit (collected, patient missed, rescheduled) still answers it.
- **From the first replay (90 "stalls", the same with and without context — mostly the replay's own faults).** The replay now ties a message to an order only by what it says (the id, the lab's reference, a quote), never by the gateway's tag, which put Gokul's "92255 …" under #92703; and it replays each message against LabStack as it was then (from `OrderChange`), not as it is now — every order had read as "report delivered". Two real findings, fixed: a WhatsApp name "Labstack …" is our team even before it is on the roster ("Labstack Veena", "Labstack Deepali" were read as the store and the lab); and a re-collection our team asked for by hand in the lab group opens the loop like the agent's own ask (#94202: Orange's slots and "29 Oct, 9:45 am" were ignored; Veena relayed them 14 minutes later).
