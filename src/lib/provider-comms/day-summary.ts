/**
 * "How much work does this lab have today, and tomorrow?" — counted once.
 *
 * Two features ask that question: the provider board an Ops head reads
 * (app/api/provider-comms/daily-board) and the digest the provider itself
 * receives over WhatsApp (./daily-digest). They must never disagree. A board
 * saying 14 while the message says 11 is worse than either being wrong on its
 * own, because it destroys trust in both — so the counting lives here, in one
 * query, rather than being written twice.
 *
 * Counted in SQL rather than by pulling every order across the wire: a busy
 * lab has hundreds a day, and the board refreshes every minute.
 *
 * "Today" and "tomorrow" are in the operating timezone, never UTC. A day that
 * rolls over at 05:30 local would be wrong for exactly the people using it.
 */
import { labstackWorkerQuery } from "@/lib/db/labstack";
import { AWAITING_CONFIRMATION_STATUSES } from "@/lib/non-api-labs/source-check";
import { composePatientAddress, mapUrlFor, type OrderPackage } from "@/lib/non-api-labs/order-details";

/** Statuses that mean the order will never be fulfilled, or is already done. */
export const DEAD_STATUSES = ["CANCELED", "PATIENT_MISSED"];
// Real LabStack statuses only (the dummy schema also had PARTIAL_DELIVERED).
export const DONE_STATUSES = ["REPORT_DELIVERED"];

export const TIME_ZONE = () => process.env.TIMEZONE || "Asia/Kolkata";

export type DayCounts = {
  total: number;
  homeCollections: number;
  centreVisits: number;
  awaitingCollection: number;
  collected: number;
  reportPending: number;
  done: number;
  cancelled: number;
  /** Still PENDING/CREATED in LabStack — the lab has not confirmed it yet. */
  unconfirmed: number;
  firstAppointment: Date | null;
  nextAppointment: Date | null;
};

export type LabDays = { today: DayCounts; tomorrow: DayCounts };

type DayRow = DayCounts & { labId: number; day: string };

export const EMPTY_DAY: DayCounts = {
  total: 0, homeCollections: 0, centreVisits: 0, awaitingCollection: 0,
  collected: 0, reportPending: 0, done: 0, cancelled: 0, unconfirmed: 0,
  firstAppointment: null, nextAppointment: null,
};

/** `2026-09-17` in the operating timezone — the key both halves group on. */
export function localDayKey(at: Date, zone: string): string {
  return at.toLocaleDateString("en-CA", { timeZone: zone });
}

export function todayKey(zone: string): string {
  return localDayKey(new Date(), zone);
}

export function tomorrowKey(zone: string): string {
  return localDayKey(new Date(Date.now() + 86_400_000), zone);
}

/**
 * Today's and tomorrow's counts for each of `labIds`, keyed by lab id.
 *
 * Labs with no orders on either day are present in the map with two empty
 * days rather than missing from it, so callers never have to distinguish
 * "no orders" from "lab not found".
 */
