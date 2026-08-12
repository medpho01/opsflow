# OpsFlow WhatsApp Control Tower — Design Brainstorm

**Status:** brainstorm for review · **Date:** 2026-08-12
**Goal (your step 1):** every partner WhatsApp query lands in the OpsFlow console as a context-enriched ticket the team answers *from the console* — replying to the store group, pinging the lab group, or messaging any number — **without opening WhatsApp**. Kill the "watch 49 groups" problem first; automate later.

---

## 1. Why this is the right first step

- **Solves the real pain now** (tracking N groups) without betting on classifier accuracy.
- **Human-in-the-loop from day one** → safe. The auto-answer we measured (~29%) layers on *later*, once the team trusts the context.
- **Reuses OpsFlow's existing muscle.** A WhatsApp query is just a new **task source**. The app already has: `Task` (SLA, assignment, snooze, history, escalation, multi-source fields), `EscalationChain`/`Alert`, `Store`, roster. We don't rebuild ticketing — we feed it.

---

## 2. Architecture — how the pieces talk

```
   WhatsApp  ──┐                                        ┌── LabStack replica (read-only)
               │                                        │   order/request context
        ┌──────▼───────┐   writes WaMessage   ┌─────────▼───────────┐
        │  WA Gateway  │ ───────────────────► │                     │
        │  (Baileys,   │                      │   Shared Postgres   │  ◄── OpsFlow (Next.js)
        │  launchd svc)│ ◄─────────────────── │   (taskos DB = bus) │      console UI +
        └──────────────┘   drains WaOutbound  └─────────────────────┘      enrichment logic
             the ONLY            queue (sends)
          thing touching WA
```

- **WA Gateway** = the Baileys service (already running under launchd). The *only* component that touches WhatsApp. It does two dumb, reliable things: **write every inbound message** to the DB, and **drain an outbound queue** to send.
- **Shared Postgres (taskos DB) is the integration bus.** No fragile direct HTTP between app and gateway.
  - **Inbound:** gateway inserts `WaMessage` rows.
  - **Outbound:** OpsFlow inserts `WaOutbound` rows (status `QUEUED`); the gateway picks them up, sends, and writes back `SENT`/`FAILED` + the WhatsApp message id.
- **Why a DB queue, not direct calls:** reliability = your "don't miss" requirement. The gateway can restart or be offline for a minute and **nothing is lost**; sends **retry**; everything is **audited**.

---

## 3. Data model (new tables, native to OpsFlow conventions)

