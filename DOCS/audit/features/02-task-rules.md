# 2. Task Rules

> **What it is**: For each Data Source, define when a task fires (status + timing + metadata conditions), what title/priority/SLA, who can pick it up (skills), and what escalation chain catches breaches.
>
> **Primary user**: OPS_HEAD
>
> **Verdict**: 🟡 PM · 🟡 Architect · 🟡 QA — biggest leverage area is the missing rule simulator + clone

## Strengths

- Tabbed drawer (Source → Trigger → Basics → Assignment) with red/green dot per tab.
- Plain-English trigger summary at the bottom of the form.
- Loads order statuses dynamically from the source's enum column.
- Variable-insert chips for the title template (`{{patientName}}`, `{{orderId}}`, etc.).
- Per-rule activate toggle + 24h/total fire counters.
- Per-rule data source grouping in the list view.
- Built-in dedupe (`requiresNoPreviousTaskOfType`) defaulted ON.

## Product gaps (PM)

| Priority | Gap |
|---|---|
| **P0** | **No rule simulator.** Author has to deploy and wait for the next poll to know if their rule fires correctly. **Single biggest authoring-time problem in the product.** |
| **P0** | **No "clone rule" button.** Operating teams typically need 6-10 rules per source that are 80% identical. Each must be built from scratch. |
| **P1** | **Title-template variable list is hard-coded** (`patientName`, `orderId`, `storeName`, `labName`, `phleboName`). If the source doesn't have these fields, the variable renders literally — no validation, no warning. |
| **P1** | **Assignment Strategy dropdown shows 5 options** (default, round_robin, store_affinity, skill_based, least_loaded) **but only "least loaded" is implemented** in `pickAssignee`. Authors choosing "round_robin" silently get least-loaded. |
| **P1** | **Metadata-condition field-path is free-text**; no autocomplete from real order metadata. Typos silently no-op. |
| P2 | No rule-level notification template (WhatsApp/email body). |
| P2 | No rule versioning. Edit-in-place loses history. |
| P2 | Cannot reorder rules — order matters for dedupe-block-if-previous-open-task. |
| P2 | No rule-level metric (success rate, false-positive rate from cancelled tasks). |

## UX friction

- Source tab is mandatory but the user can click "Trigger" first; only an amber dot warns them. Trigger UI then shows blank statuses with a yellow banner — low-fidelity dead-end.
- No "save as draft" — clicking Cancel discards everything.
- Title-template chip insertion appends to end; no caret-aware insert.
- "Polling Interval (min)" appears on the rule but actual poll is governed by the data source. Users will assume the rule overrides the source — it doesn't (or if it does, the relationship isn't shown).
- Expanded rule card shows trigger conditions but no recent fires / sample matched orders.

## Architecture findings

- **`triggerCondition` is `Json` with no DB-level constraint.** Validation lives at evaluation time (`taskCreator.ts:530-536`) — bad rules silently never match instead of failing fast. Add zod parse at create/update.
- **`loadActiveRules` silently casts `(r as any).triggerType`** (`taskCreator.ts:611-637`) — TypeScript lie that masks any column drop.
- **Duplicate rule-evaluation logic** in `src/lib/task-creation/rule-matcher.ts` (used only by the disabled multi-source path) — second source-of-truth waiting to drift.
- **`MANUAL` rule pattern**: a magic-string sentinel rule is upserted at runtime by `tasks/route.ts:434` whenever a manual task is created. Magic-string FKs are fragile.
- ID type drift: `TaskRule.id` is `String @id @default(cuid())` while everywhere else IDs are autoincrement `Int`.

## Confirmed / suspected bugs (QA)

| Severity | Bug | File:line |
|---|---|---|
| 🔴 **P1** | **POST `/task-rules` skips `validateTriggerConditionStatuses`** that PATCH applies. Create accepts arbitrary status strings; Update rejects them. | `src/app/api/task-rules/route.ts:86-88` |
| 🟡 P2 | `MANUAL` rule's `dataSourceId` is whatever DS happens to be first in the table; an upsert with `update: {}` is a no-op so a deleted-and-recreated source leaves a stale FK on the rule | `src/app/api/tasks/route.ts:430-448` |
| 🟡 P2 | DELETE rule blocks if any tasks reference it, **including archived ones** — operators can't delete a rule whose tasks are all archived | `src/app/api/task-rules/[id]/route.ts:237` |
| 🟡 | `allowedTypes: r.allowedTypes as string[]` cast assumes JSONB shape — non-array PATCH stored, downstream `Array.isArray` returns false (rule never matches) | route.ts:130 |
| 🟡 | `slaMinutes` extremely large → Date overflow in `taskCreator.ts:564` | — |
| 🟡 | `metadataConditions` operator `>` numeric vs ISO string ambiguous (`Number("2025-01-01")` → NaN) | `taskCreator.ts:97` |
| 🟡 | `triggerCondition.statusIn = []` rejected on POST/PATCH but a rule already saved with empty array (legacy) just never triggers — no remediation | — |
| 🟡 | Rule audit log only fires through routes — direct DB updates skip audit | `lib/engine/ruleAudit.ts` |

## Future PM roadmap (ranked)

1. **Rule simulator** — "run this rule against the last 100 orders, show me which would fire". Highest leverage feature in the whole product.
2. **Clone rule** — duplicate button on each row. Saves 80% of authoring time.
3. **Rule template library** — "Confirm new booking", "Phlebo dispatch check", "Stale order follow-up", per source-type.
4. **Visual flow / state diagram** — render rules + status transitions as a graph so the head can see coverage gaps ("we have a rule for BOOKED but nothing for SAMPLE_COLLECTED → REPORT_DELIVERED").
5. **Metadata-field autocomplete** — pull keys from sample orders.
6. **Rule-level metric dashboard** — fires-per-day, false-positive rate (tasks cancelled), avg time-to-completion.
7. **Conditional title templating** — `{{appointmentTime|relative}}` or `{{patient.age > 60 ? "SENIOR " : ""}}`.
8. **Rule import/export as JSON** — easy backup, easy multi-environment promotion.

## Feedback / decisions

> Add notes below.

-

