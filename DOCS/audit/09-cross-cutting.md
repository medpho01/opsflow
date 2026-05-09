# Cross-cutting Findings

Issues that span multiple features. The fixes here have outsized leverage because each one cleans up several feature files at once.

## 1. Three coexisting roster mechanisms

The most damaging architectural issue in the codebase. Three mechanisms, each with different bugs:

| Mechanism | Owner | Used by |
|---|---|---|
| `WeeklySchedule` (HH:MM strings) | day-of-week template | `pickAssignee`, `GET /api/team`, manual task assign |
| `RosterException` (DATE) | per-day override | same |
| `DailyRoster` (DATE+status) | older API+UI surface | `GET /api/dashboard:102`, `/api/roster/route.ts:40,93`, `/api/team/me/roster`, `lib/task-creation/roster-validator.ts:56` |

**Display ≠ Assignment ≠ Analytics.** Command Center reads legacy `dailyRosters` (showing whole team OFF — see P0 #1); engine assigns via `weekly_schedules`+`roster_exceptions`; Analytics has its **own** third re-implementation in `analytics/agents/route.ts:32-89` referencing nonexistent columns.

**Fix**: pick `lib/roster/availability.ts:computeRosterStatus` as the single canonical source. Delete `analytics/agents` re-impl, `lib/task-creation/roster-validator.ts`, `dailyRosters` reads in dashboard. Drop the `daily_rosters` table itself.

## 2. STORE_ADMIN authorization scoping

The only role with row-level visibility limits — and consistently broken across 5+ endpoints:

| Endpoint | Issue |
|---|---|
| `GET /api/tasks` | `where.storeId = { in: ids }` overwritten by `?storeId=...` query param |
| `PATCH /api/tasks/[id]` | No scoping at all |
| `GET /api/tasks/archive` | No auth at all |
| `GET /api/team` | Open to all roles |
| `GET /api/dashboard` | Open to all roles |
| `GET /api/stores` | Returns ALL stores |

**Fix**: introduce a `scopeStoreIds(user)` helper that returns `null` (no scope) or `number[]` (must-include). Apply consistently.

## 3. Silent-failure / catch-and-return-null patterns

| Site | Failure swallowed |
|---|---|
| `pickAssignee.catch(() => null)` | Auto-assignment failures invisible |
| `appendOrderNote.catch(...)` | Labstack writeback errors invisible |
| `fetchAllActiveOrders().catch(() => 0)` | Labstack outage indistinguishable from "no orders" |
| `/api/stores` triple try/catch returning `{stores: []}` | DB errors look like empty result |
| Validate endpoint returns 200 on `ok: false` AND on actual errors | Caller can't distinguish |

**Fix**: return structured errors with correlation IDs; emit Sentry/log events; never `.catch(() => null)` without explicit observability.

## 4. Timezone correctness

The DB runs in IST (`Asia/Kolkata`); Node runs in UTC; labstack stores naive timestamps as IST that JS interprets as UTC; `correctISTTimestamp` subtracts 5.5h to compensate.

**Inventory ranked correct → broken:**

| Site | Verdict |
|---|---|
| `lib/roster/utils.ts:49-50` UTC date+day construction | ✓ correct |
| `lib/roster/availability.ts:84` `getUTCDay()` | ✓ correct |
| `lib/utils/timezone.ts` IST_OFFSET helpers | ✓ correct (band-aid) |
| `lib/engine/taskCreator.ts:29-36` `correctISTTimestamp` | ⚠ correct-but-fragile (assumes naive labstack) |
| `lib/engine/taskCreator.ts:293-299` `Date.UTC(local fields)` | ⚠ correct iff Node TZ = IST |
| `app/api/team/route.ts:71-75` same pattern | ⚠ correct iff Node TZ = IST |
| `app/api/tasks/route.ts:467-468` mixed | ⚠ same |
| `lib/roster/availability.ts:57` `now.toTimeString().slice(0,5)` | 🔴 **fragile** — local-TZ HH:MM |
| `app/api/dashboard/route.ts:68, 76, 105` `setHours(0,0,0,0)` | 🔴 **broken** outside IST-server + mutation bug |
| `app/api/analytics/agents/route.ts:14-29` `setHours` for ranges | 🔴 **broken** outside IST-server |
| `app/api/analytics/agents/route.ts:48` local `getDay()` | 🔴 **broken** |
| `lib/task-creation/roster-validator.ts:73` local `getDay()` | 🔴 **broken** |
| `lib/engine/taskCreator.ts:100` metadata-condition timestamp | 🔴 IST not corrected here, off by 5:30h |

**Long-term DB-level fix path:**
1. Migrate labstack columns to `TIMESTAMPTZ` with one-time `AT TIME ZONE 'Asia/Kolkata'` rewrite. After this, `correctISTTimestamp` becomes a no-op everywhere.
2. Set `DATABASE_URL` to include `?options=-c%20TimeZone%3DUTC` so connection's effective TZ is UTC universally.
3. Standardise on `getTodayUTC()`, `getDayOfWeekUTC()`, `getDayBoundsUTC()`, `getISTClockTime()` helpers in `lib/utils/timezone.ts`.
4. ESLint rule banning `setHours`, `getDay`, `toTimeString`.
5. **HH:MM comparisons** in `availability.ts:57` must compute IST clock-time explicitly via `Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit'}).format(now)` — not `toTimeString().slice(0,5)`.

**Practical halfway step**: keep labstack as-is, add a thin SQL view `public.v_orders_utc` returning `TIMESTAMPTZ` columns; read from the view. Moves the band-aid from JS to SQL where it belongs.

## 5. Migration drift & dead code

### Standalone `.sql` migrations Prisma ignores
Mix of 8 Prisma-style directories + 6 standalone `.sql` files in `prisma/migrations/`. **Prisma's migrate tool ignores standalone files**, so they have to be applied manually with `psql`. New environments will silently skip them.

```
prisma/migrations/
├── 20250101_initial/migration.sql           ← Prisma picks up
├── 20260507_add_polling_locks/migration.sql ← Prisma picks up
├── 20260509_add_skill_tag_label.sql         ← IGNORED ❌
├── 20260509_fix_round_robin_order_type.sql  ← IGNORED ❌
└── 20260509_refactor_datasource_rules.sql   ← IGNORED ❌
```

**Fix**: convert all standalone `.sql` to proper Prisma migration directories.

### Broken seed
`prisma/seed.ts` imports `OrderType` enum (line 16) which was **dropped** in `20260509_refactor_datasource_rules.sql`. Seed no longer compiles against a fresh-clone schema.

### Dead code shipping (~1,500 LOC)
| Item | Location |
|---|---|
| Disabled multi-source polling subsystem | `src/lib/polling/` (1,100 LOC) |
| Backup component files | `AllTasksBoard_backup.tsx`, `AllTasksBoard_v2.tsx` |
| Dead table | `task_rule_source_scopes` (0 rows, FK still wired) |
| Dead table (after refactor) | `team_member_order_types` (refactor migration didn't drop it) |
| Dead column | `RoundRobinState.orderType` (band-aid `DEFAULT ''` migration) |
| Two next configs | `next.config.js` AND `next.config.ts` with different content |

### Setup ergonomics
- No `.env.example`; **the live `.env` is committed with default `JWT_SECRET="taskos-jwt-secret-change-in-production"`**.
- No README beyond create-next-app boilerplate.
- IST timezone DB requirement undocumented; nothing fails fast on misconfiguration.
- `seed_user.ts` and `seed-camps-source.ts` exist as separate undocumented scripts not wired to `db:seed`.

## 6. Onboarding & artifacts

A first-time **OPS_HEAD** logs in to a Command Center showing 8 zeros, no rules, no team, no sources, no alerts. **No welcome modal, no checklist, no tooltips, no docs links, no sample data.** The natural setup order (Data Source → Skills → Team → Task Rules) is discoverable only by reading the sidebar top-to-bottom. The Task Rules drawer surfaces the Skills dependency only via an error message ("No skill tags defined — create them in Team") that points to a section that has no Skills UI. **Closed-loop dead-end.**

A first-time **OPS_AGENT** logs in to "No tasks here" with no explanation of how their queue gets filled, where to set roster status, what each task type means.

### Recommended onboarding artifacts (priority order)

1. **First-login welcome modal per role** — 3-step "what is OpsFlow / your next action".
2. **"Setup Progress" widget on Command Center** until complete: ☐ Register data source · ☐ Add skills · ☐ Add team · ☐ Create first rule · ☐ Test rule · ☐ Verify first task.
3. **Inline tooltips** on every empty state with "Why is this empty?" link.
4. **Driver.js / Intro.js guided tour**, re-runnable from a Help menu.
5. **Sample-data toggle in Settings** — "Populate demo orders for 24h to see the system fire".
6. **In-app docs drawer** — surface the existing 80+ markdown docs as searchable help.
7. **Per-role "first 5 minutes" video** embedded in the empty Command Center / My Tasks.

## 7. Standard seed data

Today's `prisma/seed.ts` seeds skills + 8 task types + 1 escalation chain + admin user + 8 HSC task rules — but **does NOT seed any DataSource**, and **doesn't compile** because of the dropped `OrderType` import.

### Recommended fresh-install seeds

| Layer | Recommendation |
|---|---|
| **Data Sources** (toggleable, inactive by default) | `appointments` (Home Sample), `centre_visits`, `injection_orders` — pre-configured for LabStack tables |
| **HSC rules** (~8) | Already exist, ensure linked to default DS |
| **CV rules** (~4) | New: walk-in confirmation, no-show follow-up, sample-pending escalation, report dispatch |
| **Injection rules** (~4) | New: stock-check before visit, prep-call 24h, post-injection observation, adverse-event escalation |
| **Skill tags** | Existing 5 + add `CENTRE_VISIT`, `INJECTION_CARE`, `LANGUAGE_HINDI/TAMIL/etc.`, `SENIOR_AGENT` |
| **Escalation chains** | Default per priority (URGENT → 0m head, HIGH → 15m, MEDIUM → 30m) |
| **Demo data** | 1 demo store, 1 demo OPS_AGENT, 1 demo STORE_ADMIN |
| **Sample-orders inject** | One-click "Inject 10 sample orders" button on Engine page |
| **Default roster template** | Mon–Sat 9–6 active, Sun off, applied to new agents |

Net: today the product takes ~2-3 hours of setup before the first task fires. With these seeds + an onboarding checklist, a fresh install would be live in under 15 minutes.

## Feedback / decisions

> Add notes below.

-