**`WaGroup`** — the config (features **#1 + #2**)
| field | purpose |
|---|---|
| `jid`, `subject` | WhatsApp group id + name |
| `role` | `SUPPORT` (queries come in) · `PROVIDER` (lab/provider coordination — we send here) · `INTERNAL` · `IGNORE` |
| `storeId?` | link a SUPPORT group → the partner/store it represents |
| `labId?` | link a PROVIDER group → the lab |
| `autoAskIdOnMissing` | bool — auto-reply asking for an id when none is given |
| `sendEnabled` | per-group send guard (off until dedicated number) |
| `active` | listening on/off |

**`WaMessage`** — the transcript (every message, both directions)
`waMsgId` (unique → **idempotent**, no dupes on reconnect/history replay), `groupId`, `direction IN|OUT`, `fromMe`, `sender`, `text`, `mediaType`, `ts`, `replyToWaId`, `intent`, `orderIds[]`, `requestIds[]`, `raw`.

**`WaTicket`** — the unit of work (feature **#4**)
`groupId`, `storeId`, `status` (`NEW → OPEN → WAITING_INFO / WAITING_LAB → ANSWERED → RESOLVED`), `orderId?`, `requestId?`, `intent`, `contextSnapshot` (json: order status/appt/phlebo/lab at capture), `assignedToId?`, `slaDueAt`, `firstMessageId`, `lastActivityAt`, `resolvedAt`.

**`WaOutbound`** — the send queue (features **#4 + #5**)
`targetJid` (store group, provider group, or `<number>@s.whatsapp.net`), `text`, `status` (`QUEUED → SENDING → SENT / FAILED`), `ticketId?`, `createdById`, `attempts`, `error`, `sentWaMsgId`.

### Ticket entity: two options (a decision for you)
- **A — dedicated `WaTicket`** (recommended for Phase 1): purpose-built for conversations + two-way messaging; clean; doesn't disturb the task engine. Can *optionally spawn* a `Task` when a query needs real ops work (route-to-console).
- **B — reuse `Task`** (`source="whatsapp"`, `entityType="ORDER"`): inherits SLA/assignment/escalation/snooze for free, appears in the existing board — but overloads a model built around a single order entity, and WA needs its own conversation/outbound tables anyway.
> Recommendation: **A**, but reuse the *patterns* (and the `EscalationChain`/`Alert` tables) so SLA + escalation behave exactly like tasks.

---

## 4. The console UX — a "WhatsApp" section, 3-pane inbox

```
┌───────────────────────────┬─────────────────────────────────┬──────────────────────────┐
│ QUEUE                     │ CONVERSATION                    │ CONTEXT & ACTIONS         │
│ [Needs response ▾] 12     │  Labstack<>Plum Ops             │ Order #58651              │
│ filter: group/intent/SLA  │  ─────────────────────────────  │ Store: Plum (group)       │
│                           │  partner: any update on 58651?  │ Intent: STATUS_CHECK      │
│ ● Plum   #58651  4m  ⏰    │  partner: member escalating     │                           │
│   STATUS · unanswered     │  ▸ [triggering msg highlighted] │ ── Order context (DB) ──  │
│ ● Sugarfit #59012 11m     │                                 │ Status: SAMPLE_COLLECTED  │
│   RESCHEDULE              │  ┌───────────────────────────┐  │ Appt: 09 Jun 06:20        │
│ ● Orange  (no id) 2m ⚠    │  │ Reply… Send to:[Store▾]   │  │ Phlebo: Ramesh 98…        │
│   asked for id (auto)     │  │  [Store group][Lab group] │  │ Lab: Apollo Seshadripuram │
│ …                         │  │  [Other number]  [Send]   │  │ Report: not ready         │
│                           │  └───────────────────────────┘  │                           │
│ [Waiting on lab] 5        │                                 │ ── Suggested actions ──   │
│ [Resolved today] 37       │                                 │ ▸ Reply with status ↩     │
│                           │                                 │ ▸ Ask the lab (Apollo) →  │
│                           │                                 │ ▸ Quick: "this is done"   │
│                           │                                 │ ▸ Free text…              │
│                           │                                 │ Resolve · Wait-lab · Snooze│
└───────────────────────────┴─────────────────────────────────┴──────────────────────────┘
```

- **Left — Queue:** tickets bucketed by **Needs response / Waiting on lab / Waiting on info / Resolved**. Filter by group/store, intent, SLA. Unanswered **timers**, claim/assign. This is the "one place instead of 49 groups."
- **Center — Conversation:** the real WA thread with the triggering message highlighted. A compose box with a **Send-to toggle**: **Store group** (reply to the partner) · **Lab group** (the linked provider group) · **Other number** (feature #5).
- **Right — Context & actions:** Order/Request id, Store (which group), **Order Context from the DB** (status, appt, phlebo + number, lab, cancel reason, report), Lab. Then **suggested actions**, one-click and pre-filled but **editable before send**:
  - **Reply with order status** → composes the DB context into a message to the **store group** (using the team's *learned* phrasing).
  - **Ask the lab** → composes a message to the **linked provider group**.
  - **Quick replies** from the learned `ReplyLibrary` ("this is done", "booking created", "possible ₹___").
  - **Free text** → store / lab / any number.
  - **Status controls:** Resolve · Waiting on lab · Waiting on info · Snooze.

---

## 4b. Admin setup (self-service — nothing hardcoded)

Setup is admin/infrequent config, so it lives **in Settings — `Settings › Integrations › WhatsApp`**, *not* inside the Control Tower. The Control Tower stays a clean operational inbox; a **gear** in its top bar jumps to the settings page. The settings page holds:

- **WhatsApp connection.** Link the account by scanning a **QR rendered in the console** — no terminal. The gateway writes its state to a `WaGateway` singleton (`status` = CONNECTING/QR/CONNECTED/LOGGED_OUT, `qr`, `connectedNumber`, `lastSeenAt`); the Setup screen polls it, shows the live QR (auto-refreshing ~20s) when linking, and the connected number + last-seen when up. **Re-link** and **Unlink** write a `command` (RELINK/LOGOUT) the gateway consumes. Global **sending** and **auto-ask-ID** toggles live here too.
- **Group classification.** A table of every discovered group where the admin sets **Role** (`Customer` = SUPPORT · `Provider` · `Internal` · `Ignore`), **maps** a Customer group → store and a Provider group → lab, and toggles **Active / Send / Ask-ID** per group. Saving writes `WaGroup` rows. New groups the account joins appear here automatically to be classified.

This is features **#1 + #2** as an admin UI, plus QR onboarding — see the **Setup** tab in the mockup.

## 5. Feature #3 — context extraction & the missing-id auto-reply

On every inbound:
1. **Extract** order/request ids + **intent** (existing classifier).
2. **If ids present** → enrich from the replica (status, appt, phlebo, lab, report readiness, cancel reason) → snapshot onto the ticket + show live.
3. **If a substantive query but NO id** → **auto-reply to the group** (guarded, templated, **debounced** so we don't nag): *"Please share the order/booking ID and your query so we can act on it."* Per-group toggle (`autoAskIdOnMissing`). This is the **one safe auto-send** to start with — it's low-risk and it structures the inbound so the team can actually work it.

---

## 6. "Don't miss" guarantees (feature #4 reliability)

- **Persist inbound before any processing** → a message is never lost even if enrichment fails.
- **Idempotent on `waMsgId`** → no duplicates on reconnect/history replay.
- **SLA timer per ticket + escalation** (reuse `EscalationChain`/`Alert`) → stale tickets escalate.
- **Always-visible "Needs response" bucket + counts** → nothing sits silently.
- **Outbound queue with retries**; `FAILED` sends surface loudly.
- **Two-way sync:** if someone answers **directly in WhatsApp**, the gateway ingests it as an `OUT`/`fromMe` message → the ticket auto-updates (and can auto-close), so the console never shows a false "unanswered." The team won't switch 100% on day one — this keeps both worlds consistent.
- **Gateway health in the console:** connected? last message time? If the WA gateway drops, show a banner so the team knows the inbox is stale.

---

## 7. Risks & the decisions they force

| Risk / topic | Note |
|---|---|
| **WhatsApp ban** (sending is the risk) | Reading/inboxing can start **now on the current number** (read-only). **Sending must move to a dedicated number** first, with rate-limits + per-group `sendEnabled`. |
| **One ops number, many agents** | All console replies go out from one WA number → **sign messages** with the agent's name/initials so partners aren't confused. |
| **PII / DPDP** | Messages (names, DOB, phone, address) now live in the taskos DB + console → access control + retention policy + legal sign-off. |
| **Media** (prescriptions, reports) | Phase 1: show `[image]` + download link. Rich media later. |
| **Group → store/lab mapping** | Needs a config pass — the `WaGroup` screen (feature #1/#2). Some mapping is manual first. |

---

## 8. Phasing

- **Phase 1 (this step):** `WaGroup` config (support/provider); ingest **all** groups → inbox + tickets with **DB context**; **reply from console** to the originating group; **free-text** compose to store/lab/any number; **missing-id auto-reply**; SLA + "needs response." *Read now on the current number; enable send on a dedicated number.*
- **Phase 2:** **Ask-the-lab** flow via provider linkage; learned **quick-replies**; assignment/escalation polish; media.
- **Phase 3:** **auto-answer** the high-confidence status checks (~29%); **LLM** for the REVIEW bucket; auto **route-to-console** tasks.

---

## 9. Open decisions (need your call before build)

1. **Dedicated number now**, or start **read-only inbox on the current number** and add a number before send is switched on?
2. **`WaTicket` (own entity)** vs **reuse `Task`** — recommendation is own entity; your call.
3. **One shared ops number** for all agents (with signatures), or per-agent numbers later?
4. **Pilot group** — Plum (highest volume) first?
5. **Group→store/lab mapping** — do you already have this list, or do we build the config UI and fill it in as we go?
