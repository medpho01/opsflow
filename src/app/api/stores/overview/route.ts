/**
 * GET /api/stores/overview
 *
 * Single-shot overview payload for the Store Overview page. Returns the
 * selected store's metadata + the five KPI counts (open / breached /
 * warning / unassigned / completed) in one round-trip.
 *
 * Replaces the prior board layout that issued five separate /api/tasks
 * requests per refresh — three for status counts, one to fetch up to 50
 * open tasks to compute "warning" and "unassigned" client-side, plus the
 * paginated task list. Two of those counts ("warning", "unassigned")
 * were silently capped at 50 because they came from a paginated read,
 * not a real SQL count.
 *
 * Query params:
 *   storeId — numeric store id, or omit for "all stores" (OPS_HEAD only).
 *
 * Auth:
 *   OPS_HEAD     — any store, or all
 *   STORE_ADMIN  — only stores in their assignments. Asking for a store
 *                  outside that set returns 403. "All stores" returns
 *                  the scoped set (their assigned stores only).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import labstack, { labstackOr } from "@/lib/db/labstack";
import { TaskStatus, UserRole } from "@prisma/client";

interface StoreRow {
  id: number;
  storeName: string;
  city: string | null;
}

const OPEN_STATUSES: TaskStatus[] = [
  TaskStatus.CREATED,
  TaskStatus.ASSIGNED,
  TaskStatus.IN_PROGRESS,
  TaskStatus.BLOCKED,
];

// Near-SLA early-warning thresholds. The outer 30-min window is the
// actionable horizon — long enough that an Ops Head can actually
// reassign/escalate. The inner 10-min subset is shown alongside as a
// "critical" call-out ("12 (3 critical)") so urgency isn't lost.
// Previously the only window was 10 min, which fired too late to act on.
const NEAR_SLA_WINDOW_MIN = 30;
const NEAR_SLA_CRITICAL_MIN = 10;

/**
 * Start-of-day in IST as a UTC instant. Used to scope "completed today"
 * etc. We anchor the operational day to IST (UTC+5:30) because that's the
 * timezone the team works in; UTC midnight is meaningless to them.
 */
