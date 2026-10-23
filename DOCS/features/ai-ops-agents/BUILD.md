# OpsFlow Agents — what is built, how to run it, what waits on others

Status: 21 Oct 2026. Companion to DESIGN.md. All code under `src/lib/agents`, `src/worker`,
`src/portal-worker`, `src/app/api/agents`, `src/app/(app)/head/agents`, `src/app/provider/order`.

## Processes

| Process | Command | What it runs |
|---|---|---|
| Web app | `npm run dev` / `npm start` | Screens, APIs, the lab action page, webhooks. Enqueues jobs; runs no agent loop. |
| Worker | `npm run worker` | pg-boss in the app database: `agent.sweep` every minute, `journey.wake` per order (singleton per order), `dispatch.urgent` every minute, `dispatch.flush` at :00 and :30, `risk.batch` at 05:45 and 19:00, `tasks.verify` every 5 min, `store.pass` every minute, `brain.monitor` every 30 min 06–21, `brain.nightly` 21:30, `brain.review` Sunday 22:00. Seeds the baseline SOPs and task types on boot. |
| Portal worker | `npm run portal-worker` | The only process with `AGENT_VAULT_PRIVATE_KEY`. Playwright sessions per lab portal; `portal.read`, `portal.signin`, `portal.health` every 5 min. Needs a Chromium (`PLAYWRIGHT_CHROMIUM_PATH` or `npx playwright install chromium`). |

Schema: additive Prisma models (`agent_*` tables); applied with `prisma db push` as this repo does.
Tests: `npm test` (agents suites under `src/lib/agents/__tests__`); evals: `npm run agents:evals [seed]`.

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `SOURCE_DATABASE_URL` | OpsFlow DB (pg-boss uses its own `pgboss` schema in it); LabStack replica (read only). |
| `TIMEZONE` | Operating time zone (default Asia/Kolkata). |
| `ANTHROPIC_API_KEY`, `AGENT_MODEL_READER`, `AGENT_MODEL_CASEWORKER`, `AGENT_MODEL_BRAIN`, `AGENT_LLM=off` | Model calls. Without a key: readers use patterns, the case worker is off, the Brain's prose is deterministic. |
| `CONSOLE_API_BASE`, `CONSOLE_API_KEY` | The console write API (`/agent/v1`). Unset: every status write becomes a one-click task. |
| `AGENT_VAULT_PUBLIC_KEY` (web), `AGENT_VAULT_PRIVATE_KEY` (portal worker only) | The vault's RSA key pair, PEM (`\n` escaped is fine). Generate once; see `src/lib/agents/portal/vault.ts`. |
| `APP_BASE_URL`, `LABSTACK_CONFIRMATION_KEY` | The lab action page link (`/provider/order/<token>`) on every nudge to a manual lab. |
| `LABSTACK_CONSOLE_URL` | Console deep links on tasks. |
| `AGENT_CALLS=on`, `AGENT_CALLER_NUMBER`, `AGENT_DAILY_CALL_BUDGET` | Exotel calls to lab managers; otherwise the call rung is a task. |
| `AGENT_BRIEF_JIDS` | WhatsApp jids that get the morning brief. |
| `STORE_STATUS_API_KEYS` | `storeId:key,storeId:key` for the store status API. |
| `AGENT_BATCH_PER_SLOT_CAP`, `AGENT_BATCH_PER_DAY_CAP`, `PORTAL_MIN_GAP_MS`, `PORTAL_DAILY_READ_CAP`, `AGENT_AUDIT_SAMPLE` | Caps. |

## Deploying with Docker Compose

The repo already deploys as `docker compose up -d --build` (DOCKER.md). This adds two services:

```bash
# On the server, in the checkout:
git pull                                   # the three agents commits
$EDITOR .env                               # add the OpsFlow Agents block from .env.example
docker compose up -d --build app worker    # app (schema push happens in its entrypoint) + the agent worker
docker compose --profile portals up -d --build portal-worker   # later, once a vault key pair and portal logins exist
docker compose logs -f worker              # expect: "[Worker] started: sweep, wake, dispatch, risk, verify, store pass, brain"
```

