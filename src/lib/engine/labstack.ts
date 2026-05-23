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
 * ────────────────────────────────────────────────────────────────────
 * Timestamp handling (corrected May 2026).
 *
 * Labstack timestamp columns (appointmentTime, createdAt, updatedAt,
 * statusUpdatedAt) are TIMESTAMP WITHOUT TIME ZONE, but the values are
 * stored as **naive UTC** — i.e. the column value `2026-05-24 00:30:00`
 * literally represents the UTC instant `2026-05-24T00:30:00Z`, which
 * corresponds to 06:00 AM IST on 24 May. (Verified against the LabStack
 * console UI which shows IST wall-clock to users while the database
 * stores the UTC instant.)
 *
 * Because pg reads naive timestamps as UTC by default, plain SELECTs
 * produce a JS Date pointing at the correct UTC instant. No cast is
 * required, and `Date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })`
 * renders the expected IST wall-clock.
 *
 * Earlier versions of this file applied `col AT TIME ZONE 'Asia/Kolkata'`
 * under the (wrong) assumption that the values were naive IST. That cast
 * re-interpreted the already-UTC naive timestamp as IST and shifted every
 * read 5h30 backwards — visible bug: tasks with a 6 AM appointment were
 * stored as 12:30 AM the night before, and the My Work / Today view
 * mis-bucketed them. The cast is removed. Do not re-add it.
 *
 * If a future labstack table genuinely stores naive IST, cast THAT
 * column locally. Do not blanket-cast at the fetcher level.
 * ────────────────────────────────────────────────────────────────────
 */
import { labstackQuery } from "@/lib/db/labstack";

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
      s."storeName"                   AS "storeName",
      to_jsonb(o.*)                   AS metadata
    FROM public."Order" o
    JOIN public."User" u ON u.id = o."userId"
    LEFT JOIN public."Lab" l ON l.id = o."labId"
    LEFT JOIN public."Store" s ON s.id = o."storeId"
    WHERE o."orderStatus" NOT IN ('CANCELED', 'REPORT_DELIVERED', 'PATIENT_MISSED')
      AND (
        o."updatedAt"       >= $1
        OR o."statusUpdatedAt" >= $1
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
