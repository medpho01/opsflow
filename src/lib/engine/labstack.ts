/**
 * Read-only queries against the labstack public schema.
 *
 * Hard rule: OpsFlow MUST NOT write to the labstack schema. Earlier
 * versions of this file exported an `appendOrderNote()` helper that
 * UPDATEd public."Order".internalNotes on task completion; that path has
 * been removed entirely. Labstack is the source of truth, OpsFlow
 * observes it, and any operational annotations live on the OpsFlow side
 * (taskos.task_history). If you need to record something about an order,
 * record it in taskos — never reach into labstack.
 *
 * W5 — IST → UTC at the SQL boundary.
 * Labstack stores naive timestamps in IST (TIMESTAMP WITHOUT TIME ZONE,
 * DB session tz = Asia/Kolkata). Prisma deserialises naive values as if
 * they were UTC, leaving every Date object 5h30 ahead of reality. The
 * historical fix (`correctISTTimestamp` in taskCreator.ts) subtracted the
 * offset in JS — a band-aid that had to be applied at every call site.
 *
 * The new fix: cast at SELECT time. `col AT TIME ZONE 'Asia/Kolkata'`
 * applied to a TIMESTAMP returns a TIMESTAMPTZ that *interprets the input
 * as IST* and produces the correct UTC instant. Prisma then reads it as a
 * JS Date pointing at the right wall-clock time. Engines downstream can
 * just use the value — no per-call shim, no chance of forgetting it.
 *
 * Caveat: `to_jsonb(o.*) AS metadata` still embeds the raw naive
 * timestamps, since to_jsonb sees the column types directly. Authors of
 * metadataCondition rules that compare timestamp fields should be aware
 * that those values are still IST-naive strings. This is intentional —
 * fixing the metadata blob would mean rewriting every key name a rule
 * author might reference. The top-level fields (createdAt, updatedAt,
 * statusUpdatedAt, appointmentTime) — the ones the engine itself
 * reasons about — are the ones we cast.
 */
import prisma from "@/lib/db/client";

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
  // Optional. Defaults to "ORDER" downstream. Set to "APPOINTMENTS",
  // "PHARMA_ORDER", etc. when the source is something other than
  // public.Order so the engine's dedup-by-entityType key is correct
  // across sources (otherwise an Appointment with id=42 would dedup
  // against an Order with id=42).
  entityType?: string;
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
      (o."appointmentTime" AT TIME ZONE 'Asia/Kolkata') AS "appointmentTime",
      o."storeId",
      o."labId",
      o."userId",
      (o."createdAt"       AT TIME ZONE 'Asia/Kolkata') AS "createdAt",
      (o."updatedAt"       AT TIME ZONE 'Asia/Kolkata') AS "updatedAt",
      (o."statusUpdatedAt" AT TIME ZONE 'Asia/Kolkata') AS "statusUpdatedAt",
      COALESCE(o."internalNotes", '') AS "internalNotes",
      COALESCE(o.notes, '')           AS notes,
      COALESCE(o."phleboName", '')    AS "phleboName",
      COALESCE(o."phleboNumber", '')  AS "phleboNumber",
      u.name                          AS "patientName",
      l."labName"                     AS "labName",
      s."storeName"                   AS "storeName",
      to_jsonb(o.*)                   AS metadata
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
 * Fetch active orders of all types — used for the engine and the order board.
 *
 * W2.2 — accepts a `since` parameter. When provided, the query returns only
 * orders touched (via updated_at OR statusUpdatedAt) since that timestamp.
 * The polling engine threads its checkpoint through this argument so we
 * don't re-fetch the entire active-order universe every cycle. When `since`
 * is null/undefined the query falls back to the previous "all active"
 * shape — used for backfill / dashboard counts.
 */
export async function fetchAllActiveOrders(since?: Date | null): Promise<RawOrder[]> {
  if (since instanceof Date && !isNaN(since.getTime())) {
    return labstackQuery<RawOrder>(
      `
    SELECT
      o.id,
      o."orderType",
      o."orderStatus",
      (o."appointmentTime" AT TIME ZONE 'Asia/Kolkata') AS "appointmentTime",
      o."storeId",
      o."labId",
      o."userId",
      (o."createdAt"        AT TIME ZONE 'Asia/Kolkata') AS "createdAt",
      (o."updatedAt"        AT TIME ZONE 'Asia/Kolkata') AS "updatedAt",
      (o."statusUpdatedAt"  AT TIME ZONE 'Asia/Kolkata') AS "statusUpdatedAt",
      COALESCE(o."internalNotes", '') AS "internalNotes",
      COALESCE(o.notes, '')           AS notes,
      COALESCE(o."phleboName", '')    AS "phleboName",
      COALESCE(o."phleboNumber", '')  AS "phleboNumber",
      u.name                          AS "patientName",
      l."labName"                     AS "labName",
      s."storeName"                   AS "storeName",
      to_jsonb(o.*)                   AS metadata
    FROM public."Order" o
    JOIN public."User" u ON u.id = o."userId"
    LEFT JOIN public."Lab" l ON l.id = o."labId"
    LEFT JOIN public."Store" s ON s.id = o."storeId"
    WHERE o."orderStatus" NOT IN ('CANCELED', 'REPORT_DELIVERED', 'PATIENT_MISSED')
      AND (
        (o."updatedAt"       AT TIME ZONE 'Asia/Kolkata') >= $1
        OR (o."statusUpdatedAt" AT TIME ZONE 'Asia/Kolkata') >= $1
      )
    ORDER BY o."appointmentTime" ASC
      `,
      [since]
    );
  }

  return labstackQuery<RawOrder>(`
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
      COALESCE(o."internalNotes", '') AS "internalNotes",
      COALESCE(o.notes, '')           AS notes,
      COALESCE(o."phleboName", '')    AS "phleboName",
      COALESCE(o."phleboNumber", '')  AS "phleboNumber",
      u.name                          AS "patientName",
      l."labName"                     AS "labName",
      s."storeName"                   AS "storeName",
      to_jsonb(o.*)                   AS metadata
    FROM public."Order" o
    JOIN public."User" u ON u.id = o."userId"
    LEFT JOIN public."Lab" l ON l.id = o."labId"
    LEFT JOIN public."Store" s ON s.id = o."storeId"
    WHERE o."orderStatus" NOT IN ('CANCELED', 'REPORT_DELIVERED', 'PATIENT_MISSED')
    ORDER BY o."appointmentTime" ASC
  `);
}

// (Removed) appendOrderNote — used to UPDATE public."Order".internalNotes
// on task completion. Labstack is now strictly read-only from OpsFlow's
// side; task completion is logged in taskos.task_history only. If you find
// yourself wanting to write to labstack, the answer is "don't" — record
// the equivalent fact on the OpsFlow task or task_history instead.
