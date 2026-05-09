/**
 * Read-only queries against the labstack public schema.
 * OpsFlow never writes to these tables directly — all writes go
 * through the LabStack API or are handled by ops agents in the
 * LabStack console.
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
      -- W1.1: populate RawOrder.metadata. Previously the column was typed
      -- but never selected, so every metadataCondition rule silently never
      -- fired. to_jsonb(o.*) gives the entire row as JSONB so authors can
      -- reference any column (top-level or one level into the source JSONB
      -- columns like rawValues / standardizedValues) via dot-paths, matching
      -- what /api/data-sources/[id]/metadata-keys surfaces in the editor
      -- autocomplete.
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
      AND (o."updatedAt" >= $1 OR o."statusUpdatedAt" >= $1)
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
      -- W1.1: populate RawOrder.metadata. Previously the column was typed
      -- but never selected, so every metadataCondition rule silently never
      -- fired. to_jsonb(o.*) gives the entire row as JSONB so authors can
      -- reference any column (top-level or one level into the source JSONB
      -- columns like rawValues / standardizedValues) via dot-paths, matching
      -- what /api/data-sources/[id]/metadata-keys surfaces in the editor
      -- autocomplete.
      to_jsonb(o.*)                   AS metadata
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
 *
 * W1.4 — retries with exponential backoff. The previous implementation
 * was a single `$executeRawUnsafe` whose error path was caught upstream
 * (in `tasks/[id]/route.ts`) and only logged — so a transient labstack
 * blip silently dropped the note from the patient's order. Three attempts
 * (immediate, 200ms, 1s) handle most blips; persistent failures throw so
 * the caller can surface them rather than swallow.
 */
export interface AppendOrderNoteResult {
  ok: boolean;
  attempts: number;
  error?: string;
}

export async function appendOrderNote(
  orderId: number,
  note: string,
  opts: { maxAttempts?: number } = {}
): Promise<AppendOrderNoteResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const timestamp = new Date().toISOString();
  const entry = `[OpsFlow ${timestamp}] ${note}`;

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE public."Order"
         SET "internalNotes" = COALESCE("internalNotes", '') || E'\n' || $1,
             "updatedAt"     = NOW()
         WHERE id = $2`,
        entry,
        orderId
      );
      return { ok: true, attempts: attempt };
    } catch (err) {
      lastErr = err;
      // Backoff: 0ms, 200ms, 1000ms — short total budget, three chances.
      if (attempt < maxAttempts) {
        const backoff = attempt === 1 ? 200 : 1000;
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
  console.error(`[appendOrderNote] order=${orderId} failed after ${maxAttempts} attempts:`, lastErr);
  return { ok: false, attempts: maxAttempts, error: message };
}
