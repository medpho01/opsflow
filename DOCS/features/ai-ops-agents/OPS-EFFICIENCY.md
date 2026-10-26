# The Ops Efficiency Index

One number, 0–100, for how much of the day's lab and store communication ran
without a person, how fast, and how cleanly. Computed per day from what the
WhatsApp gateway stored (every message in every connected group, who sent it,
what it replied to) and the agent's own action log. It is in the nightly brief,
in `scripts/efficiency.ts` day by day, and kept as a Brain run of kind
`nightly` (findings.efficiency). Code: `src/lib/agents/brain/efficiency.ts`.

**The definition must stay stable so weeks compare.** Change a weight or a
threshold only with a note here and a date, and expect a step in the series.

## Components

| Component | What it measures | Raw value | Score (0–100) | Weight |
|---|---|---|---|---|
| Autonomy | Store questions the bot answered with no team message in that group within 2 h | share of questions | share × 100 | 25 |
| Speed | Minutes from a store question to its first answer, bot or team | median (p90 shown) | 5 min → 100, 60 min → 0, linear | 15 |
| Closure | Store requests (agent_threads) closed within 2 h of being asked | share of requests | share × 100 | 20 |
| Lab answers | Asks to labs answered within 2 h (a fact or a lab message on the order) | share of asks | share × 100 | 15 |
| Messages | Automated messages sent per order handled | messages ÷ active orders | 1.0 → 100, 4.0 → 0, linear | 10 |
| Human load | Team messages (in groups and from the console) per order handled | messages ÷ active orders | 0.5 → 100, 3.0 → 0, linear | 15 |

The index is the weighted mean of the components that have data that day. A
component with nothing to measure (no store questions, no asks) is left out
and the weights renormalise, so a quiet Sunday does not score zero.

Two noise counts ride alongside, unweighted: alerts repeated on an order within
2 h, and questions to the bot that no fact answered (posted to the ops group).

## What a store question is

A message in a store group from someone who is not LabStack's team, that the
reader classified as a request (intent `STORE_*`, not noise). Acknowledgements
("thanks", "checking") are not questions. A bot answer is an automated outbound
to that group within 30 minutes; a team answer is a team member's message in
that group, or a console send by a signed-in user, within 2 hours.

## How to read it

- **Autonomy up, human load down, closure steady** is the bot taking work off
  the team without dropping requests.
- **Autonomy up, closure down** is the bot answering but not finishing: look at
  the threads reminders and the ops-group posts.
- **Lab answers down** is a lab, not the bot: the weekly scorecard names which.
- **Messages per order up** with no autonomy gain is noise: check repeats.

## Targets (first month)

| Component | Now (26 Oct 2026, Plum in SHADOW) | Target |
|---|---|---|
| Autonomy | ~20% of store questions answerable | 60% |
| Speed p50 | team 2–7 min | 2 min |
| Closure in 2 h | — (threads start 27 Oct) | 80% |
| Lab answers in 2 h | 84% Orange, 10% Thyrocare, 0% Advaith (asks of 19–25 Oct) | 70% overall |
| Messages per order | — | ≤ 1.5 |
| Human load | — | ≤ 1.0 |

## Where the inputs come from

- Store questions, answers and team messages: `wa_messages`, `wa_outbound`.
- Requests and their closing: `agent_threads` (opened by the store reader,
  closed by the console, an answer, a task, or a team reply).
- Lab asks answered: `agent_actions.effect`, scored two hours after the send by
  `brain/outcomes.ts`.
- Orders handled: `agent_journeys` open during the day.