function startOfTodayIST(): Date {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

function startOfWindow(range: string): Date {
  const startToday = startOfTodayIST();
  if (range === "7d") return new Date(startToday.getTime() - 6 * 24 * 60 * 60 * 1000);
  return startToday;
}

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.STORE_ADMIN) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const storeIdParam = request.nextUrl.searchParams.get("storeId");
  const storeId = storeIdParam ? parseInt(storeIdParam, 10) : null;
  if (storeIdParam && (storeId === null || isNaN(storeId))) {
    return NextResponse.json({ error: "Invalid storeId" }, { status: 400 });
  }

  // Range for "completed" — today by default (matches Command Center's
  // completed_today semantics). Accepts "today" | "7d". Prevents the
  // previous bug where Completed showed a lifetime cumulative count that
  // never moved day-to-day.
  const rangeParam = request.nextUrl.searchParams.get("range") ?? "today";
  const range = rangeParam === "7d" ? "7d" : "today";
  const rangeStart = startOfWindow(range);

  // Resolve the effective store-id filter respecting role-based scoping.
  // - OPS_HEAD with explicit storeId  → that one store
  // - OPS_HEAD with no storeId        → null (all stores)
  // - STORE_ADMIN with explicit       → must be in their assignments, else 403
  // - STORE_ADMIN with no storeId     → IN (their assignments)
  let storeFilter: { storeId?: number | { in: number[] } } = {};
  let scopedStoreIds: number[] | null = null; // null = head viewing all

  if (user.role === UserRole.STORE_ADMIN) {
    const member = await prisma.teamMember.findFirst({
      where: { userId: user.id },
      include: { storeAssignments: { select: { storeId: true } } },
    });
    scopedStoreIds = member?.storeAssignments.map((a) => a.storeId) ?? [];

    if (storeId !== null) {
      if (!scopedStoreIds.includes(storeId)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      storeFilter = { storeId };
    } else {
      // No specific store → restrict to their assignments. Empty list means
      // the admin has no store assigned; counts come back as zeros and
      // `store` is null. The board shows an explicit empty state.
      storeFilter = { storeId: { in: scopedStoreIds } };
    }
  } else {
    // OPS_HEAD
    if (storeId !== null) storeFilter = { storeId };
  }

  // Fetch store metadata (only when a specific store is selected).
  let store: StoreRow | null = null;
  if (storeId !== null) {
    try {
      // labstackOr swallows timeouts + rejections and trips the breaker
      // on repeated failure, so subsequent loads skip labstack entirely
      // while it's stuck. Falls back to empty array → store=null below.
      const rows = await labstackOr(
        labstack.$queryRawUnsafe<StoreRow[]>(
          `SELECT id, "storeName", city FROM public."Store" WHERE id = $1 LIMIT 1`,
          storeId
        ),
        [] as StoreRow[],
      );
      store = rows[0] ?? null;
    } catch {
      // labstack offline / column drift — leave `store` null; UI handles
      // the missing-name case so the board can still render the counts.
      store = null;
    }
  }

  const now = new Date();
  const warningCutoff = new Date(now.getTime() + NEAR_SLA_WINDOW_MIN * 60_000);
  const criticalCutoff = new Date(now.getTime() + NEAR_SLA_CRITICAL_MIN * 60_000);

  const baseWhere = {
    isArchived: false,
    ...storeFilter,
  };

  // Six real SQL counts in parallel. None read task rows, so there's no
  // "first 50 only" cap. Warning is split into a 30-min total and a
  // 10-min critical subset so the UI can render "12 (3 critical)" without
  // hiding either signal.
  const [open, breached, completed, warning, warningCritical, unassigned] = await Promise.all([
    prisma.task.count({ where: { ...baseWhere, status: { in: OPEN_STATUSES } } }),
    prisma.task.count({ where: { ...baseWhere, status: TaskStatus.BREACHED } }),
    // Completed is time-windowed (default: today IST). Previously this was
    // a lifetime cumulative — a store's KPI would grow forever and never
    // tell a Store Manager whether today was a good day.
    prisma.task.count({
      where: {
        ...baseWhere,
        status: TaskStatus.COMPLETED,
        completedAt: { gte: rangeStart },
      },
    }),
    prisma.task.count({
      where: {
        ...baseWhere,
        status: { in: OPEN_STATUSES },
        slaDeadline: { gt: now, lte: warningCutoff },
      },
    }),
    prisma.task.count({
      where: {
        ...baseWhere,
        status: { in: OPEN_STATUSES },
        slaDeadline: { gt: now, lte: criticalCutoff },
      },
    }),
    prisma.task.count({
      where: {
        ...baseWhere,
        status: TaskStatus.CREATED,
        assignedToId: null,
      },
    }),
  ]);

  // ── Per-store breakdown ─────────────────────────────────────────────
  // Only when no specific store is selected AND the user has more than
  // one store in scope. Lets a multi-store admin see side-by-side counts
  // without screenshot-diffing between selector clicks. One SQL query
  // (GROUP BY storeId) + one labstack bulk name lookup. For single-store
  // admins or specific-store views, perStore stays null (the dropdown is
  // the existing nav).
  interface PerStoreRow {
    store_id: number;
    open: bigint;
    breached: bigint;
    completed: bigint;
    warning: bigint;
    warning_critical: bigint;
    unassigned: bigint;
  }
  interface PerStoreOut {
    storeId: number;
    storeName: string | null;
    city: string | null;
    counts: {
      open: number; breached: number; completed: number;
      warning: number; warningCritical: number; unassigned: number;
    };
  }
  let perStore: PerStoreOut[] | null = null;
  const shouldGroupPerStore =
    storeId === null && (scopedStoreIds === null || scopedStoreIds.length > 1);
  if (shouldGroupPerStore) {
    // The scope filter is the same as baseWhere minus null check (we
    // explicitly exclude null storeIds — the per-store strip is about
    // stores, and tasks without one don't fit a row).
    const scopeFilter =
      scopedStoreIds !== null
        ? prisma.$queryRaw<PerStoreRow[]>`
            SELECT
              "storeId" AS store_id,
              COUNT(*) FILTER (WHERE status IN ('CREATED','ASSIGNED','IN_PROGRESS','BLOCKED'))                                    AS open,
              COUNT(*) FILTER (WHERE status = 'BREACHED')                                                                        AS breached,
              COUNT(*) FILTER (WHERE status = 'COMPLETED' AND "completedAt" >= ${rangeStart})                                   AS completed,
              COUNT(*) FILTER (WHERE status IN ('CREATED','ASSIGNED','IN_PROGRESS','BLOCKED')
                                AND "slaDeadline" > ${now} AND "slaDeadline" <= ${warningCutoff})                                AS warning,
              COUNT(*) FILTER (WHERE status IN ('CREATED','ASSIGNED','IN_PROGRESS','BLOCKED')
                                AND "slaDeadline" > ${now} AND "slaDeadline" <= ${criticalCutoff})                               AS warning_critical,
              COUNT(*) FILTER (WHERE status = 'CREATED' AND "assignedToId" IS NULL)                                              AS unassigned
            FROM taskos.tasks
            WHERE "isArchived" = false
              AND "storeId" IS NOT NULL
              AND "storeId" = ANY(${scopedStoreIds}::int[])
            GROUP BY "storeId"
            ORDER BY breached DESC, open DESC
          `
        : prisma.$queryRaw<PerStoreRow[]>`
            SELECT
              "storeId" AS store_id,
              COUNT(*) FILTER (WHERE status IN ('CREATED','ASSIGNED','IN_PROGRESS','BLOCKED'))                                    AS open,
              COUNT(*) FILTER (WHERE status = 'BREACHED')                                                                        AS breached,
              COUNT(*) FILTER (WHERE status = 'COMPLETED' AND "completedAt" >= ${rangeStart})                                   AS completed,
              COUNT(*) FILTER (WHERE status IN ('CREATED','ASSIGNED','IN_PROGRESS','BLOCKED')
                                AND "slaDeadline" > ${now} AND "slaDeadline" <= ${warningCutoff})                                AS warning,
              COUNT(*) FILTER (WHERE status IN ('CREATED','ASSIGNED','IN_PROGRESS','BLOCKED')
                                AND "slaDeadline" > ${now} AND "slaDeadline" <= ${criticalCutoff})                               AS warning_critical,
              COUNT(*) FILTER (WHERE status = 'CREATED' AND "assignedToId" IS NULL)                                              AS unassigned
            FROM taskos.tasks
            WHERE "isArchived" = false
              AND "storeId" IS NOT NULL
            GROUP BY "storeId"
            ORDER BY breached DESC, open DESC
          `;
    const rows = await scopeFilter;

    // Bulk look up store names. If labstack is unreachable, fall back to
    // null name; UI shows "#{storeId}" instead of going blank.
    const ids = rows.map((r) => Number(r.store_id));
    let nameMap = new Map<number, { storeName: string; city: string | null }>();
    if (ids.length > 0) {
      try {
        const storeRows = await labstackOr(
          labstack.$queryRawUnsafe<StoreRow[]>(
            `SELECT id, "storeName", city FROM public."Store" WHERE id = ANY($1::int[])`,
            ids
          ),
          [] as StoreRow[],
        );
        nameMap = new Map(storeRows.map((s) => [s.id, { storeName: s.storeName, city: s.city }]));
      } catch {
        // leave nameMap empty
      }
    }

    perStore = rows.map((r) => {
      const sid = Number(r.store_id);
      const meta = nameMap.get(sid);
      return {
        storeId: sid,
        storeName: meta?.storeName ?? null,
        city: meta?.city ?? null,
        counts: {
          open: Number(r.open),
          breached: Number(r.breached),
          completed: Number(r.completed),
          warning: Number(r.warning),
          warningCritical: Number(r.warning_critical),
          unassigned: Number(r.unassigned),
        },
      };
    });
  }

  return NextResponse.json({
    store,
    scope: {
      storeId: storeId ?? null,
      // Surfaced so the UI can render an explicit "no stores assigned" empty
      // state for STORE_ADMINs who land here with zero assignments.
      storeIds: scopedStoreIds,
    },
    range: { window: range, rangeStart: rangeStart.toISOString() },
    counts: {
      open,
      breached,
      warning,                       // total within NEAR_SLA_WINDOW_MIN (30)
      warningCritical,               // subset within NEAR_SLA_CRITICAL_MIN (10)
      unassigned,
      completed,                     // within the range window (today by default)
    },
    perStore,                        // null when a specific store is selected or only one in scope
  });
}
