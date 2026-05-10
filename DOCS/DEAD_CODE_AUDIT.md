# Dead Code & Unused-API Audit — TaskOs (2026-05-10)

Static review. Each finding individually verified by literal + template-literal grep across `src/`.

## Summary

| Category | Count |
|---|---|
| Unused API routes (zero callers) | 9 |
| Routes calling a non-existent endpoint | 1 (broken: `/api/escalation-chains`) |
| Unused React components | 4 |
| Unused lib files | 3 (~803 LOC) |
| Multi-source polling stack — disabled in instrumentation, partially live via 2 routes | ~8 files (~2,140 LOC) |
| Page routes with no nav links (legacy admin UI) | 3 (`/admin/rules` tree) |
| Empty / accidentally-escaped directories | 7 |
| Unused npm dependencies | 3 (`axios`, `jsonwebtoken`, `pg`) |
| Unreferenced Prisma models in `src/` | 1 confirmed (`ChecklistTemplate`) |
| TODOs/FIXMEs in `src/` | 3 |
| Stale generated artifact | `src/generated/` (504 KB) |
| Conservative LOC deletable | ~1,300 |
| Aggressive LOC deletable (incl. polling + admin) | ~5,000 |

## 1. Unused API endpoints

| Route file | Notes |
|---|---|
| `src/app/api/auth/me/route.ts` | Zero references; auth uses session cookie via middleware |
| `src/app/api/tasks/[id]/unarchive/route.ts` | No client caller |
| `src/app/api/task-rules/[id]/audit-log/route.ts` | Only docs mention it |
| `src/app/api/data-sources/seed/route.ts` | No client caller |
| `src/app/api/debug/trigger-poller/route.ts` | Debug endpoint, no caller |
| `src/app/api/team/[id]/skills/route.ts` | TeamPanel reads skills embedded on `/api/team/[id]` |
| `src/app/api/tasks/metadata/route.ts` | No caller |
| `src/app/api/tasks/validate-assignment/route.ts` | No caller |
| `src/app/api/assignments/agents/[id]/route.ts` | No caller |
| `src/app/api/roster/daily/[date]/route.ts` | Roster fetched via `/api/roster` and `/api/team/me/roster` |

### Broken (not unused, but stale)
`src/components/task-rules/EscalationChainSelector.tsx:26` calls `/api/escalation-chains` — this route does not exist. Real route is `/api/escalations`. Either dead-component or runtime bug.

## 2. Unused React components

| File | LOC |
|---|---|
| `src/components/head/OrderTypeDisplay.tsx` | 71 |
| `src/components/head/PerformanceMetricsDisplay.tsx` | 127 |
| `src/components/head/OrderTypeAssignmentModal.tsx` | 182 |
| `src/components/task-rules/DataSourceSection.tsx` | 293 |

## 3. Unused lib files

| File | LOC |
|---|---|
| `src/lib/polling/polling-example.ts` | 335 |
| `src/lib/roster/utils.ts` | 215 |
| `src/lib/seed-camps-source.ts` | 253 |

### Multi-source polling stack — disabled but partially live

`src/instrumentation.ts` explicitly disables the multi-source polling engine. Only the legacy `lib/engine/poller.ts` is actually running. But two routes still import the disabled stack:
- `src/app/api/data-sources/[id]/manual-poll/route.ts` → `polling-scheduler.ts`
- `src/app/api/webhooks/[sourceId]/route.ts` → `webhook-handler.ts`, `database-source-handler.ts`

| File | LOC | Live? |
|---|---|---|
| `src/lib/polling/init-polling-engine.ts` | 138 | **Truly dead** |
| `src/lib/polling/polling-engine.ts` | 344 | Used by polling-scheduler |
| `src/lib/polling/polling-scheduler.ts` | 296 | Used by manual-poll route |
| `src/lib/polling/sync-service.ts` | 273 | Used internally |
| `src/lib/polling/handlers/database-source-handler.ts` | 279 | Used by webhook route |
| `src/lib/polling/handlers/webhook-handler.ts` | 300 | Used by webhook route |

