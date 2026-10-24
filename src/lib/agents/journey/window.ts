/**
 * The active window (FR-1.1): the orders that get a journey. Read from the
 * LabStack replica through the worker-side client, bounded on the indexed
 * appointmentTime column (see engine/labstack.ts for why that matters).
 *
 * Appointment from 7 days ago to 3 days ahead, plus any order not yet at a
 * terminal status with activity in the last 7 days. Kits get a longer window
 * because they travel by courier.
 */
import { labstackWorkerQuery } from "@/lib/db/labstack";
import type { OrderSnapshot } from "./policy";

const TERMINAL = ["CANCELED", "REPORT_DELIVERED"];

type Row = {
  id: number; orderType: string; orderStatus: string; appointmentTime: Date | null; storeId: number | null; labId: number | null;
  createdAt: Date; statusUpdatedAt: Date | null; phleboName: string; patientName: string | null; labName: string | null; storeName: string | null;
  labRef: string | null; mobile: string | null; area: string | null;
};

const SELECT = `
  SELECT o.id, o."orderType", o."orderStatus", o."appointmentTime", o."storeId", o."labId",
         o."createdAt", o."statusUpdatedAt", COALESCE(o."phleboName", '') AS "phleboName",
         u.name AS "patientName", l."labName" AS "labName", s."storeName" AS "storeName",
         NULLIF(o."labOrderId", '') AS "labRef",
         u.mobile AS mobile, COALESCE(NULLIF(p.locality, ''), NULLIF(p.city, ''), p.pincode::text) AS area
  FROM public."Order" o
  LEFT JOIN public."User" u ON u.id = o."userId"
  LEFT JOIN public."Profile" p ON p."profileUserId" = o."userId"
  LEFT JOIN public."Lab" l ON l.id = o."labId"
  LEFT JOIN public."Store" s ON s.id = o."storeId"`;

export type WindowOptions = { lookbackDays?: number; lookaheadDays?: number; kitLookbackDays?: number };

export async function fetchActiveWindow(opts: WindowOptions = {}): Promise<OrderSnapshot[]> {
  const lookback = opts.lookbackDays ?? 7;
  const lookahead = opts.lookaheadDays ?? 3;
  const kitLookback = opts.kitLookbackDays ?? 21;
  const rows = await labstackWorkerQuery<Row>(`${SELECT}
    WHERE (
      (o."appointmentTime" >= NOW() - ($1 || ' days')::interval AND o."appointmentTime" < NOW() + ($2 || ' days')::interval)
      OR (o."orderStatus"::text <> ALL($3::text[]) AND o."updatedAt" >= NOW() - ($1 || ' days')::interval)
      OR (o."orderType" = 'KIT_BASED' AND o."orderStatus"::text <> ALL($3::text[]) AND o."createdAt" >= NOW() - ($4 || ' days')::interval)
    )
    ORDER BY o."appointmentTime" ASC NULLS LAST`, [String(lookback), String(lookahead), TERMINAL, String(kitLookback)]);
  return rows.map(toSnapshot);
}

export async function fetchOrderSnapshot(orderId: number): Promise<OrderSnapshot | null> {
  const rows = await labstackWorkerQuery<Row>(`${SELECT} WHERE o.id = $1`, [orderId]);
  return rows[0] ? toSnapshot(rows[0]) : null;
}

export async function fetchOrderSnapshots(orderIds: number[]): Promise<Map<number, OrderSnapshot>> {
  if (orderIds.length === 0) return new Map();
  const rows = await labstackWorkerQuery<Row>(`${SELECT} WHERE o.id = ANY($1::int[])`, [orderIds]);
  return new Map(rows.map((r) => [r.id, toSnapshot(r)]));
}

export function toSnapshot(r: Row): OrderSnapshot {
  return {
    id: r.id, orderType: r.orderType, orderStatus: r.orderStatus, appointmentTime: r.appointmentTime ?? null,
    labId: r.labId, storeId: r.storeId, createdAt: r.createdAt, statusUpdatedAt: r.statusUpdatedAt ?? null,
    phleboName: r.phleboName ?? "", patientName: r.patientName ?? null, labName: r.labName ?? null, storeName: r.storeName ?? null,
    labRef: r.labRef?.trim() || null, mobile: r.mobile?.trim() || null, area: r.area?.trim() || null,
  };
}
