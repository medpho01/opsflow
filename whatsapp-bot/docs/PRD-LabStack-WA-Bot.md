# LabStack WhatsApp Ops Bot — Product Requirements Doc

**Author:** Ops/Product · **Date:** 2026-08-10 · **Status:** Draft for review
**Related deliverables:** `out/LabStack-WA-Bot-Actions.xlsx` (per-message action sheet), running dry-run bot (`whatsapp-bot/`), `lib/playbook.mjs` (decision table).

---

## 1. TL;DR

The team is spending its day answering repetitive status questions across ~49 LabStack partner WhatsApp groups. We scraped the live message history straight off WhatsApp — **12,427 messages across the 7 active partner-ops groups** (June 14 → Aug 10). The finding:

- **~29% of substantive messages are a status/report/cancel-reason question the bot can answer instantly** from the LabStack database — *no human, no console*.
- **~48% of substantive messages need no human to type a reply** today (auto-answer + auto-route to a console task).
- With an **LLM+context layer**, auto-answer rises to **~49%**, and total deflection climbs toward **~65–75%** once serviceability/slot/price data is wired in.
- Only **~1.7%** genuinely needs a human immediately (angry customer, console outage).

**Recommendation:** ship in three phases, starting with a **read-only dry-run** (already live) → **auto-answer status on a dedicated number** → **route-to-console + LLM layer**. Keep the team in the console; let the bot own the WhatsApp noise.

---

## 2. Problem & context

Partners (Plum, Sugarfit, Orange, Pharmeasy, QUA, Good Health, Healthians, Metropolis, Thyrocare, and ~40 more) coordinate home-sample bookings with LabStack **entirely over WhatsApp groups**. The dominant message is *"any update on 58651?"* — a question whose answer already exists in our database. Today a human reads it, opens the console, looks it up, and types the answer back. Multiply by thousands of messages a month.

**Goal (from the business):** the team should work **only in the console**. Status-checking WhatsApp traffic should resolve **automatically**. Where the bot can't answer, it should quietly turn the message into a console task or escalate — not sit in a human's inbox.

**Non-goals (for now):** replacing human judgment on escalations; auto-negotiating price/serviceability without lab data; sending from a personal number.

---

## 3. Data & method

| | |
|---|---|
| **Source** | Live WhatsApp **history sync** scraped via Baileys from the linked account, scoped to Labstack groups only (personal groups dropped before saving). |
| **Volume** | **12,427 messages** across **7 active groups**, June 14 → Aug 10 (~2 months). |
| **Method** | Every message run through the **same rule-based classifier the live bot uses** (`lib/classifier.mjs`) → intent → disposition → action. Reply templates grounded in the **live `Order.orderStatus` / `Request.status`** values from the replica. |
| **Output** | `out/messages.csv` — one row per message with the exact bot decision → the Excel workbook. |

This is a faithful **preview of production**: the analysis and the live bot share one classifier and one playbook.

### 3.1 Data coverage & limitations (important, honest)

We tried to scrape **all 49 Labstack groups' full history**. WhatsApp does not allow that in one shot — a critical constraint for planning:

- **Linked-device history sync is not a bulk export.** On link, WhatsApp releases **recent history (~2 months) for the most active chats only**, then throttles (our pull stalled at 22% of the intended transfer and stopped). This is a platform limit — no code change gets around it.
- **Result:** we got the **7 genuinely active groups** (which hold the overwhelming majority of volume). The other ~42 groups are low-traffic and delivered little/no recent history.
- **Path to full coverage:** **live capture.** The dry-run bot logs every new message across all 49 groups continuously; `scripts/log-to-csv.mjs` appends them to the same sheet. Over days, coverage becomes complete and current — a rolling dataset, not a one-time dump.

So: this dataset is the **best obtainable snapshot today** (all active groups, last ~2 months) and it **grows to full coverage automatically** as the bot runs.

---

## 4. What the traffic actually is

Of 12,427 messages, **1,857 (14.9%) are noise/system**. The remaining **10,570 are substantive**. Breakdown:

| Disposition | Count | Share | What it means |
|---|---:|---:|---|
| **REVIEW** | 4,028 | 38.1% | Ambiguous / freeform / bare-id → needs the LLM+context layer |
| **AUTO_ANSWER** | 3,109 | **29.4%** | Bot replies with live status — **no human** |
| **ROUTE_CONSOLE** | 1,942 | 18.4% | Bot opens an OpsFlow task — team actions it in the console |
| **NEEDS_LAB** | 1,309 | 12.4% | Serviceability / slot / price — needs lab data or the lab group |
| **HUMAN** | 182 | 1.7% | Escalation / tech outage — a person, fast |

**Top intents:** STATUS_CHECK 24.7%, NEW_BOOKING 8.0%, SLOT_CHECK 6.6%, RESCHEDULE 5.9%, REPORT_REQUEST 4.2%, SERVICEABILITY 3.9%, CREATE_ACTION 2.2%, FEASIBILITY_QUOTE 1.8%, ESCALATION 1.6%, plus a large OTHER (37.0%) the rules can't split without context.