export async function loadDaySummaries(labIds: number[], zone: string): Promise<Map<number, LabDays>> {
  const summaries = new Map<number, LabDays>(
    labIds.map((labId) => [labId, { today: { ...EMPTY_DAY }, tomorrow: { ...EMPTY_DAY } }]),
  );
  if (labIds.length === 0) return summaries;

  const rows = await labstackWorkerQuery<DayRow>(
    `
    WITH local AS (
      SELECT o.*,
             ("appointmentTime" AT TIME ZONE 'UTC' AT TIME ZONE $2)::date AS local_day
        FROM public."Order" o
       WHERE o."labId" = ANY($1::int[])
         AND o."appointmentTime" IS NOT NULL
    )
    SELECT "labId",
           local_day::text AS day,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE "orderType" = 'HOME_SAMPLE')::int  AS "homeCollections",
           COUNT(*) FILTER (WHERE "orderType" = 'CENTER_VISIT')::int AS "centreVisits",
           -- Not yet collected and still live: the work the provider owes us.
           COUNT(*) FILTER (
             WHERE "orderStatus" IN ('PENDING','CREATED','ORDER_SCHEDULED','RESCHEDULED','PHLEBO_ASSIGNED','KIT_DISPATCHED')
           )::int AS "awaitingCollection",
           COUNT(*) FILTER (WHERE "orderStatus" IN ('PATIENT_VISITED','SAMPLE_COLLECTED','SAMPLE_DELIVERED'))::int AS collected,
           -- Collected or processed but no report yet — the TAT clock is running.
           COUNT(*) FILTER (
             WHERE "orderStatus" IN ('PATIENT_VISITED','SAMPLE_COLLECTED','SAMPLE_DELIVERED','SAMPLE_PROCESSED')
           )::int AS "reportPending",
           -- ::text on the COLUMN, not just the parameter: orderStatus is a
           -- Postgres enum ("OrderStatus"), and enum = text has no operator.
           COUNT(*) FILTER (WHERE "orderStatus"::text = ANY($3::text[]))::int AS done,
           COUNT(*) FILTER (WHERE "orderStatus"::text = ANY($4::text[]))::int AS cancelled,
           COUNT(*) FILTER (WHERE "orderStatus"::text = ANY($5::text[]))::int AS unconfirmed,
           MIN("appointmentTime") AS "firstAppointment",
           MIN("appointmentTime") FILTER (WHERE "appointmentTime" > now()) AS "nextAppointment"
      FROM local
     WHERE local_day IN (
             (now() AT TIME ZONE $2)::date,
             (now() AT TIME ZONE $2)::date + 1
           )
     GROUP BY "labId", local_day
    `,
    [labIds, zone, DONE_STATUSES, DEAD_STATUSES, AWAITING_CONFIRMATION_STATUSES],
  );

  const today = todayKey(zone);
  for (const row of rows) {
    const entry = summaries.get(row.labId);
    if (!entry) continue;
    const counts: DayCounts = {
      total: row.total,
      homeCollections: row.homeCollections,
      centreVisits: row.centreVisits,
      awaitingCollection: row.awaitingCollection,
      collected: row.collected,
      reportPending: row.reportPending,
      done: row.done,
      cancelled: row.cancelled,
      unconfirmed: row.unconfirmed,
      firstAppointment: row.firstAppointment ? new Date(row.firstAppointment) : null,
      nextAppointment: row.nextAppointment ? new Date(row.nextAppointment) : null,
    };
    // The SQL already restricts to two days, so anything that is not today is
    // tomorrow — no second date comparison needed.
    if (row.day === today) entry.today = counts;
    else entry.tomorrow = counts;
  }

  return summaries;
}

export type ScheduledOrder = {
  orderId: number;
  /** The lab's OWN reference. What their staff search by, when it exists. */
  labOrderId: string | null;
  appointmentTime: Date;
  orderType: string;
  orderStatus: string;
  patientName: string | null;
  /** Short form — city, or the centre's name. */
  location: string | null;
  /** The patient's locality (else city), for a one-line list entry. */
  area: string | null;
  /** Package names, comma-separated. */
  tests: string | null;
  /** Every package on the order, with the individual tests inside it. */
  packages: OrderPackage[];
  /** Tests booked on the order directly rather than through a package. */
  directTests: string[];
  /** The patient's full street address, from their Profile. */
  fullAddress: string | null;
  /** Pin on the saved coordinates, else a search on the address. */
  mapUrl: string | null;
  /**
   * A short location: the patient's city + pincode (from their Profile) for a
   * home visit, the centre and its city for a centre visit. Composing them here
   * keeps every caller from re-deciding which fields to trust for which order
   * type. The full street address is in non-api-labs/order-details.
   */
  address: string | null;
};

/** City + pincode for a home visit; the centre and its city for a centre visit. */
function composeAddress(row: {
  orderType: string; city: string | null; pincode: string | null;
  storeName: string | null; storeCity: string | null; userCity: string | null;
}): string | null {
  const parts = row.orderType === "CENTER_VISIT"
    ? [row.storeName, row.storeCity ?? row.city]
    // The order's own city beats the patient record's: a collection can be
    // booked to an address the patient does not live at.
    : [row.city ?? row.userCity, row.pincode];
  const address = parts.filter(Boolean).join(row.orderType === "CENTER_VISIT" ? ", " : " ").trim();
  return address || null;
}

/**
 * The actual appointments on one local day, earliest first.
 *
 * Counts tell a provider how busy tomorrow is; this tells them what to staff.
 * `limit` is a hard stop rather than a page: a WhatsApp message has no second
 * page, so the caller renders "…and N more" from the count instead.
 */