What happens on that first boot, in order: the app's entrypoint runs `prisma db push` (adds the
`agent_*` tables and the `pgboss` schema is created by the worker), the worker seeds the baseline
SOPs and the agent task types, the first sweep opens a journey for every order in the active window.
**No message changes**: every desk is OFF, the legacy message rules keep sending as before.

The WhatsApp gateway overlay (`docker-compose.wa.yml`) is unchanged; the agents send through the same
gateway and the same number.

Rollback: `docker compose stop worker` stops every agent loop; the app and the legacy rules continue.

## Going live with the pilot

1. Deploy the schema (`prisma db push`), start the worker. Journeys open for every order in the active window within a minute. Everything is OFF until set.
2. Agents › Setup: check connections and the directory (every pilot lab needs its group; managers from Lab Config).
3. Setup step 5: seed and run the evals.
4. Setup step 6: "Put the pilot in shadow". From here the inbox and the lab board show what the agent would do; `agent_actions` records every would-do with `RECORDED`.
5. After 7 days, Desks and autonomy: switch a cell to LIVE. The legacy message rules step aside for that lab in the same pass. Defaults: asks act; store answers act-and-notify; status writes, store warnings and case-worker choices suggest (review items in the inbox).
6. Watch Brief and tracking: team messages per order must fall within 14 days or the desk goes back to shadow (a monitor finding; the rollback itself is a one-click demotion on Desks).

## Real now vs waiting on something outside this repo

| Capability | State |
|---|---|
| Journeys, checkpoints, clock resets, promises, ladder, risk, send windows, dispatcher, caps | Real; unit-tested. |
| Lab reply reading → facts → journey | Real (existing reader + bridge). |
| Store desk: classify, link, answer, chase, change-request tasks, alerts, warnings | Real; store groups must be `SUPPORT` with `storeId` set in Connections. |
| Tasks with evidence, verify loop, reopen | Real. |
| Status writes | Through the console API when `CONSOLE_API_BASE/KEY` exist; **until then a one-click task** with the exact status and note. The API contract is in DESIGN.md §10. |
| Lab action page (accept, phlebo started, collected with photo, handed to lab, report shared, patient unreachable) | Real; needs `APP_BASE_URL` and the confirmation key. Photos kept under `AGENT_PROOF_DIR`. |
| Portal reads | Real framework (vault, sessions, health, reads → facts). **Each portal's selectors must be confirmed on the real portal** at setup (Controls › Portals, adapter preset + login URL); OTP logins fall back to a sign-in task. |
| Case worker | Real; needs a model key; starts in suggest. |
| Brain: monitor, nightly brief, audit, review with replay, in-bounds auto-apply | Real; the brief's prose and model-sourced proposals need a key, the numbers do not. |
| Exotel calls | Real when `AGENT_CALLS=on` and a caller number; else a task. |
| Store status API | Real; keys per store in env. |
| Evals | Real runner and gates; the seed set is small — grow it from history (`seed`) and inbox corrections. |
| Kit desk | Checkpoints and ladder only; courier tracking facts are not read (no courier source yet). |
| Escalation desk | Complaint → task with timeline and drafted reply (needs a key for the draft; the timeline is always built). |
| Email to patients, per-test TAT, agents uploading reports | Not built (later per the spec). |

## Where things are

```
src/lib/agents/
  journey/   policy.ts (checkpoints), step.ts (the agent), promises.ts, risk.ts, run.ts (wake), detector.ts (sweep), window.ts (replica)
  sop/       schema.ts, baseline.ts (v1 SOPs), load.ts
  guard/     guard.ts (menu, hard rules, kill switches, desks, autonomy, idempotency)
  executors/ dispatcher.ts, tasks.ts, verify.ts, consoleWriter.ts, storeReply.ts, calls.ts, actionPage.ts, index.ts
  store/     reader.ts (classify + link), pass.ts
  caseworker/ index.ts     brain/ monitor.ts nightly.ts audit.ts review.ts replay.ts     escalation/ drafter.ts
  portal/    vault.ts, adapters.ts     console/ client.ts     evals/ run.ts     llm.ts, directory.ts, autonomy.ts, queue.ts, api.ts
src/worker/index.ts        src/portal-worker/index.ts
src/app/api/agents/*       src/app/(app)/head/agents/*       src/components/head/Agent*.tsx
src/app/provider/order/[token]   src/app/api/provider/order/[token]
```