**~29% of all messages carry an order/booking id** — the hook the bot needs to look up an answer.

### Per-group profile (they differ, and that matters)

| Group | Active days | Messages | Substantive | With id |
|---|---:|---:|---:|---:|
| Labstack<>Plum Ops | 36 | 4,663 | 3,910 | 1,143 |
| Labstack<>Orange Ops | 57 | 2,820 | 2,317 | 55 |
| Labstack<>Sugarfit Ops | 55 | 2,776 | 2,337 | 935 |
| Labstack<>Pharmeasy Home-admin | 57 | 1,069 | 950 | 472 |
| QUA x Labstack Operations | 18 | 555 | 518 | 126 |
| Labstack<>Good Health | 20 | 541 | 535 | 326 |
| LabStack<>Star | 1 | 3 | 3 | 0 |

Plum + Sugarfit are ~60% of volume and **id-rich** (bot-answerable); Orange is chatty but **id-poor** (only 55 ids in 2,820 msgs — mostly coordination the LLM/console handles). This tells us **where to pilot: Plum/Sugarfit first.**

---

## 5. Classification quality (honest findings)

The rules are precise where the language is formulaic, and weak where it's conversational:

- **Strong:** STATUS_CHECK (bare id + "update?"), CANCEL_REASON ("why was this cancelled?"), RESCHEDULE, "62619 Booking created". Safe to auto-act on.
- **Over-fires — must fix before sending:**
  - `NEW_BOOKING` (850) triggers on *any* partner message containing a date/time, including "requesting your time for tomorrow." Too broad.
  - Bare-id extraction scrapes **pincodes** and other 5–6 digit numbers as order ids.
- **Sender-side detection is data-dependent:** history sync carries partner-set display names, so LAB-vs-PARTNER (and thus OUTBOUND auto-posts) under-fires here vs. live capture — a reason the live rollout will read cleaner than the scrape.
- **The big bucket:** `OTHER` (3,913 / 37.0%) — test-parameter lists, freeform coordination, multi-turn threads. **This is exactly what the LLM+context layer is for.**

**Design consequence:** the bot must be **confidence-gated** — auto-reply only on HIGH-confidence intents with a resolved id; everything else routes, escalates, or asks. The dry-run already proved this is safe: mis-labeled messages produced **no reply** because nothing matched in the DB.

---

## 6. The automation thesis

| Measure | Share of substantive | Notes |
|---|---:|---|
| **Auto-answered by bot today** (rules + replica) | **29.4%** | status / report / cancel-reason |
| Auto-answered **with LLM+context** | **49.0%** | bare-ids + ~half of freeform collapse in |
| **No human reply needed** (auto-answer + routed) | **47.8%** | today, rules only |
| Realistic ceiling with LLM **+ lab data** | **~65–75%** | adds serviceability/slot/price (12.4%) |
| Genuinely needs a human | **~1.7%** | escalations + tech issues |

The gap between "29% today" and "65–75% eventually" is the **LLM+context layer** and **lab serviceability/price data** — both on the roadmap, neither required for launch.

---

## 7. Proposed product

### 7.1 Shape

A standalone Node service (scaffolded in `whatsapp-bot/`) that joins the partner groups as a **linked device** (Baileys), and for every message runs:

```
message → classify (rules) → [confidence gate] → resolve id on LabStack replica
        → decide action ─┬─ AUTO_REPLY      post status back into the group
                         ├─ CONSOLE_TASK    create an OpsFlow task (WhatsApp = data source #5)
                         ├─ LAB_ESCALATION  post to the lab/serviceability group
                         ├─ HUMAN_ESCALATION ping ops lead + flag
                         ├─ OUTBOUND_POST   auto-generate a LabStack-side status update
                         └─ LLM_REVIEW      hand to the LLM+context layer
```

The full decision table lives in `lib/playbook.mjs` and is mirrored on the **Playbook** tab of the Excel — one auditable source of truth.

### 7.2 The reply library (grounded in real DB states)

Replies map to states that actually exist in the data — `REPORT_DELIVERED` (84% of orders), `CANCELED` (16%), and the long tail (`SAMPLE_COLLECTED`, `PHLEBO_ASSIGNED`, `ORDER_SCHEDULED`…). Examples:

- *"#58651 — sample collected, processing at lab · appt 09 Jun, 06:20 am"*
- *"#58983 — report delivered ✅"*
- *"#54147 — cancelled: customer not reachable"* (from `cancelReason`)

Orders also carry `phleboName/phleboNumber`, `statusUpdatedAt`, and tracking numbers — enough to answer *"who's the phlebo?"* and *"where's my kit?"* without a human.

### 7.3 Route-to-console (the key architectural bet)

Anything actionable (RESCHEDULE, CANCEL_REQUEST, NEW_BOOKING, PATIENT_DATA, CREATE_ACTION → **18.4% of traffic**) becomes an **OpsFlow console task**, with the WhatsApp thread as **data source #5** in the existing multi-source engine. The team never leaves the console; the bot converts chat into structured work.