If `manual-poll` and `webhooks/[sourceId]` are confirmed unused, the entire `src/lib/polling/` tree (~2,140 LOC) is dead. Worth a deliberate decision.

## 4. Unused npm dependencies

| Package | Notes |
|---|---|
| `axios` | App uses native `fetch` |
| `jsonwebtoken` (+ `@types/jsonwebtoken`) | `lib/auth/jwt.ts` uses `jose` |
| `pg` (+ `@types/pg`) | All DB access through Prisma |

## 5. Legacy `/admin/rules` page tree

- `src/app/admin/rules/page.tsx`, `list/page.tsx`, `[id]/page.tsx`

Sidebar only links to `/head/rules`. No internal link points to `/admin/rules`. ~10 components become deletable if confirmed legacy.

## 6. Empty / ghost directories

```
src/components/admin/
src/components/ui/
src/app/(app)/head/rules/[id]/
src/app/(app)/head/rules/new/
src/app/\(app\)/                # literal backslash-paren (escape leak)
src/app/\(app\)/head/
src/app/\(app\)/head/rules/
```

## 7. TODOs/FIXMEs in `src/`

| Location | Marker |
|---|---|
| `src/app/api/team/route.ts:124` | `// W1.5 — restore the actual hasException query…` |
| `src/app/api/data-sources/seed/route.ts:46` | `// TODO: Implement appointments seeding` (route unused) |
| `src/lib/engine/taskArchiver.ts:58` | `// TODO: If audit logging is implemented…` |

## 8. Repo-root cruft

- 79 `.md` files (Phase summaries, FINAL/COMPLETE reports). Most superseded by `DOCS/`
- 6 `.sql` files duplicated by `tests/fixtures/*.sql`
- 4 `.sh` validation scripts
- `inspect_metadata.js`, `validate-task-creation.ts` — ad-hoc scripts
- `opsflow-mockup.html` (1216 lines)
- `package-lock 2.json` — Finder-copy duplicate

## Suggested deletion script

```bash
cd /Users/maverick/Documents/TaskOs

# HIGH CONFIDENCE
git rm src/app/api/auth/me/route.ts
git rm src/app/api/tasks/[id]/unarchive/route.ts
git rm src/app/api/task-rules/[id]/audit-log/route.ts
git rm src/app/api/debug/trigger-poller/route.ts
git rm src/app/api/team/[id]/skills/route.ts
git rm src/app/api/tasks/metadata/route.ts
git rm src/app/api/tasks/validate-assignment/route.ts
git rm src/app/api/assignments/agents/[id]/route.ts
git rm src/app/api/roster/daily/[date]/route.ts
git rm src/app/api/data-sources/seed/route.ts
git rm src/lib/seed-camps-source.ts
git rm src/components/head/OrderTypeDisplay.tsx
git rm src/components/head/PerformanceMetricsDisplay.tsx
git rm src/components/head/OrderTypeAssignmentModal.tsx
git rm src/components/task-rules/DataSourceSection.tsx
git rm src/lib/polling/polling-example.ts
git rm src/lib/polling/init-polling-engine.ts
git rm src/lib/roster/utils.ts
rmdir src/components/admin src/components/ui
rm -rf 'src/app/\(app\)'
git rm -r src/generated
git rm "package-lock 2.json"
git rm inspect_metadata.js validate-task-creation.ts opsflow-mockup.html
npm uninstall axios jsonwebtoken @types/jsonwebtoken pg @types/pg

# JUDGEMENT CALL — confirm before running
# git rm -r src/app/admin/rules
# git rm -r src/lib/polling
```

## What was NOT flagged

- `layout.tsx`, `page.tsx`, `route.ts` (Next.js App Router files, no explicit imports needed)
- `src/instrumentation.ts` (auto-loaded)
- `PriorityBadge`, `StatusBadge`, `SlaCountdown` (verified live)
- `lib/performance.ts` (transitively dead through `PerformanceMetricsDisplay` but didn't deep-trace)
- `migrations/`, `prisma/migrations/`, `docker/`, `tests/fixtures/` (out of scope)
