/**
 * Read-only queries against the labstack public schema.
 * OpsFlow never writes to these tables directly — all writes go
 * through the LabStack API or are handled by ops agents in the
 * LabStack console.
 */
import prisma from "@/lib/db/client";
import { Prisma } from "@prisma/client";

// Raw query helper — reads from labstack's public schema
async function labstackQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return prisma.$queryRawUnsafe<T[]>(sql, ...params);
}

export interface RawOrder {
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
  internalNotes: string;
  notes: string;
  phleboName: string;
  phleboNumber: string;
  patientName: string;
  labName: string | null;
  storeName: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Fetch all active HOME_SAMPLE orders from labstack.
 * Joins User (patient name), Lab, and Store for task metadata.
 */
export async function fetchActiveHomeSampleOrders(): Promise<RawOrder[]> {
  return labstackQuery<RawOrder>(`
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
      COALESCE(o."internalNotes", '') AS "internalNotes",
      COALESCE(o.notes, '')           AS notes,
      COALESCE(o."phleboName", '')    AS "phleboName",
      COALESCE(o."phleboNumber", '')  AS "phleboNumber",
      u.name                          AS "patientName",
      l."labName"                     AS "labName",
      s."storeName"                   AS "storeName"
    FROM public."Order" o
    JOIN public."User" u ON u.id = o."userId"
    LEFT JOIN public."Lab" l ON l.id = o."labId"
    LEFT JOIN public."Store" s ON s.id = o."storeId"
    WHERE o."orderType" = 'HOME_SAMPLE'
      AND o."orderStatus" NOT IN ('CANCELED', 'REPORT_DELIVERED', 'PATIENT_MISSED')
    ORDER BY o."createdAt" DESC
  `);
}

/**
 * Fetch active orders of all types — used for order board and stats.
 */
export async function fetchAllActiveOrders(): Promise<RawOrder[]> {
  return labstackQuery<RawOrder>(`
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
      COALESCE(o."internalNotes", '') AS "internalNotes",
      COALESCE(o.notes, '')           AS notes,
      COALESCE(o."phleboName", '')    AS "phleboName",
      COALESCE(o."phleboNumber", '')  AS "phleboNumber",
      u.name                          AS "patientName",
      l."labName"                     AS "labName",
      s."storeName"                   AS "storeName"
    FROM public."Order" o
    JOIN public."User" u ON u.id = o."userId"
    LEFT JOIN public."Lab" l ON l.id = o."labId"
    LEFT JOIN public."Store" s ON s.id = o."storeId"
    WHERE o."orderStatus" NOT IN ('CANCELED', 'REPORT_DELIVERED', 'PATIENT_MISSED')
    ORDER BY o."appointmentTime" ASC
  `);
}

/**
 * Write a completion note back to labstack Order.internalNotes.
 * This is the only write OpsFlow makes to the labstack schema.
 */
export async function appendOrderNote(orderId: number, note: string): Promise<void> {
  const timestamp = new Date().toISOString();
  const entry = `[OpsFlow ${timestamp}] ${note}`;
  await prisma.$executeRawUnsafe(
    `UPDATE public."Order"
     SET "internalNotes" = COALESCE("internalNotes", '') || E'\n' || $1,
         "updatedAt"     = NOW()
     WHERE id = $2`,
    entry,
    orderId
  );
}