### 7.4 Lab-group escalation

NEEDS_LAB items (serviceability/slot/price, 12.4%) the bot can't self-serve get **posted to the relevant lab group** — closing the loop without a human relaying.

### 7.5 Guardrails

- **Confidence gate:** auto-reply only on HIGH confidence + resolved id. Else route/ask.
- **Per-group opt-in:** sending enabled group-by-group, not all-at-once.
- **Rate limits & human-like pacing** to protect the number.
- **Full audit log:** every decision written to `dry-run.log.jsonl` → the living sheet.
- **Kill switch:** `DRY_RUN=true` disables all sending instantly.

---

## 8. Rollout plan (ban-safe, staged)

| Phase | What | Sending? | Number |
|---|---|---|---|
| **0 — Dry run** *(live now)* | Observe all 49 groups, classify, log what it *would* do | **No** | Personal (read-only, low risk) |
| **1 — Auto-answer status** | Enable AUTO_REPLY for HIGH-confidence status/report on Plum/Sugarfit | Yes, gated | **Dedicated number** |
| **2 — Route + LLM** | Console tasks for actionable intents; LLM layer for REVIEW; lab-group escalation | Yes | Dedicated number |
| **3 — Proactive outbound** | Bot auto-posts booking-created/completed/cancelled updates from the event stream | Yes | Dedicated number |

**Hard gate between 0 and 1:** review the dry-run log; confirm answer accuracy; move to a **dedicated, disposable number** (never the personal one — a ban would take personal WhatsApp with it).

---

## 9. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **WhatsApp ban** (Baileys is unofficial; sending is what gets flagged) | High | Dedicated number; dry-run first; rate-limit + human pacing; per-group rollout; reading is low-risk |
| **Wrong auto-reply** (misclassification) | High | Confidence gate; auto-reply only with a resolved id; dry-run accuracy review; "no match → ask for id" fallback |
| **Patient data / DPDP** (messages contain names, DOB, phone, address) | High | Data stays on our infra; scoped to Labstack groups only; access controlled; minimise retention; legal review before Phase 1 |
| **Bare-id false positives** (pincodes as order ids) | Med | Validate id against DB before replying; tighten extraction |
| **Incomplete history** (WhatsApp sync cap) | Med | Live capture fills coverage over time; manual export for any priority group |

---

## 10. Success metrics

- **Deflection rate:** % of substantive messages resolved without a human typing (target: 48% by Phase 1, 65% by Phase 2).
- **Auto-answer accuracy:** % of auto-replies correct (target ≥ 98% before scaling; measured from the dry-run log).
- **Time-to-answer:** median seconds question→reply (bot near-instant vs. human minutes).
- **Human-touch volume:** absolute count of messages a human must handle (should fall sharply).
- **Ban incidents:** 0.

---

## 11. Roadmap

- **P0 (buildable today):** status/report/cancel-reason auto-answer; cancel/create → console task; escalation/tech → human. *Most of the value.*
- **P1 (LLM+context layer):** resolve bare-ids and freeform; reschedule/new-booking/patient-data extraction; proactive outbound posts.
- **P2 (lab data / write-APIs):** serviceability, slot, and price answers; console write-back.

---

## 12. Keeping the sheet alive

The live dry-run bot logs every observed message to `whatsapp-bot/dry-run.log.jsonl`. To grow the Excel:

```bash
node scripts/log-to-csv.mjs      # append new live rows → out/messages.csv
python3 scripts/build_xlsx.py    # rebuild the workbook
```

Then in Google Sheets: **File → Import → Upload** the `.xlsx` (replace), or append `messages.csv` onto the Messages tab. Corrections noted on the sheet feed classifier rules and the LLM prompt — the sheet is both the **report** and the **training loop**.

---

## 13. Open questions / decisions needed

1. **Dedicated number** for Phase 1 — procure a SIM/eSIM the business owns?
2. **DPDP/legal sign-off** on processing patient data in WhatsApp messages — who owns this?
3. **LLM choice & cost** for the context layer (Phase 1/2) — Claude via the existing stack?
4. **Pilot group** — start on Plum (highest volume) or Pharmeasy (cleanest, highest id-rate)?
5. **Console write-API** availability for route-to-console tasks — reuse OpsFlow's existing task creation?
6. **Full-coverage timeline** — how long do we let live-capture run to reach all 49 groups before locking the analysis?

---

### Appendix — deliverables in this drop

- `out/LabStack-WA-Bot-Actions.xlsx` — Summary / Playbook / Messages (12,427 rows) / How-to.
- `out/messages.csv` — the living per-message dataset · `out/history.jsonl` — the raw scrape.
- `lib/playbook.mjs` — the decision table (bot + sheet share it).
- `scripts/scrape-history.mjs`, `analyze-history.mjs`, `build_xlsx.py`, `log-to-csv.mjs` — the pipeline.
- `whatsapp-bot/` — the running dry-run service (scoped to 49 Labstack groups, sending disabled).
