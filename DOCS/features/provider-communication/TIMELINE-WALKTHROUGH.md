# Lab message timeline with back-to-back orders, and why a lab should answer

All paths relative to `/Users/maverick/Documents/TaskOs/`. Read-only code review; no DB touched; every name, number and link below is fictional. Timezone IST (`src/lib/provider-rules/format.ts:5`). Lab config at schema defaults: batching LIVE (`prisma/schema.prisma:1522`), 3 combined per slot (`:1524`), 8 per day (`:1529`), quiet window 10 min (`:1518`), no named coordinator so the bot auto-picks the busiest lab-side writer (`src/lib/wa/coordinators.ts:47-64`), manager number on file.

## A. Timeline — one lab, six orders in one day

### Scenario fixed

Lab "Lab X" (WhatsApp / NON_API). Today is Tue 20 Oct 2026. Orders (LabStack ids 90001-90006, called #1-#6 below; patient names written as one token because a combined line shows only the first whitespace token of the name, `src/lib/provider-rules/batching.ts:193`):

| # | id | patient | placed Tue | visit Wed |
|---|---|---|---|---|
| 1 | 90001 | Patient-A | 10:05 | 07:00 |
| 2 | 90002 | Patient-B | 10:20 | 07:30 |
| 3 | 90003 | Patient-C | 10:48 | 08:00 |
| 4 | 90004 | Patient-D | 11:30 | 08:30 |
| 5 | 90005 | Patient-E | 14:10 | 09:00 |
| 6 | 90006 | Patient-F | 16:45 | 10:00 |

Lab behaviour: silent until the second combined ask about #1-#3 (Tue 14:00), then replies "1-4 ok" quoting it at 14:10, and taps the four confirmation links at 14:15 (needed: see 14:10 below — the text alone confirms nothing). #5 and #6 are never confirmed. Wed: #1 collected 07:25, #2's phlebo assigned late (07:40, after the visit) and collected 08:20, #3 collected 08:15, #4 collected 09:05 but LabStack updated only at 12:00; #5/#6 nobody goes. Report for #3 is late.

Coordinator token: `@91XXXXXXXX01` (rendered from the jid, `src/lib/provider-rules/deliver.ts:317-320`). Confirm links are `https://console.labstack.in/confirmation/<token>` (`src/lib/non-api-labs/confirmation-link.ts:82-86`), a fresh token per message — single messages `deliver.ts:175`, each line of a combined message `deliver.ts:302-307` (`batchLine`), both via `encryptOrderId`, which draws a random IV on every call (`confirmation-link.ts:63-65`); written as `…/tokA` etc.

### Tuesday

**10:05 — Message 1 (single): New order #1.** Rule NEW_ORDER fires on the first tick an order is seen (`minutesSinceCreated: 0`, `src/lib/provider-rules/builtins.ts:62-75`). It `introduces` and is P0, so `batchIntentOf` returns null → never combined, no slot, no send window, no @mention, no quote (`batching.ts:47`; `deliver.ts:192-195`). Not counted in any cap (`engine.ts:248-268`, `:451` counts `providerBatch` rows only).

```
Dear Lab X,

You have a *new order* with the following details:

👤 *Name:* Patient-A
📞 *Contact:* <patient mobile>
📍 *Address:* <patient address>
🗺️ <map link>
🗓️ *Appointment:* 21 Oct 2026, 7:00 am
🧪 *Tests:* <tests>
🆔 *Order ID:* 90001

Please confirm this order here:
https://console.labstack.in/confirmation/tokA

– Team LabStack
```
(`src/lib/non-api-labs/templates.ts:125-140`; date/time via `deliver.ts:78-79` → `format.ts:7-15`.)

**10:20 — Message 2 (single): New order #2.** Same template for Patient-B, 7:30 am. Quiet window does not apply (it is per order conversation and NEW_ORDER is an introduction, `src/lib/provider-rules/evaluate.ts:237-242`; `engine.ts:123-136`).

**10:48 — Message 3 (single): New order #3.**

**11:05 / 11:20 / 11:48 — nothing goes out.** REMINDER_1H becomes due for #1, #2, #3 (`minutesSinceCreated: 60`, `builtins.ts:76`), but the lab is LIVE and the rule's template maps to intent UNCONFIRMED (`batching.ts:31`), whose slots are hourly 09:00-20:00 (`batching.ts:69`). `releaseAt` picks the first slot ≥ due = 12:00; every tick until then returns WAIT "goes in the 12:00 pm combined message" (`evaluate.ts:183-185`; `batching.ts:96-106`).

**11:30 — Message 4 (single): New order #4.**

**12:00 — Message 5 (combined, root R1): "please confirm (3)".** Tick 12:00: #1-#3 REMINDER_1H all due and released; #4's reminder is not due until 12:30 (`src/lib/engine/taskCreator.ts:261-275`). `deliverCombined` groups by lab → intent, UNCONFIRMED slot is open (12:00-12:59, `batching.ts:237-243`), slot allowance 3-0, day count 0 < 8 (`engine.ts:444-456`). `findFollowUp` finds no earlier UNCONFIRMED batch → fresh root, numbered 1..n by appointment time (`deliver.ts:370-371, 396-400`). @mentions the coordinator (`deliver.ts:383, 411`), quotes nothing.

```
@91XXXXXXXX01 please confirm (3)

1. #90001 · Patient-A · tomorrow 7:00 am
    https://console.labstack.in/confirmation/tokA2
2. #90002 · Patient-B · tomorrow 7:30 am
    https://console.labstack.in/confirmation/tokB2
3. #90003 · Patient-C · tomorrow 8:00 am
    https://console.labstack.in/confirmation/tokC2

Tap a link to confirm, or reply *1 can't do*
```
(`templates.ts:321-325`; line format `batching.ts:218-220, 224`; "tomorrow 7:00 am" from `shortWhen`, `batching.ts:196-206`.) Each of the three orders gets its own ledger SENT row and REMINDER_SENT timeline event (`deliver.ts:418-455`). Day cap count: 1 of 8.

**12:30 — nothing.** #4 REMINDER_1H due → slot 13:00.

**13:00 — Message 6 (combined, root R2): "please confirm (1)".** Only #4 is due. `findFollowUp` walks recent UNCONFIRMED batches and requires EVERY order in the new group to be in one root (`deliver.ts:348`); #4 was not in R1 → fresh root with its own numbering:

```
@91XXXXXXXX01 please confirm (1)

1. #90004 · Patient-D · tomorrow 8:30 am
    https://console.labstack.in/confirmation/tokD2

Tap a link to confirm, or reply *1 can't do*
```
Note the footer still says "reply *1 can't do*" (static text, `templates.ts:325`). Day count 2.

**13:05 / 13:20 / 13:48 — nothing.** REMINDER_3H for #1-#3 (`builtins.ts:77`) → same UNCONFIRMED intent → slot 14:00.

**14:00 — Message 7 (combined, FOLLOW-UP of R1): "still open: 1, 2, 3 🙏".** Group = #1, #2, #3 (REMINDER_3H). Recent batches newest first: R2 (13:00) does not contain them → skip; R1 contains all three and WhatsApp accepted it (`sentWaMsgId`) → attempt = 0 follow-ups so far + 1 = 1 → BATCH_FOLLOW_UP (`deliver.ts:338-355, 387-395`; `templates.ts:347`). Sent as a WhatsApp reply quoting R1 (`quotedWaId`, `deliver.ts:409`), @mentioning the coordinator, keeping R1's numbers:

```
@91XXXXXXXX01 still open: 1, 2, 3 🙏
```
Day count 3. This is the second combined ask about these orders.

**14:10 — Lab replies "1-4 ok", quoting message 7. Nothing is recorded.** Trace: `attributeToBatch` finds the quoted outbound's `providerBatch` (`src/lib/provider-rules/replies.ts:179-182`), then `splitBatchReply("1-4 ok", items)`: tokens split on `,;` newline or ". " → one token "1-4 ok"; the numbered-reply regex accepts separators `&`, `and`, `/` or whitespace only, not a dash (`batching.ts:160-161`), the bare-number regex fails too, and the one-item fallback does not apply (3 items, `batching.ts:174`) → empty map. Because the message quotes a combined message, the function returns zero parts rather than null, the caller loops over nothing and `continue`s (`replies.ts:104-113`, comment `:169-170` "never guessed onto one order"). No fact, no ANSWERED, no timeline note, and the bot sends no acknowledgement (auto-acks are Phase 2, `DOCS/features/provider-communication/ORDER-JOURNEY-AGENT.md:166-179`). Had the lab written "1, 2, 3 ok" it would parse — but "ok" yields only a `note` fact (`src/lib/provider-rules/reply-extract.ts:54`; there is no "confirmed" fact kind, `src/lib/provider-rules/types.ts:26-29`) and would mark only REMINDER_3H answered for those orders (`replies.ts:158-159`); ESCALATION_5H and APPT_2H are separate rules with their own ledgers and would still fire. "4" would be dropped anyway: there is no item 4 in message 7, #4 is "1" in R2 (`batching.ts:163-165`). Worse than a dash: "1 to 4 ok" DOES match the numbered regex — group 1 = "1", the rest "to 4 ok" — and is recorded as item 1 saying "to 4 ok" (`batching.ts:160, 163-166`), marking only #1 answered (`replies.ts:106-110, 159`).

**14:10 — Message 8 (single): New order #5.** Immediate, same minute as the lab's reply.

**14:15 — Lab taps the four confirmation links.** LabStack moves #1-#4 to ORDER_SCHEDULED. Next tick: `recordConfirmations` flips each conversation WAITING_FOR_LAB_CONFIRMATION → LAB_ACCEPTED and writes a LAB_ACCEPTED event (`engine.ts:275-293`). From here REMINDER_3H for #4 (due 14:30), ESCALATION_5H for #1-#4 (due 15:05-16:30) and APPT_2H all SKIP: status not in PENDING/CREATED (`builtins.ts:18, 39, 52` → `evaluate.ts:152-153`) and conversation not open (`builtins.ts:26` → `evaluate.ts:171-174`). This is the only thing that stops the confirmation ladder — the text reply did not.

**15:00 — nothing.** #4's 3 h reminder is skipped (confirmed). #5 REMINDER_1H due 15:10 → slot 16:00.

**16:00 — Message 9 (combined, root R3): "please confirm (1)"** for #5 (`1. #90005 · Patient-E · tomorrow 9:00 am` + link). No earlier root contains #5 → fresh numbering. Day count 4. The 16:00 ESCALATION slot (`batching.ts:70`) has nothing: #1-#3's escalations are skipped.

**16:45 — Message 10 (single): New order #6.**

**17:00 — nothing.** #5 REMINDER_3H due 17:10 → 18:00; #6 REMINDER_1H due 17:45 → 18:00.

**18:00 — Message 11 (combined, root R4): "please confirm (2)".** Group = #5 (REMINDER_3H) + #6 (REMINDER_1H): different rules, same intent, one message (`engine.ts:438-443`). R3 contains #5 but not #6 → no follow-up → fresh root; #5 is now "1" for the second time:

```
@91XXXXXXXX01 please confirm (2)

1. #90005 · Patient-E · tomorrow 9:00 am
    https://console.labstack.in/confirmation/tokE3
2. #90006 · Patient-F · tomorrow 10:00 am
    https://console.labstack.in/confirmation/tokF2

Tap a link to confirm, or reply *1 can't do*
```
Day count 5. ESCALATION_5H for #5 becomes due 19:10 → next ESCALATION slot is Wed 10:00 (`batching.ts:70, 96-106`).

**19:00 — Message 12: evening list (SUMMARY_TOMORROW).** Kind SUMMARY, 19:00 local, open until 22:00 (`builtins.ts:98-113`; `evaluate.ts:257-262`), once per lab per day (`engine.ts:300-305`), not a batch so no @mention, no cap (`deliver.ts:252-281`). Lists every open order with a Wed appointment (`evaluate.ts:265-274`), sorted by time (`src/lib/provider-rules/summary.ts:65-74`), confirm link only for unconfirmed ones (`summary.ts:45-47`):

```
📋 *Tomorrow's orders – Wed 21 Oct*
Lab X · Total: *6*

*1. 7:00 am* – Patient-A · #90001
   📍 <address>
   🗺️ <map link>
   🧪 <tests>

*2. 7:30 am* – Patient-B · #90002
   …

*3. 8:00 am* – Patient-C · #90003
   …

*4. 8:30 am* – Patient-D · #90004
   …

*5. 9:00 am* – Patient-E · #90005
   📍 <address>
   🗺️ <map link>
   🧪 <tests>
   ⚠️ _Not confirmed_ – https://console.labstack.in/confirmation/tokE4

*6. 10:00 am* – Patient-F · #90006
   …
   ⚠️ _Not confirmed_ – https://console.labstack.in/confirmation/tokF3

✅ Confirmed: 4   ⚠️ Pending: 2

Please confirm any pending orders tonight. Thank you!
```
(`templates.ts:264-271`; `summary.ts:23-53, 80-105`.) The summary shows the full patient name (`summary.ts:31`), unlike combined lines.

**19:45 — nothing.** #6 REMINDER_3H due → 20:00.

**20:00 — Message 13 (combined, FOLLOW-UP of R4): "still open: 2 🙏".** Group = #6 only; R4 contains it → attempt 1 → quotes R4, keeps #6's number 2. Day count 6 of 8. Last UNCONFIRMED slot of the day (`batching.ts:69`).

**21:45 — nothing.** #6 ESCALATION_5H due → Wed 10:00.

**Tuesday total the lab group sees: 13 messages** (6 new-order singles + 6 combined + 1 evening list). Manager: 0.

### Wednesday

**05:00-06:30 — nothing, and never.** ASSIGN_PHLEBO for #1-#4 (confirmed, no phlebo in LabStack) is due 2 h before each visit (`builtins.ts:116-129`), intent PHLEBO, first slot 08:30 (`batching.ts:71`). At the 08:30 tick `notAfterAppointment` sees visits at 07:00/07:30/08:00 already past and #4's 08:30 as `<= now` → SKIP "appointment has passed" (`evaluate.ts:147-149`). The bot never asks for a phlebo for any of them. The late phlebo on #2 (assigned 07:40 in LabStack, after the 07:30 visit) is invisible to the bot: PHLEBO_ETA is off for everyone (`src/lib/provider-rules/standard-set.ts:31`).

**07:00 — APPT_2H for #5 due** (visit 09:00) → UNCONFIRMED slot 09:00 → at 09:00 the visit time equals now → SKIP (`evaluate.ts:147`). Never sent. APPT_2H for #6 due 08:00 → 09:00.

**07:25 / 08:15 / 08:20 — LabStack: #1, #3, #2 SAMPLE_COLLECTED.** Their STATUS_CHECK (30 min after the visit, `builtins.ts:87-97`) is skipped by status (`NOT_COLLECTED_STATUSES`, `builtins.ts:22`).

**09:00 — Message 14 (combined, FIRM FOLLOW-UP of R4) for #6.** APPT_2H (`builtins.ts:84`, 120 min > 90 so it is slotted, `batching.ts:50-51`). `findFollowUp` finds the 20:00 follow-up → root R4 (18:00) within 24 h → attempt = 1 existing follow-up + 1 = 2 → BATCH_FOLLOW_UP_FIRM (`deliver.ts:391`; `templates.ts:348`), quoting R4:

```
@91XXXXXXXX01 reminder — 2 still pending since 6:00 pm. Please update in LabStack or reply here.
```
`since` is `formatTime(root.createdAt)` — time only, no "yesterday" (`deliver.ts:394`). Wed day count 1. This is the third ask about #6 (18:00 root, 20:00 polite, 09:00 firm): the "modulated rhythm" ends here; there is no manager message or call for #6 (see 10:00).

**10:00 — ESCALATION slot: nothing, and never.** #5's and #6's 5 h escalations (due Tue 19:10 / 21:45) wait for this slot, but ESCALATION_5H has `notAfterAppointment` (`builtins.ts:42, 78`): #5's 09:00 visit has passed and #6's 10:00 visit is `<= now` at the 10:00 tick → both SKIP. The manager is never told about #5 or #6.

**09:00 / 09:30 / 10:30 — STATUS_CHECK due** for #4 (visit 08:30 + 30 min, `builtins.ts:91`; still ORDER_SCHEDULED in LabStack), #5 and #6 (PENDING; the rule runs whether or not the lab confirmed, `builtins.ts:90-93`). Intent STATUS, slots 11:00 / 13:30 / 16:00 / 18:30 (`batching.ts:73`) → STATUS slot 11:00.

**11:00 — Message 15 (combined, root R5): "quick check — collected? (3)".**

```
@91XXXXXXXX01 quick check — collected? (3)

1. #90004 · Patient-D · 8:30 am
2. #90005 · Patient-E · 9:00 am
3. #90006 · Patient-F · 10:00 am

Reply *1 done, 2 not home* or *all done*
```
(`templates.ts:306-310`; line `batching.ts:228`.) Wed day count 2.

**11:20 — Lab replies "1 collected, 2 3 not possible", quoting message 15.** Parses: "1 collected" → item 1; "2 3 not possible" → whitespace-separated numbers → items 2 and 3 (`batching.ts:160-166`). Item 1 (#4): `sample_collected` fact (`reply-extract.ts:46`), PROVIDER_NOTE event, STATUS_CHECK marked ANSWERED (`replies.ts:133-159`). Items 2-3 (#5, #6): with the pattern reader "not possible" matches no kind and becomes a `note` (`reply-extract.ts:49, 54`; Claude, when configured, may return `cannot_fulfil`, `:60-66, 85-94`). Either way no built-in rule gates on `cannot_fulfil` and facts never change LabStack status (`DOCS/features/provider-communication/DESIGN.md:166-167`), so #5/#6 stay PENDING; STATUS_CHECK is one-shot anyway (`maxSends` 1, `evaluate.ts:161-163`).

**12:00 — LabStack: #4 SAMPLE_COLLECTED.** Nothing to send.

**13:00 — nothing.** Through Wed 13:00 the lab has seen **2 messages** (09:00 firm follow-up, 11:00 status check). Manager: 0.

**What follows (outside the window):** REPORT_CHASE is due 12 h after each visit (`builtins.ts:144-159`): 19:00/19:30 Wed for #1/#2 (inside the 08-20 send window — `inSendWindow` is `hour >= 8 && hour < 20`, `evaluate.ts:78-83`, `builtins.ts:157-158` — but after the last 16:30 REPORT slot), 20:00/20:30 for #3/#4 (hour 20 is not < 20 → outside the window → opens Thu 08:00, `evaluate.ts:85-99`); all four land in the REPORT slot Thu 10:30 (`batching.ts:74, 96-106`) as one "reports pending (N)" listing whichever of #1-#4 LabStack still shows undelivered — #3's late report is chased there, then at 16:30 Thu as "still open: 3 🙏", then Fri 10:30 firm (repeat 180 min re-slotted, `evaluate.ts:191-196`; max 4). Nothing chases #5/#6 further: no rule covers an unconfirmed order after its visit.

### Where the mechanics did and did not bite

- **Slots** bit everywhere: eight asks waited for a slot — the seven confirmation asks 12-60 min for an hourly UNCONFIRMED slot (`batching.ts:69`), the Wed status check 30-120 min for the 11:00 STATUS slot (#4 due 09:00, #5 09:30, #6 10:30; slots 11:00/13:30/16:00/18:30, `batching.ts:73`; `builtins.ts:91`); nothing between 20:00 and 09:00 except the 19:00 list.
- **`notAfterAppointment` + slot timing** bit hardest: ASSIGN_PHLEBO (4 orders), APPT_2H (#5), ESCALATION_5H (#5, #6) were silently skipped because their slot came after the visit (`evaluate.ts:147-149`; `batching.ts:69-71, 96-106`).
- **Per-slot cap (3)**: never reached — only one intent was ever due per slot. It would bite only with ≥4 intents due in one :00/:30 window (`engine.ts:448-449, 455`).
- **Per-day cap (8)**: never reached — 6 combined on Tue (`engine.ts:451, 456`). It does not count the 6 new-order singles or the evening list, which is why the lab saw 13 messages on Tue against the review's target of ≤5 (`DOCS/features/provider-communication/CHAT-REVIEW-OCT-2026.md:192`).
- **Quiet window (10 min per order)**: never bit — no order had two sends within 10 min (`evaluate.ts:237-242`).
- **Near-visit immediate path** (≤90 min before the visit, `batching.ts:48-51`): never fired — the only rules that use it (APPT_30M, APPT_10M, PHLEBO_ETA) are off for every lab (`standard-set.ts:31`).
- **Facts stopping messages**: the only stop in this story was the LabStack confirmation (links at 14:15), which skipped 5 per-order sends in 3 messages: the 15:00 follow-up for #4 (REMINDER_3H due 14:30 → UNCONFIRMED slot 15:00) and manager DMs at 16:00 for #1-#3 (ESCALATION_5H due 15:05/15:20/15:48 → ESCALATION slot 16:00) and 18:00 for #4 (due 16:30 → slot 18:00) (`builtins.ts:77-78`; `batching.ts:69-70, 96-106`; `engine.ts:438-443`). APPT_2H for #1-#4 would have been skipped anyway by timing (`evaluate.ts:147-149`). The `sample_collected` fact at 11:20 stopped nothing new (STATUS_CHECK is one-shot). The "1-4 ok" text stopped nothing.
- **Had the lab only texted and never tapped a link** (aside): Tue 15:00 "still open: 1 🙏" (follow-up of R2 for #4); Tue 16:00 manager DM `Hello <manager>, Lab X has not yet confirmed 3 orders:` with lines `1. #90001 · Patient-A · tomorrow 7:00 am · waiting 5 h` + link (`templates.ts:336-340`; `batching.ts:225`), no mention, no quote, exempt from the day cap (`deliver.ts:381-382`; `engine.ts:451`); Tue 18:00 a second manager DM for #4 ("waiting 6 h"); Wed 09:00 APPT_2H for #1-#4 skipped (visits before 09:00).

### Compact table

| Time | Message | Orders | Trigger |
|---|---|---|---|
| Tue 10:05 | New order (single, full details + link) | #1 | NEW_ORDER, P0/introduces → immediate |
| Tue 10:20 | New order (single) | #2 | same |
| Tue 10:48 | New order (single) | #3 | same |
| Tue 11:30 | New order (single) | #4 | same |
| Tue 12:00 | "please confirm (3)" root R1, @coord | #1 #2 #3 | REMINDER_1H due 11:05-11:48 → UNCONFIRMED slot 12:00; slot 1/3, day 1/8 |
| Tue 13:00 | "please confirm (1)" root R2, @coord | #4 | REMINDER_1H due 12:30 → slot 13:00; #4 not in R1 → fresh root; day 2/8 |
| Tue 14:00 | "still open: 1, 2, 3 🙏" quoting R1, @coord | #1 #2 #3 | REMINDER_3H due 13:05-13:48 → slot 14:00; all in R1 → follow-up attempt 1; day 3/8 |
| Tue 14:10 | (lab: "1-4 ok" quoting 14:00) | — | not parsed; nothing recorded |
| Tue 14:10 | New order (single) | #5 | NEW_ORDER |
| Tue 14:15 | (lab taps 4 links → ORDER_SCHEDULED) | #1-#4 | conversations → LAB_ACCEPTED; ladder stops |
| Tue 16:00 | "please confirm (1)" root R3, @coord | #5 | REMINDER_1H due 15:10 → slot 16:00; day 4/8 |
| Tue 16:00 | (manager escalation slot: nothing) | — | ESCALATION_5H #1-#3 skipped: confirmed |
| Tue 16:45 | New order (single) | #6 | NEW_ORDER |
| Tue 18:00 | "please confirm (2)" root R4, @coord | #5 #6 | #5 REMINDER_3H (17:10) + #6 REMINDER_1H (17:45) → slot 18:00; mixed → fresh root; day 5/8 |
| Tue 19:00 | Evening list "Tomorrow's orders – Wed 21 Oct", 6 entries, 2 with links | #1-#6 | SUMMARY_TOMORROW 19:00; not a batch |
| Tue 20:00 | "still open: 2 🙏" quoting R4, @coord | #6 | REMINDER_3H due 19:45 → slot 20:00; follow-up attempt 1; day 6/8 |
| Wed 08:30 | (phlebo slot: nothing, ever) | #1-#4 | ASSIGN_PHLEBO slot after visits → skipped |
| Wed 09:00 | "reminder — 2 still pending since 6:00 pm…" quoting R4, @coord | #6 | APPT_2H due 08:00 → slot 09:00; attempt 2 → firm; #5 skipped (visit 09:00) |
| Wed 10:00 | (manager escalation slot: nothing, ever) | #5 #6 | ESCALATION_5H due Tue 19:10/21:45 → slot after visits → skipped |
| Wed 11:00 | "quick check — collected? (3)" root R5, @coord | #4 #5 #6 | STATUS_CHECK due 09:00-10:30 → STATUS slot 11:00 |
| Wed 11:20 | (lab: "1 collected, 2 3 not possible") | #4 #5 #6 | sample_collected on #4; note/cannot_fulfil on #5 #6; no rule reacts |
| Thu 10:30 | "reports pending (N)" (next) | #1-#4 undelivered | REPORT_CHASE 12 h after visit, 08-20 window → REPORT slot |

**Counts:** Tue 13 messages to the lab group (6 single + 6 combined + 1 list), Wed through 13:00: 2. Manager: 0 on both days. Bot messages per order, counting the evening list (it names all six, `evaluate.ts:265-274`; `summary.ts:66-74`): #1 4, #2 4, #3 4, #4 4, #5 5, #6 6. Excluding the list (it is one `labCommunication` with `orderId: null`, `deliver.ts:262-267`, so it is not an order-level row; each combined send writes one ledger/communication/event row per order, `deliver.ts:414-455`): #1 3, #2 3, #3 3, #4 3, #5 4, #6 5.

## B. Why a lab answers instead of ignoring — what we changed

Baseline from the chat review (`DOCS/features/provider-communication/CHAT-REVIEW-OCT-2026.md`, hereafter CR): 20.8 / 8.2 bot messages per lab-day, 5-7 per order (max 16), 98 of 323 sent 21:00-08:00, labs replied within 30 min to 19-20% of bot messages vs 37-55% of team messages, named the order 0-1% of the time, bot messages ≈250 characters vs lab replies 12-19, 0 combined messages (CR:9-19). Targets: ≤5 bot messages/lab/day, ≤2 per order, ≥40-50% replies within 30 min, >40% name the order (CR:190-196).

### B1. Fewer, combined messages
- **Problem:** "Every follow-up went per order, often five in the same minute (07:30 status checks)"; one order got 16 messages from 4 families (CR:21-27, 69-71). Engagement reading: "Repetition trains people to ignore" (CR:78-80).
- **Built:** rules still decide per order, but on a LIVE lab every combinable item waits for its intent's slot and goes out as one numbered message per lab per intent (`batching.ts:1-20, 46-55`; `engine.ts:206-222, 434-459`; `deliver.ts:368-479`). One line per order, sorted by visit time (`deliver.ts:370-371`; `batching.ts:217-230`). Every lab is LIVE (`standard-set.ts:75`; schema default `schema.prisma:1522`). A paused combined template falls back to singles so nothing is dropped (`deliver.ts:374`; `engine.ts:460-469`).
- **Lab experiences:** in section A, the 11 unconfirmed-order reminders over Tue (12:00 ×3, 13:00 ×1, 14:00 ×3, 16:00 ×1, 18:00 ×2, 20:00 ×1 — one ledger row each, `deliver.ts:414-432`) arrived as 6 short combined messages instead of 11 per-order ones; the three Wed status checks were one message.
- **Not combined / not built:** new-order messages are never combined (`batching.ts:13-14, 47`) — with back-to-back orders they are the majority of what the lab sees (6 of 13 on Tue) and still open "Dear {{lab_name}}" with ~250 characters (`templates.ts:125-140`), the exact shape CR:39-40 flagged. The review's proposed short new-order format (CR:161-167) and "Today's visits" morning list (CR:125-134) are not in the templates.

### B2. Slots inside working hours
- **Problem:** a third of Lab A's bot messages went out before 08:00 or after 21:00; "Timing is a signal" (CR:41-43, 83-84).
- **Built:** `DAILY_SLOTS` — confirmation hourly 09:00-20:00, escalation 10/12/14/16/18, phlebo and ETA 08:30-18:30 every 2 h, status 11:00/13:30/16:00/18:30, reports 10:30/16:30 (`batching.ts:63-78`). A held item is released only inside a slot's 60-min window, never at midnight (`batching.ts:232-243`; `engine.ts:454`). Repeats snap to the next slot (`evaluate.ts:191-196`). Report chase additionally has a send window 08-20 (`builtins.ts:156-158`).
- **Lab experiences:** nothing combined before 08:30 or after 20:59 (first slot PHLEBO/ETA 08:30, last slot UNCONFIRMED 20:00, and every slot stays open for 60 min, `batching.ts:69-72, 237-242`); in section A nothing at all between 20:00 and 09:00 except the 19:00 list.
- **Caveat:** NEW_ORDER has no send window and is immediate at any hour (`builtins.ts:62-75`; `batching.ts:47`) — an order placed at 23:30 still pings the group at 23:30.

### B3. Caps
- **Problem:** 8-21 bot messages per lab-day (CR:11, 192); principle "A daily rhythm, not a drip. At most 4-5 bot messages per lab per day" (CR:96-97).
- **Built:** `maxBatchesPerSlot` default 3 and `maxMessagesPerDay` default 8, manager escalations exempt (`schema.prisma:1524, 1529`; `engine.ts:446-456`). Over the cap, lower-ranked intents wait (rank ESCALATION > PHLEBO > ETA > STATUS > UNCONFIRMED > OVERDUE > REPORT, `batching.ts:27, 57-61`; `engine.ts:452`); held items carry up to 24 h past their slot rather than being dropped (`evaluate.ts:118-123, 186-190`).
- **Lab experiences:** never more than 3 combined messages in a half-hour; never more than 8 non-escalation combined messages per day — manager escalations are uncounted (`engine.ts:451, 456`) and, for a lab with no manager number on file, are delivered to the lab group itself on top of the 8 (`deliver.ts:376-378` falls back to the lab target; `:467-476` raises the "went to the lab instead" alert).
- **Honest gap:** the cap counts `providerBatch` rows only (`engine.ts:451`); singles and the evening list are uncounted, so the built cap of 8 plus uncapped singles is well above the review's ≤5 target (CR:192) — 13 on Tue in section A. The per-slot counter window is the latest :00/:30 (`batching.ts:113-117`; `engine.ts:444, 448`) while a slot stays open 60 min, so an hourly slot can carry up to 2×3.

### B4. Follow-ups that quote and keep numbering
- **Problem:** the team's pattern that works is "a reply quoting the earlier message", "repeated by the hour until answered" (CR:47-53); principle 2 "Follow up in-thread" (CR:94-95).
- **Built:** when every order in a new send was in one combined message to this lab, same intent, in the last 24 h, and WhatsApp accepted it, the bot replies to that original (`quotedWaId`) and reuses its numbers (`deliver.ts:332-355, 387-395, 409-410`). Each follow-up records `followUpOf` the root (`deliver.ts:460`).
- **Lab experiences:** section A messages at Tue 14:00, 20:00 and Wed 09:00 appear in WhatsApp as replies to the earlier numbered message, so "2" still means #6.
- **Gap:** any group with one order not in the root gets a fresh root and fresh numbering (`deliver.ts:348`) — Tue 18:00 in section A gave #5 the number "1" for a second time. Manager escalations never quote (`deliver.ts:382`).

### B5. Firmer wording from the 3rd ask
- **Problem / decision:** "Build 3: not as proposed. No handover after two misses: the bot keeps going with a modulated rhythm (2nd ask polite, 3rd on firmer, then the manager and calls)" (CR:206-209).
- **Built:** attempt 1 → `{{coordinator}} still open: {{numbers}} 🙏`; attempt ≥2 → `{{coordinator}} reminder — {{numbers}} still pending since {{since}}. Please update in LabStack or reply here.` (`templates.ts:347-348`; `deliver.ts:391-395`).
- **Lab experiences:** Wed 09:00 message in section A.
- **Not built:** "then the manager and calls" after the firm ask has no code: the manager is reached only by the fixed ESCALATION_5H rung (B11), and Exotel calls are Phase 3 (`ORDER-JOURNEY-AGENT.md:181-196, 357`). Also `since` prints a time with no date (`deliver.ts:394`).

### B6. @mentioning a coordinator
- **Problem:** "People answer people"; 85% of the team's messages @mention the coordinator; replies 37-55% vs 19-20% (CR:15-16, 55, 75-77).
- **Built:** every combined message and follow-up starts with `{{coordinator}}` = "@<number>" tokens, and the outbound carries the jids as real mentions (`deliver.ts:313-320, 383, 411`; `templates.ts:306-348`). Who: people named on Lab Config, else the most active lab-side writer in the group over 30 days, LabStack team excluded, cached 10 min (`src/lib/wa/coordinators.ts:18-64`). "Team" when nobody has written.
- **Lab experiences:** the coordinator gets a WhatsApp notification on each combined ask.
- **Gap:** singles (new order, anything ≤90 min before the visit) and the evening list carry no mention (`deliver.ts:192-195, 270`), although `batching.ts:20` and `schema.prisma:1525-1526` say every message does.

### B7. Short templates
- **Problem:** bot ≈250 chars, lab replies 12-19; "Short asks get short answers" (CR:18, 39-40, 81-82).
- **Built:** combined bodies are a one-line header, one line per order, and a one-line reply recipe (`templates.ts:303-345`); item lines are fixed in code so numbering cannot break (`batching.ts:217-230`). Phase-1 emoji-header bodies that nobody edited are migrated to the short ones (`templates.ts:475-505` per dossier).
- **Gap:** single-order bodies are unchanged ("Dear {{lab_name}}", "Hi {{lab_name}}", `templates.ts:125, 143, 179`).

### B8. Numbered replies understood
- **Problem:** labs named the order in 0-1% of replies (CR:17); replies are "Checking", "This one possible, remaining not possible" (CR:52-53).
- **Built:** a reply quoting a combined message, or arriving within 3 h of one with no single after it, is split per item: "1 done, 2 not home", "1,2 collected. 3 rescheduled", "1 & 2", "all/sab/sabhi …", or by order id (`batching.ts:121-176`; `replies.ts:163-200`). Each part writes facts and a PROVIDER_NOTE and marks that item's rule answered (`replies.ts:133-161`).
- **Lab experiences:** Wed 11:20 in section A — "1 collected, 2 3 not possible" lands on three orders.
- **Gap:** dash ranges ("1-4 ok") are dropped (`batching.ts:160-161`); "1 to 4 ok" is worse — it parses as item 1 saying "to 4 ok" (`batching.ts:160, 163-166`) and marks only that order answered while 2-4 record nothing (`replies.ts:106-110, 159`); a quoted reply with no numbers ("checking") records nothing; team members' messages in the group count as the lab's (`replies.ts:91`).

### B9. Facts stopping repeats
- **Built:** fact kinds eta, phlebo_name, phlebo_phone, delay_reason, sample_collected, patient_unavailable, new_appointment_time, report_shared, cannot_fulfil, note (`types.ts:26-29`), extracted by Claude or regex (`reply-extract.ts:33-56, 85-94`). Rules gate on them: STATUS_CHECK on `sample_collected`, ASSIGN_PHLEBO on `phlebo_name`, REPORT_CHASE on `report_shared` (`builtins.ts:95, 122, 150`; `evaluate.ts:154-158`). Any attributed reply marks the asking rule ANSWERED, which stops its repeats (`replies.ts:158-159`; `engine.ts:353-358`; `evaluate.ts:164`). LabStack confirmation auto-closes the confirmation ladder (`engine.ts:275-293`).
- **Lab experiences:** "1 Suresh 98xxxxxx09" to a phlebo ask ends that chase; "report shared" ends the report chase.
- **Gap:** no fact kind means "confirmed"; the 1 h / 3 h / 5 h / 2 h-before rungs are separate rules, so a text reply stops at most one rung — only the link or LabStack stops the ladder. `cannot_fulfil` and `patient_unavailable` gate nothing. Facts never expire and have no confidence threshold (`engine.ts:163-177`).

### B10. Near-visit urgency
- **Decision:** "Asks timed within 90 min of the visit still go straight away" (CR:202-203).
- **Built:** `minutesBeforeAppointment ≤ 90` → not batched, sent immediately (`batching.ts:48-51`).
- **Reality:** no active rule uses it (APPT_30M, APPT_10M, PHLEBO_ETA are off, `standard-set.ts:31`). Meanwhile the 2 h asks (APPT_2H, ASSIGN_PHLEBO) are slotted and are skipped for visits before ~09:00 / ~08:30 (section A).

### B11. Lab-manager escalation
- **Built:** ESCALATION_5H (5 h after the order, still unconfirmed, P1, ESCALATE → MANAGER, `builtins.ts:78-82`) goes to the manager's personal WhatsApp at 10/12/14/16/18 as one list with "waiting N h" and links, exempt from the day cap, no mention or quote (`deliver.ts:376-382, 411`; `templates.ts:336-340`; `engine.ts:451`). No manager on file → same text to the lab group plus an URGENT in-app alert (`deliver.ts:467-476`). The conversation is marked ESCALATED (`deliver.ts:433-443`).
- **Gap:** `notAfterAppointment` plus 2-hourly slots means orders placed after ~13:00 for a next-morning visit never reach the manager (section A, #5/#6). Bot calls (Exotel) are approved but not built (`ORDER-JOURNEY-AGENT.md:357`).

### B12. The bot leads (no stepping back)
- **Decision:** "Build 2: no. The bot takes the lead; it does not step back when the team is chasing, and it still sends the new-order message" (CR:204-205).
- **Code:** nothing in the engine or reply pass pauses a rule because a team member wrote (no code path; replies.ts has no sender filter, `replies.ts:91`).
- **Lab experiences:** both the coordinator-on-the-team and the bot may chase the same order — the "two voices" risk CR:85-86 named is accepted.

### B13. One standard set, no per-lab config
- **Problem:** combined messages were "Off (or not yet deployed) for both labs" (CR:69-70); three families chased the same report (CR:28-31).
- **Built:** `applyStandardSet` runs once: ON for all labs NEW_ORDER, REMINDER_1H, REMINDER_3H, ESCALATION_5H, APPT_2H, STATUS_CHECK, ASSIGN_PHLEBO, REPORT_CHASE, SUMMARY_TOMORROW; OFF APPT_24H, APPT_30M, APPT_10M, PHLEBO_ETA, SUMMARY_PENDING_REPORTS; per-lab scoping cleared; converted/per-lab copies retired with their send history carried over; every lab LIVE (`standard-set.ts:1-14, 21-31, 33-77`). Later Message Rules edits are global and stick.
- **Lab experiences:** every lab gets the same rhythm; no lab can be forgotten on OFF.

### B14. Removal of polls
- **Problem:** "Polls were still attached until 6 Oct" (CR:34); replies to polls were not the main channel (`DESIGN.md:168-170`).
- **Built:** single messages are created with no poll ("No polls: labs answer in their own words", `deliver.ts:193-194`); the status check asks "Please reply to this message with the status" (`templates.ts:179-184`), and the legacy poll body is migrated.
- **Lab experiences:** no vote buttons; a typed reply is what the bot reads.

### B15. The 'not on file' fix
- **Problem:** under load the details lookup timed out and new-order messages went out with "Not on file" placeholders (commit `222068d`, 20 Oct 2026).
- **Built:** details come from the worker pool with its own breaker and a 20 s deadline (`src/lib/non-api-labs/order-details.ts:150-197`); when the lookup itself fails (null from the pool, deadline or breaker) or returns no row for the order, that send is held — nothing recorded, retried next pass (`engine.ts:234-243`; `:238` holds only orders missing from the result map; `:325, 339-340` for the summary).
- **Lab experiences:** no message goes out because the lookup timed out; but an order that LabStack itself holds with no mobile/address is still a row in the result (`order-details.ts:201-203`, `patientMobile: clean(row.mobile) || null`) and renders with the placeholders "Not on file" / "Address not on file – please check LabStack" / "Map not available" (`order-details.ts:82-88`, spread into every single message at `deliver.ts:90`; `patient_name` falls back to "Patient", `deliver.ts:77`).

### B16. One message per order per tick, and a quiet window per order
- **Problem:** "often five in the same minute" (CR:21-27); messages that pile up on one order read as automated (CR:78-80).
- **Built:** `planOrder` sends at most one message per order per tick — an introduction first, then the lowest-P rule; the rest wait for a later tick (`evaluate.ts:211-215` comment, `:231-236` winner sort). The lab's `quietWindowMinutes` (default 10, "Minimum gap between two messages about the SAME order", `schema.prisma:1514-1518`) holds back every non-P0, non-introducing winner while the conversation's `lastMessageAt` is less than 10 min old (`evaluate.ts:237-243`).
- **Lab experiences:** a P0 new-order message is the only thing that can follow another message about the same order within 10 min; in section A the window never bit because no order had two sends that close.

### B17. Stale asks are never sent late
- **Problem:** a reminder that arrives hours after its moment (or a "tomorrow" list sent at midnight) is a wrong message, not a late one.
- **Built:** an ORDER rule whose first occurrence is more than `catchUpMinutes` past its allowed moment (plus 24 h slack for a slotted item) is recorded MISSED and not sent (`evaluate.ts:186-190`; `catchUpMinutes` default 30, `schema.prisma:2043`; NEW_ORDER 1440 so an outage still reaches the lab the same day, `builtins.ts:72`). The evening list is open from 19:00 for its `catchUpMinutes` = 180 and dropped after that ("a summary hours late is a wrong message", `evaluate.ts:252-262`; `builtins.ts:107`) and is capped at 12 entries with an "…and N more — full list in LabStack." tail (`summary.ts:18-19, 27, 50-51`). Orders in CANCELED / REPORT_DELIVERED / PATIENT_MISSED are excluded from the read entirely, so nothing is ever sent about them (`engine.ts:40, 93`).
- **Lab experiences:** no 3 h reminder at 02:00 after a restart, no "tomorrow's orders" at 23:30, no chase on a cancelled order. The cost is C12: a MISSED row consumes the occurrence.

### Planned, not built (for completeness)
Auto-acks of what was understood, promise check-backs ("report by 6 pm" → check at 6:15), review queue (Phase 2, `ORDER-JOURNEY-AGENT.md:146-179, 222`); Exotel calls, take-over/snooze, needs-attention board, lab scorecard (Phase 3, `:181-196, 225, 235-239`); customer contact, serviceability, reschedule/cancel handling (`:354-374`).

## C. Where it can still fail

1. ~~**"1-4 ok" is not a reply the bot understands — and "1 to 4 ok" is misread.**~~ **Fixed 20 Oct 2026.** `splitBatchReply` reads ranges ("1-4", "1–4", "1 to 4", "1 se 4 tak") and mixes ("1-3, 5 ok") and expands them to each item; "1 to 4 ok" is items 1–4 saying "ok" (`batching.ts` `expandItemNumbers`, tests in `__tests__/batching.test.ts`). A reply that quotes a combined message and still cannot be placed is no longer dropped: every order in the batch gets a PROVIDER_NOTE (`unparsed: true`) with the text and the ask counts as answered; a bare "ok"/"done" with no numbers at all is read as a yes to the whole ask (`replies.ts` `runReplyPass`). Was: Dash ranges ("1-4 ok") fail both the numbered and bare-number regex and are dropped (`batching.ts:160-161`); a quoted combined reply with zero parsed parts records nothing and gets no ack (`replies.ts:104-113, 169-170`). "1 to 4 ok" is worse: the numbered regex matches "1" and treats "to 4 ok" as the text, so item 1's order gets a fact, a PROVIDER_NOTE and ANSWERED while items 2-4 record nothing (`batching.ts:160, 163-166`; `replies.ts:106-110, 159`). The lab believes it answered; the bot keeps asking.
2. ~~**Text never confirms an order.**~~ **Fixed 20 Oct 2026.** New reply fact `confirmed`: "ok", "okay", "done", "confirmed", "haan", "ho jayega", "will do", "theek hai", 👍 on a message that asked for a confirmation (new order, reminders, appointment pings, escalation) — not on a status check, and not when the same reply says "cannot"/"not"/"nahi" (`reply-extract.ts`, pattern reader and Claude prompt). Every rung of the ladder (REMINDER_1H/3H, ESCALATION_5H, APPT_24H/2H/30M/10M) gates on `confirmed: present=false` the way STATUS_CHECK gates on `sample_collected` (`builtins.ts` `NOT_CONFIRMED_IN_CHAT`; existing rows get the gate once in `migrate.ts`), so one text reply stops the whole ladder for that order. Nothing is written to LabStack and the conversation stays WAITING: the timeline gets a `LAB_CONFIRMED_IN_CHAT` event (vs `LAB_ACCEPTED` from the link/LabStack), and the evening list shows "✅ Confirmed in chat – not yet in LabStack" with the link instead of "⚠️ Not confirmed". Still open: nothing acts on `cannot_fulfil`. Was: No "confirmed" fact kind (`types.ts:26-29`); only the link, a poll tap or LabStack status moves the conversation (`engine.ts:275-293`). "ok will do" marks one rung answered and the next rung (own ledger) still fires (`evaluate.ts:161-164`; `replies.ts:158-159`). The escalation body still says "reply *NO* here" (`templates.ts:166`) but nothing acts on `cannot_fulfil`.
3. **Early-morning visits get no phlebo ask, no 2 h ping and no manager escalation.** First PHLEBO slot 08:30, first UNCONFIRMED slot 09:00, next ESCALATION slot after 18:00 is 10:00 next day (`batching.ts:69-71`), and `notAfterAppointment` is re-checked each tick (`evaluate.ts:147-149`). In section A this silently dropped 7 asks on the four early orders and never told the manager about #5/#6. The ≤90-min immediate path exists but no active rule uses it (`standard-set.ts:31`).
4. **Singles dominate with back-to-back orders and are untouched by the fixes.** NEW_ORDER is uncapped, unmentioned, unslotted, full-length and "Dear <lab>" (`batching.ts:47`; `deliver.ts:192-195`; `templates.ts:125-140`); only the gateway's 1.2 s spacing separates them. Tue in section A: 13 messages vs the ≤5 target.
5. **Mixed groups reset numbering.** A new order's 1 h reminder sharing a slot with an older order's 3 h reminder forces a fresh root (`deliver.ts:348`), so the same order can be "1" twice in an afternoon and a lab's "4" can point at nothing (`batching.ts:163-165`).
6. **Follow-up `since` has no date** (`deliver.ts:394`): "pending since 6:00 pm" the next morning.
7. **Per-slot cap is per :00/:30, slot window is 60 min** (`batching.ts:113-117, 237`; `engine.ts:444-449`): up to 6 combined in one open hour.
8. **Reply attribution with many open orders:** a bare "done"/"collected" with no quote, no id and no number is unattributed because ONLY_OPEN needs exactly one order messaged in 3 h (`replies.ts:55-64`) and a single after the last batch blocks the batch path (`replies.ts:189-195`). A message naming two orders outside a batch is attributed to one (`findFirst`, `replies.ts:46`).
9. **Team members' messages count as the lab's reply** (`replies.ts:91`, no roster filter), so an ops chase "@coord please update 90004" marks that order answered.
10. **Pattern reader is thin when Claude is off:** "done" alone is not `sample_collected` (`reply-extract.ts:46`), "not possible" is not `cannot_fulfil` (`:49`), only sab/sabhi are understood in Hindi (`batching.ts:121`); caption-less PDFs arrive as "📄 Document" and never set `report_shared`.
11. **Facts never expire or threshold** (`engine.ts:163-177`; `evaluate.ts:154-158`): a stale `phlebo_name` from a rescheduled order suppresses the next phlebo ask.
12. **MISSED and SKIPPED ledger rows consume an occurrence** (`engine.ts:152-156`, no outcome filter): a one-shot rule that missed its window, or whose template was paused for one minute, never sends.
13. **Evening report chases slip a night:** 12 h after a morning visit is 19:00-20:30, which the 08-20 window and the 10:30/16:30 REPORT slots push to the next morning (`builtins.ts:156-158`; `batching.ts:74`).
14. **Nothing chases an unconfirmed order after its visit** (every unconfirmed rule has `notAfterAppointment`; STATUS_CHECK is one-shot), and nothing reacts to "not possible" — #5/#6 in section A simply go quiet.
15. **Stale comment:** `builtins.ts:7-9` says the Oct-2026 group is "seeded PAUSED" while ASSIGN_PHLEBO and REPORT_CHASE carry `isActive: true` (`:120, 148`); the standard set makes them ON regardless.
16. **Live config unverified:** per-lab `batchingMode`, caps, `quietWindowMinutes`, named coordinators, manager numbers and Ops-edited template bodies (`ensureTemplate` keeps edits) are DB state and were not read.