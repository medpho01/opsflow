# Lab group chats, 5–20 Oct 2026 — what the bot did, and a redesign

Source: WhatsApp exports of two lab groups (Lab A: TN/KA/KL; Lab B: GJ/MP/RJ),
compared with the 17 days before the bot went live (18 Sep–4 Oct). Aggregate
numbers only. People are named by role.

## What happened

| | Lab A | Lab B |
|---|---|---|
| Bot messages per day | 20.8 | 8.2 |
| Team messages per day, before → after the bot | 14.2 → **19.4** | 10.2 → **14.6** |
| Bot messages per order (median / max) | 5 / 16 | 7 / 15 |
| Bot messages sent 21:00–08:00 | 98 of 323 | 22 of 127 |
| Lab spoke within 30 min after a **team** message | 48–55% | 37–41% |
| Lab spoke within 30 min after a **bot** message | 19% | 20% |
| Lab named the order a bot message was about, within 2 h | 1% | 0% |
| Median length: bot / team / lab (characters) | 255 / 78 / 12 | 247 / 59 / 19 |
| Combined (numbered) messages sent | **0** | **0** |

### 1. Our messages are too repetitive

- One order in Lab A got **16 bot messages from 4 families**: new order, "Phlebo
  not assigned" ×3 (07:00/07:30/08:00), "SLA missed – Sample delivered" ×3,
  "Report pending" ×4, "SLA missed – Report uploaded" ×2, and the daily
  "Reports pending" list ×2. No person, from the team or the lab, ever
  mentioned that order.
- Three families chase the same thing: the per-order **report chase**, the
  **"SLA missed – Report uploaded"** watcher and the **10:00 pending-reports
  list**. In Lab B, one order sat in the 10:00 list five days running with no
  escalation.
- "SLA missed – Sample delivered" fired **before** appointments (fixed in
  b4f9c3d; not deployed then).
- Polls were still attached until 6 Oct.

### 2. Labs don't respond to the bot

- Labs effectively never answer a bot message about its order (0–1%).
- Bot messages are long (≈250 characters) and start with the lab's internal
  name ("Dear <lab>_KA,TN,KL_TN,AP"). Labs answer in one or two words.
- A third of Lab A's bot messages go out before 08:00 or after 21:00. Lab
  activity is 08:00–17:00 (Lab A peaks 13:00 and 16:00) and 08:00–22:00 for
  Lab B (peaks 08–09, 15:00, 19–22).

### 3. People follow up manually — and they get answers

The team's chase follows one pattern, and it works:
- a **short list of order ids** plus an **@mention of the lab coordinator**, or a
  **reply quoting** the earlier message: "@coordinator 2 cases status is pending,
  please check?";
