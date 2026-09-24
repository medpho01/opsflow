/**
 * Source-scoped sampling for the rule simulator.
 *
 * The legacy simulator only ever sampled the Order table (fetchAllActiveOrders),
 * so an Appointments/PharmaOrder rule was dry-run against ORDER rows and every
 * row failed the allowedTypes/status gate for the wrong reason. This samples
 * recent rows from the *rule's own* data source and maps them into the same
 * RawOrder-shaped object `evaluateTrigger` consumes, so a non-Order rule
 * simulates against its real entities.
 *
 * It reads directly from the source's tableReference (validated at
 * registration) — the same approach as the data-source Preview endpoint —
 * rather than the source's queryTemplate, because templates vary (some have no
 * $1/$2 placeholders) and a "recent rows" sample is what a dry-run wants.
 */

import labstack from "@/lib/db/labstack";
import { Prisma, type PrismaClient } from "@prisma/client";
import { bareTableName, isValidTableReference } from "@/lib/validation/data-sources";
import type { RawOrder } from "@/lib/engine/labstack";

export interface SampleSourceConfig {
  tableReference: string;
  primaryKeyField: string;
  typeFieldName: string;
  statusFieldName: string;
  metadataFieldMapping: Record<string, string> | null;
}

/** First column name present on the table from a preference list, else null. */
function pick(cols: Set<string>, ...candidates: string[]): string | null {
  for (const c of candidates) if (cols.has(c)) return c;
  return null;
}

function asDate(v: unknown): Date {
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d;
  }
  // RawOrder types these as Date; an invalid/absent value becomes an
  // Invalid Date, which the evaluator's asValidDate() guards treat as "absent".
  return new Date(NaN);
}

/**
 * Fetch up to `cap` recent rows from the source table (bounded to rows touched
 * since `since` when the table has a recency column) and map each to a
 * RawOrder-shaped object. `metadata` is the raw row, so metadata-condition
 * checks resolve by column name.
 */
