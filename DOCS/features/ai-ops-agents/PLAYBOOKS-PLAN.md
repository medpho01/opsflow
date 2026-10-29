# Playbooks as settings — plan for 30 Oct – 5 Nov 2026

**Goal.** Most of what the outcome audit finds becomes a settings change the ops team makes on the console, not a code change and a deploy. Code keeps the engine (reading LabStack and the groups, the guard, sending); playbooks hold the behaviour.

**Why now.** On 29 Oct 2026 about ten deploys went out, one per finding. Nearly every fix changed a number, a wording, or who hears what — things a person should be able to change.

## What is in code today that belongs in settings

| Kind | Examples (all hard-coded today) |
|---|---|
| Timings | ETA asks no earlier than 90 min before the visit; no re-listing within 45 min; "collected?" 30 min after a visit whose ladder ran out; at-risk note 60 min before the visit after 2 unanswered asks; report chases at 10:30 and 16:30; a visit "missed" in the summary after 90 min; two store replies per order per day; answer / ack / alert holds of 90 s / 3 min / 90 s; a sender's order carries over for 10 min |
| Wording | Store replies built in code (re-collection, overdue report, thread nudge, at-risk note, the reply to a lab asking us for a time, the 9 / 12 / 4 summary), on top of the templates already in the database |
| Routing | Which lab facts reach the store at once (`STORE_RELAY`), which go to the summary (`DIGESTED`, `storeRelay.*`), which become a task |
| Scope | API vs manual behaviour (from LabStack's flags), report chase per lab type (`reportChase.apiLabs`) |

Already settings: the lab SOP's ladder, ask timings per checkpoint, batching caps, `storeRelay`, `reportChase`, briefings — versioned on **Agents › SOPs**.

## The playbook

One job, one trigger, one audience:

- **Trigger** — a kind from a fixed catalogue the engine knows: *milestone late*, *visit passed with no update*, *lab reply of kind X*, *store message of intent Y*, *console change Z*, *scheduled sweep at T*. A new kind of trigger still needs code; a new playbook built from existing triggers does not.
- **Audience** — lab group, lab manager, store group, or the ops team (silent task).
- **Message** — a template with variables, editable.
- **Timing** — when it starts, window, gap, caps, quiet hours.
- **Scope** — lab type (API / manual), labs, stores, order types.
- **State** — live, shadow (records what it would send, sends nothing), or off.
- **Why it exists** — one line, shown on every message it sends (the "why" card).

The first set, split out of today's behaviour: manual-lab milestone chase, API-lab console-quiet check, report chase (manual), re-collection slots, at-risk note to the store, failure relay to the store (RNR, sample owed, cannot do), store question relay, the 9 / 12 / 4 summary, lab briefings (new order, evening list).

## How the Brain uses it

The outcome auditor's proposals already come as *new / change / retire playbook*. With the registry:
- **change / retire** → a draft edit to an existing playbook, shown next to it for a person to accept;
- **new** → a draft playbook in **shadow**: it records what it would have sent, the hourly audit grades those against the groups, and a person promotes it once it would have helped.

Nothing the Brain drafts sends a message until a person promotes it.

## Plan, one evening deploy each

| Day | Work | Deploy |
|---|---|---|
| Thu 30 Oct | Move every hard-coded timing and cap into the lab SOP (defaults = today's values, so nothing changes on deploy). Editable on Agents › SOPs at once. | `update.sh` |
| Fri 31 Oct | Move every store/lab message built in code into templates, editable on the console's templates page. | full deploy |
| Mon 3 Nov | Playbook registry: an additive table, today's behaviour split into the first set above, the engine reads them; shadow mode. | full deploy (additive migration) |
| Tue 4 Nov | **Agents › Playbooks** page: each playbook's messages, replies and corrections from the last 7 days; edit, switch, promote. | full deploy |
| Wed 5 Nov | Auditor proposals land as drafts on that page; the first Brain-drafted playbook in shadow. | `update.sh` |

Thursday's step pays off on its own: from Friday, most of today's kind of fix is an SOP edit.

## Decisions for the head of ops

1. **Who edits.** Recommended: anyone in ops can draft; the head of ops approves (the SOP library's approval already works this way).
2. **Brain drafts.** Recommended: shadow only, a person promotes; never live by itself.
