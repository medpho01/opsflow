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

const NEAR_SLA_WINDOW_MIN = 10;

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
      const rows = await prisma.$queryRawUnsafe<StoreRow[]>(
        `SELECT id, "storeName", city FROM public."Store" WHERE id = $1 LIMIT 1`,
        storeId
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

  const baseWhere = {
    isArchived: false,
    ...storeFilter,
  };

  // Five real SQL counts in parallel. None of these read task rows, so
  // there's no "first 50 only" cap (the prior client-side warning/
  // unassigned counts had this bug).
  const [open, breached, completed, warning, unassigned] = await Promise.all([
    prisma.task.count({ where: { ...baseWhere, status: { in: OPEN_STATUSES } } }),
    prisma.task.count({ where: { ...baseWhere, status: TaskStatus.BREACHED } }),
    prisma.task.count({ where: { ...baseWhere, status: TaskStatus.COMPLETED } }),
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
        status: TaskStatus.CREATED,
        assignedToId: null,
      },
    }),
  ]);

  return NextResponse.json({
    store,
    scope: {
      storeId: storeId ?? null,
      // Surfaced so the UI can render an explicit "no stores assigned" empty
      // state for STORE_ADMINs who land here with zero assignments.
      storeIds: scopedStoreIds,
    },
    counts: {
      open,
      breached,
      warning,
      unassigned,
      completed,
    },
  });
}
