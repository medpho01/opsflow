/**
 * GET /api/orders/:id — fetch a single order from labstack for the quick-view panel.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import labstack from "@/lib/db/labstack";

interface RawOrderDetail {
  id: number;
  orderType: string;
  orderStatus: string;
  appointmentTime: Date;
  storeId: number | null;
  labId: number | null;
  userId: number;
  createdAt: Date;
  updatedAt: Date;
  statusUpdatedAt: Date;
  internalNotes: string | null;
  notes: string | null;
  phleboName: string | null;
  phleboNumber: string | null;
  patientName: string;
  labName: string | null;
  storeName: string | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const orderId = parseInt(id, 10);
  if (isNaN(orderId)) return NextResponse.json({ error: "Invalid order ID" }, { status: 400 });

  // ── IST → UTC at the SQL boundary ──────────────────────────────────
  // Labstack stores timestamps as naive IST values (TIMESTAMP WITHOUT TIME
  // ZONE, session tz = Asia/Kolkata). Without an explicit cast, pg deserialises
  // them as if they were UTC, leaving every Date 5h30 ahead of reality — so
  // the drawer would show times 5:30 later than the task row (which goes
  // through the engine path that already applies this cast in labstack.ts).
  //
  // `col AT TIME ZONE 'Asia/Kolkata'` interprets the naive value as IST and
  // produces the correct UTC instant. Mirrors the engine's fetcher exactly.
  const rows = await labstack.$queryRawUnsafe<RawOrderDetail[]>(`
    SELECT
      o.id,
      o."orderType",
      o."orderStatus",
      (o."appointmentTime" AT TIME ZONE 'Asia/Kolkata') AS "appointmentTime",
      o."storeId",
      o."labId",
      o."userId",
      (o."createdAt"       AT TIME ZONE 'Asia/Kolkata') AS "createdAt",
      (o."updatedAt"       AT TIME ZONE 'Asia/Kolkata') AS "updatedAt",
      (o."statusUpdatedAt" AT TIME ZONE 'Asia/Kolkata') AS "statusUpdatedAt",
      o."internalNotes",
      o.notes,
      o."phleboName",
      o."phleboNumber",
      u.name               AS "patientName",
      l."labName"          AS "labName",
      s."storeName"        AS "storeName"
    FROM public."Order" o
    JOIN public."User" u ON u.id = o."userId"
    LEFT JOIN public."Lab" l ON l.id = o."labId"
    LEFT JOIN public."Store" s ON s.id = o."storeId"
    WHERE o.id = $1
    LIMIT 1
  `, orderId);

  if (!rows || rows.length === 0) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  const order = rows[0];

  // Fetch OpsFlow tasks for anything keyed by this numeric id. The click
  // handlers in the task boards don't disambiguate entityType — they pass
  // `task.entityId` straight through — so a row whose entityType is
  // APPOINTMENTS at the same numeric id as an ORDER will land in this same
  // drawer. Filtering strictly by entityType="ORDER" hid those tasks and
  // produced an empty "OPSFLOW TASKS (0)" list even when the user clicked
  // a task to open the panel. Showing the entityType in the row keeps the
  // UI honest about what each task is bound to.
  // Use explicit `select` (not `include`) — `tasks.sourceEntityId` is a
  // BIGINT column, and Prisma returns BIGINT as a JS BigInt, which
  // JSON.stringify refuses to serialise. The drawer doesn't need that
  // field; selecting only the columns the panel renders avoids the
  // 500 entirely without a custom replacer.
  const tasks = await prisma.task.findMany({
    where: { entityId: orderId },
    select: {
      id: true,
      title: true,
      entityType: true,
      status: true,
      priority: true,
      slaDeadline: true,
      createdAt: true,
      assignedTo: { select: { id: true, name: true } },
      taskType: { select: { label: true } },
    },
    orderBy: [
      // ORDER tasks first (the drawer's primary subject), then anything else.
      { entityType: "asc" },
      { createdAt: "desc" },
    ],
  });

  return NextResponse.json({ order, tasks });
}