export async function loadDaySchedule(
  labId: number,
  zone: string,
  dayOffset: 0 | 1,
  limit: number,
): Promise<ScheduledOrder[]> {
  const rows = await labstackWorkerQuery<{
    id: number; labOrderId: string | null; appointmentTime: Date; orderType: string; orderStatus: string;
    patientName: string | null; city: string | null; pincode: string | null;
    storeName: string | null; storeCity: string | null; userCity: string | null;
    area: string | null; tests: string | null;
    unitFloorBuilding: string | null; street: string | null; locality: string | null;
    latitude: number | null; longitude: number | null;
    packages: OrderPackage[] | null; directTests: string[] | null;
  }>(
    `
    SELECT o.id, o."labOrderId", o."appointmentTime",
           o."orderType"::text   AS "orderType",
           o."orderStatus"::text AS "orderStatus",
           u.name AS "patientName",
           -- The patient's address lives on their Profile (one per User), not
           -- on Order or User.
           p.city AS city, p.pincode::text AS pincode,
           NULL::text AS "userCity",
           NULLIF(btrim(COALESCE(NULLIF(btrim(p.locality), ''), p.city)), '') AS area,
           (SELECT string_agg(pk."packageName", ', ' ORDER BY pk."packageName")
              FROM public."_OrderToPackage" op
              JOIN public."Package" pk ON pk.id = op."B"
             WHERE op."A" = o.id) AS tests,
           p."unitFloorBuilding", p.address AS street, p.locality, p.latitude, p.longitude,
           -- Each package with the individual tests inside it: the test
           -- catalogue (Master) link first, the package's own sub-test list
           -- when the catalogue has none.
           (SELECT json_agg(json_build_object(
                     'name', pk."packageName",
                     'tests', COALESCE(
                       (SELECT array_agg(DISTINCT m.name ORDER BY m.name)
                          FROM public."_MasterToPackage" mp
                          JOIN public."Master" m ON m.id = mp."A"
                         WHERE mp."B" = pk.id),
                       pk."panelSubTests",
                       ARRAY[]::text[]))
                     ORDER BY pk."packageName")
              FROM public."_OrderToPackage" op
              JOIN public."Package" pk ON pk.id = op."B"
             WHERE op."A" = o.id) AS packages,
           -- Tests booked on their own, outside any package.
           (SELECT array_agg(m.name ORDER BY m.name)
              FROM public."_MasterToOrder" mo
              JOIN public."Master" m ON m.id = mo."A"
             WHERE mo."B" = o.id) AS "directTests",
           s."storeName", s.city AS "storeCity"
      FROM public."Order" o
      LEFT JOIN public."User"  u ON u.id = o."userId"
      LEFT JOIN public."Profile" p ON p."profileUserId" = o."userId"
      LEFT JOIN public."Store" s ON s.id = o."storeId"
     WHERE o."labId" = $1
       AND o."appointmentTime" IS NOT NULL
       AND ("appointmentTime" AT TIME ZONE 'UTC' AT TIME ZONE $2)::date
           = (now() AT TIME ZONE $2)::date + $3::int
       -- A cancelled slot is not something to staff for.
       AND o."orderStatus"::text <> ALL($4::text[])
     ORDER BY o."appointmentTime" ASC
     LIMIT $5
    `,
    [labId, zone, dayOffset, DEAD_STATUSES, limit],
  );

  return rows.map((row) => ({
    orderId: row.id,
    labOrderId: row.labOrderId,
    appointmentTime: new Date(row.appointmentTime),
    orderType: row.orderType,
    orderStatus: row.orderStatus,
    patientName: row.patientName,
    location: row.city || row.userCity || row.storeName || null,
    area: row.area,
    tests: row.tests,
    packages: row.packages ?? [],
    directTests: row.directTests ?? [],
    fullAddress: composePatientAddress({
      unitFloorBuilding: row.unitFloorBuilding, address: row.street,
      locality: row.locality, city: row.city, pincode: row.pincode,
    }),
    mapUrl: mapUrlFor(row.latitude, row.longitude, composePatientAddress({
      unitFloorBuilding: row.unitFloorBuilding, address: row.street,
      locality: row.locality, city: row.city, pincode: row.pincode,
    })),
    address: composeAddress(row),
  }));
}
