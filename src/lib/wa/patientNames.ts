import { Prisma } from "@prisma/client";
import labstack, { labstackOr } from "@/lib/db/labstack";

/**
 * Resolve order/request ids → patient name from the LabStack replica.
 *   order  → "Order".userId → "User".name
 *   request → "Request".name
 * Batched, timeout-bounded, breaker-guarded. Returns a map keyed "o<id>" / "r<id>".
 */
export async function patientNames(orderIds: number[], requestIds: number[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const orders = [...new Set(orderIds.filter(Boolean))];
  const requests = [...new Set(requestIds.filter(Boolean))];

  if (orders.length) {
    const rows = await labstackOr(
      labstack.$queryRaw<Array<{ id: number; name: string | null }>>(
        Prisma.sql`SELECT o.id, u.name FROM public."Order" o JOIN public."User" u ON u.id = o."userId" WHERE o.id IN (${Prisma.join(orders)})`
      ),
      [] as Array<{ id: number; name: string | null }>, 4000, { breakerKey: "wa-order-names" }
    );
    for (const r of rows) if (r.name) map[`o${r.id}`] = r.name;
  }
  if (requests.length) {
    const rows = await labstackOr(
      labstack.$queryRaw<Array<{ id: number; name: string | null }>>(
        Prisma.sql`SELECT id, name FROM public."Request" WHERE id IN (${Prisma.join(requests)})`
      ),
      [] as Array<{ id: number; name: string | null }>, 4000, { breakerKey: "wa-req-names" }
    );
    for (const r of rows) if (r.name) map[`r${r.id}`] = r.name;
  }
  return map;
}

/** Convenience: patient name for a single ticket's order/request. */
export async function patientNameFor(orderId: number | null, requestId: number | null): Promise<string | null> {
  const m = await patientNames(orderId ? [orderId] : [], requestId ? [requestId] : []);
  return (orderId && m[`o${orderId}`]) || (requestId && m[`r${requestId}`]) || null;
}
