/**
 * GET /api/orders/:id — fetch a single order from labstack for the quick-view panel.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";

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

  const rows = await prisma.$queryRawUnsafe<RawOrderDetail[]>(`
    SELECT
      o.id,
      o."orderType",
      o."orderStatus",
      o."appointmentTime",
      o."storeId",
      o."labId",
      o."userId",
      o."createdAt",
      o."updatedAt",
      o."statusUpdatedAt",
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

  // Also fetch OpsFlow tasks for this order
  const tasks = await prisma.task.findMany({
    where: { entityType: "ORDER", entityId: orderId },
    include: {
      assignedTo: { select: { id: true, name: true } },
      taskType: { select: { label: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ order, tasks });
}