export async function fetchSourceSample(
  source: SampleSourceConfig,
  since: Date,
  cap: number,
  // Which labstack pool to read from. Defaults to the API pool (used by the
  // simulator, an API request). The poller passes labstackWorker so its bulk
  // reads don't contend with live API traffic.
  client: Pick<PrismaClient, "$queryRaw"> = labstack,
): Promise<RawOrder[]> {
  if (!isValidTableReference(source.tableReference)) return [];
  const bareTable = bareTableName(source.tableReference);

  const columns = await client.$queryRaw<Array<{ column_name: string }>>(Prisma.sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${bareTable}
  `);
  const cols = new Set(columns.map((c) => c.column_name));
  if (cols.size === 0) return [];

  // Recency column for ordering + the "touched since" bound (mirrors the Order
  // path's 7-day window). Fall back to the primary key when absent.
  const recencyCol = pick(cols, "updatedAt", "updated_at", "statusUpdatedAt", "createdAt", "created_at");
  const orderCol = recencyCol ?? (cols.has(source.primaryKeyField) ? source.primaryKeyField : null);

  const orderClause = orderCol
    ? Prisma.sql`ORDER BY ${Prisma.raw(`"${orderCol}"`)} DESC NULLS LAST`
    : Prisma.empty;

  const fetch = (bounded: boolean) => {
    const whereClause = bounded && recencyCol
      ? Prisma.sql`WHERE ${Prisma.raw(`"${recencyCol}"`)} >= ${since}`
      : Prisma.empty;
    return client.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT * FROM ${Prisma.raw(source.tableReference)}
      ${whereClause}
      ${orderClause}
      LIMIT ${cap}
    `);
  };

  // Prefer entities touched within the window (mirrors the Order path). If the
  // source is low-volume or its replica lags so the window is empty, fall back
  // to the most-recent rows regardless of age — a dry-run is useless with zero
  // rows, and the author still sees real entities to reason about.
  let rows = await fetch(true);
  if (rows.length === 0 && recencyCol) rows = await fetch(false);

  const map = source.metadataFieldMapping ?? {};
  const fromMap = (row: Record<string, unknown>, outName: string): unknown =>
    map[outName] != null ? row[map[outName]] : undefined;
  const idNum = (v: unknown): number => {
    const n = typeof v === "bigint" ? Number(v) : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const str = (v: unknown): string => (v == null ? "" : String(v));

  // Resolve patient names (+ each patient's home store, used below) via the
  // labstack User table when the source rows carry a user reference (Order
  // uses userId, Appointment uses user_id). The name is a join, not a
  // column, so a plain SELECT * can't surface it — this one extra bulk
  // lookup keeps task titles / the board from showing a blank patient.
  // Best-effort: absent column or User row leaves patientName empty.
  const userCol = pick(cols, "userId", "user_id");
  const userNameById = new Map<number, string>();
  const userStoreById = new Map<number, number>();
  if (userCol) {
    const uids = Array.from(
      new Set(rows.map((r) => Number(r[userCol])).filter((n) => Number.isFinite(n))),
    );
    if (uids.length > 0) {
      const users = await client.$queryRaw<Array<{ id: number; name: string | null; storeId: number | null }>>(
        Prisma.sql`SELECT id, name, "storeId" FROM public."User" WHERE id IN (${Prisma.join(uids)})`,
      );
      for (const u of users) {
        if (u.name) userNameById.set(Number(u.id), u.name);
        if (u.storeId != null) userStoreById.set(Number(u.id), Number(u.storeId));
      }
    }
  }

  // Store resolution — a direct storeId/store_id column covers Order-like
  // sources (and any future source shaped the same way) for free. Appointment
  // has no such column: its "creating store" only exists on the audit trail
  // (see /api/appointments/[id] for the single-row version of this same
  // lookup), so for that one table specifically we batch-fetch it the same
  // way patient names are batched above — never a per-row query, to avoid
  // repeating the wide-scan lock contention this poller has been burned by
  // before (see labstack.ts's MultiXact incident notes).
  const storeCol = pick(cols, "storeId", "store_id");
  const apptAuditStoreById = new Map<number, number>();
  if (!storeCol && bareTable === "Appointment") {
    const apptIds = Array.from(
      new Set(rows.map((r) => idNum(r[source.primaryKeyField])).filter((n) => n > 0)),
    );
    // AppointmentAuditEntry is optional across source snapshots (see the
    // matching guard in /api/appointments/[id]) — check with to_regclass
    // (never throws) before querying it, so a snapshot that lacks the table
    // degrades to "no audit store data" (falls through to the patient's home
    // store below) instead of throwing and skipping this entire poll source.
    if (apptIds.length > 0) {
      const [{ present }] = await client.$queryRaw<Array<{ present: boolean }>>(
        Prisma.sql`SELECT to_regclass('public."AppointmentAuditEntry"') IS NOT NULL AS present`,
      );
      if (present) {
        const entries = await client.$queryRaw<Array<{ appointment_id: number; store_id: number }>>(Prisma.sql`
          SELECT DISTINCT ON (appointment_id) appointment_id, store_id
          FROM public."AppointmentAuditEntry"
          WHERE appointment_id IN (${Prisma.join(apptIds)}) AND store_id IS NOT NULL
          ORDER BY appointment_id, (action = 'Created') DESC, "createdAt" ASC
        `);
        for (const e of entries) apptAuditStoreById.set(Number(e.appointment_id), Number(e.store_id));
      }
    }
  }

  const createdCol = pick(cols, "createdAt", "created_at");
  const updatedCol = pick(cols, "updatedAt", "updated_at", "statusUpdatedAt");
  const apptCol = (map["appointmentTime"] && cols.has(map["appointmentTime"]))
    ? map["appointmentTime"]
    : pick(cols, "appointmentTime", "appointmentDate", "scheduledAt", "slotTime");

  const entityType = bareTable.toUpperCase();

  return rows.map((row): RawOrder => {
    const rowId = idNum(row[source.primaryKeyField]);
    const rowUserId = userCol ? idNum(row[userCol]) : 0;
    // Precedence: a direct column on the row itself, then the Appointment
    // audit-trail lookup, then the patient's own home store — same fallback
    // order as the single-row appointment drawer's COALESCE.
    const resolvedStoreId = storeCol
      ? (row[storeCol] != null ? idNum(row[storeCol]) : null)
      : apptAuditStoreById.get(rowId) ?? userStoreById.get(rowUserId) ?? null;
    return {
      id: rowId,
      orderType: str(row[source.typeFieldName] ?? "UNKNOWN"),
      orderStatus: str(row[source.statusFieldName] ?? "UNKNOWN"),
      appointmentTime: apptCol ? asDate(row[apptCol]) : new Date(NaN),
      storeId: resolvedStoreId,
      labId: null,
      userId: rowUserId,
      createdAt: createdCol ? asDate(row[createdCol]) : new Date(NaN),
      updatedAt: updatedCol ? asDate(row[updatedCol]) : new Date(NaN),
      statusUpdatedAt: updatedCol ? asDate(row[updatedCol]) : new Date(NaN),
      internalNotes: str(row["internalNotes"]),
      notes: str(row["notes"]),
      phleboName: str(fromMap(row, "phleboName")),
      phleboNumber: str(fromMap(row, "phleboNumber")),
      patientName: str(
        fromMap(row, "patientName") ??
          row["patientName"] ??
          (userCol ? userNameById.get(Number(row[userCol])) : undefined),
      ),
      labName: (fromMap(row, "labName") ?? row["labName"] ?? null) as string | null,
      storeName: (fromMap(row, "storeName") ?? row["storeName"] ?? null) as string | null,
      // The evaluator reads metadata conditions by field name; expose the raw row.
      metadata: row,
      entityType,
    };
  });
}