- **repeated by the hour** until answered;
- the lab answers it ("Checking", "This one possible, remaining not
  possible").

About 85% of the team's messages @mention the lab coordinator.

The team also does work the bot doesn't touch:
- **Booking details and serviceability:** "Patient Details" blocks (83 in Lab
  A, 41 in Lab B) and pincode checks, often before the order exists. When the
  bot also sent the new-order message, **the team had posted first every time**.
- **Lab-raised problems:** "customer phone switched off, technician waiting
  since morning", where the lab tags team members and the team acts.

After the bot went live, team messages went **up**: the bot added a parallel
stream instead of taking work off them.

### 4. Combined messages didn't go out

None were sent: combined messages were Off (or not yet deployed) for both
labs. Every follow-up went per order, often five in the same minute (07:30
status checks).

## Why: the engagement view

1. **People answer people.** A message that @mentions the coordinator, or
   replies to one of theirs, is a request to them. A broadcast to "Dear
   <lab name>" is ambient noise in a busy group.
2. **Repetition trains people to ignore.** Sixteen messages about one order
   teach the lab that bot messages need no action, including the important
   ones.
3. **Short asks get short answers.** The lab replies in 12–19 characters. An ask
   that can be answered in that many characters gets answered.
4. **Timing is a signal.** Messages at 05:00 or 23:00 read as automated and are
   gone from view by working hours.
5. **Two voices in one group compete.** When the bot and a coordinator both
   chase, the lab answers the coordinator, and the bot's message is pure noise.

## Design: the bot is the coordinator's assistant, not a second voice

### Principles

1. **Address the person.** Every follow-up @mentions the lab's coordinator,
   set per lab and picked from the group's members.
2. **Follow up in-thread.** The second ask replies to (quotes) the first, and
   names only what is still open. That is exactly the team's pattern.
3. **A daily rhythm, not a drip.** At most 4–5 bot messages per lab per day, at
   the lab's active hours, numbered, one line per order.
4. **One family per question.** Report status is asked in one place only. No
   per-order chase alongside a list alongside an "SLA missed".
5. **Step back for people.** If a team member messages about an order (names it
   or quotes a message about it), the bot stops chasing that order for the day.
   If the team is mid-conversation in the group, non-urgent sends wait.
6. **Hand over, don't repeat.** After two unanswered asks, the bot stops talking
   to the lab and **hands the item to a person**: an OpsFlow task, plus a
   ready-to-send message for one tap in the console.
7. **Do what people do now.** New-order details in the format the team pastes,
   serviceability lists, and lab problems escalated to the team immediately.
8. **Plain voice.** No internal lab names, "SLA", "Dear", or addresses in
   follow-ups.

### The daily rhythm (per lab, in its active hours)

| Time (default) | Message | Replaces |
|---|---|---|
| on order | **New order**, short, in the team's paste format, only if no team member posted the patient already | today's long intro |
| 08:30 | **Today's visits**: numbered list, "reply with phlebo names" | "Phlebo not assigned" ×3 at 05:00–08:00 |
| 13:30 | **Collected?**: today's visits not yet updated | per-order status checks |
| 15:00 | follow-up **in-thread**: "@coordinator still open: 2, 4" | repeats |
| 16:30 | **Reports pending**: numbered, oldest first, "1 shared, 2 by 6 pm" | per-order report chase, "SLA missed – report", 10:00 list |
| 19:00 | **Tomorrow's visits**: numbered, with the confirmation links for unconfirmed ones | (kept) |
| 2nd miss | **handover to the team**, not another lab message | repeats |

### Templates (copy)

**Today's visits — 08:30**
```
Good morning @Coordinator 👋 Today's visits (3):

1. #12301 · Asha · 7:30 am · Mysuru
2. #12302 · Ravi · 9:00 am · Bengaluru
3. #12303 · Meera · 11:00 am · Kochi

Phlebo for each? e.g. *1 Ramesh, 2 Suresh*
```

**Collected? — 13:30**
```
@Coordinator quick check — collected?

1. #12301 · Asha · 7:30 am
3. #12303 · Meera · 11:00 am

Reply *1 done, 3 not home* or *all done*
```

**Follow-up — reply to the 13:30 message**
```
@Coordinator still open: 1, 3 🙏
```

**Reports pending — 16:30**
```
@Coordinator reports pending (2):

1. #12288 · Kiran · visit 13 Oct
2. #12290 · Neha · visit 13 Oct

Reply *1 shared, 2 by 6 pm*
```

**New order — only if the team hasn't posted it**
```
🆕 #12302 · Ravi · Thu 16 Oct, 9:00 am
📍 Bengaluru 560001 · 🗺️ map link
🧪 Full Body Check (+12 tests)
Confirm: <link>
```

**Handover to the team** (an OpsFlow task, and a line in the internal ops view)
```
Lab A: no reply on 2 orders since 13:30 — #12301, #12303.
[Send in group] "@Coordinator please update 12301, 12303 🙏"   [Call coordinator]
```

**When the lab raises a problem** ("customer not reachable", "address wrong",
"technician waiting"): an immediate task for the team with the patient's
contact, plus a short reply in the group: "Noted — informing the team now."

## Rollout

| Step | What | Where |
|---|---|---|
| Now (config) | Deploy b4f9c3d+ (pre-appointment fix, no polls). For these labs: combined messages **On**, send window 08:30–20:00 on all follow-up rules; pause "SLA missed" watchers and the 10:00 pending-reports list (the combined report chase covers it). | Lab Config, Message Rules |
| Build 1 | Lab coordinator (@mention) per lab; follow-ups as quote-replies naming only open items; daily rhythm slots per lab; caps per day | provider-rules (batching, templates), Lab Config |
| Build 2 | Step back for people: team message about an order → bot pauses that order; team active → hold non-urgent. Skip new-order message when the team posted the patient. | replies pass (team messages), engine |
| Build 3 | Handover after 2 misses: OpsFlow task + one-tap send/call; lab-raised problems → task | engine, tasks, console |

### How we'll know

| Measure | Now | Target |
|---|---|---|
| Bot messages per lab per day | 8–21 | ≤ 5 |
| Bot messages per order (median) | 5–7 | ≤ 2 |
| Lab replies within 30 min to bot asks | 19–20% | ≥ team level (40–50%) |
| Lab names the asked-about order | 0–1% | > 40% |
| Team chase messages per day | 15–19 | halve |

## Decisions (20 Oct 2026)

- **Build 1: yes, and built** — lab coordinators (@mentioned in every combined
  message), follow-ups that quote the original and keep its numbers, a daily
  rhythm per ask in working hours, a per-day cap. Asks timed within 90 min of
  the visit still go straight away.
- **Build 2: no.** The bot takes the lead; it does not step back when the team
  is chasing, and it still sends the new-order message.
- **Build 3: not as proposed.** No handover after two misses: the bot keeps
  going with a modulated rhythm (2nd ask polite, 3rd on firmer, then the
  manager and calls). The goal is a bot that runs ~95% of orders end to end;
  see ORDER-JOURNEY-AGENT.md, "Toward 95% autonomy".
