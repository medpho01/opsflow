/**
 * GET /api/stores — list stores from labstack for assignment dropdowns + the
 * Store Overview store-selector.
 *
 * Audit P1 (feature 06): previously returned ALL labstack stores regardless
 * of role, so a STORE_ADMIN could see — and pick from — stores they had no
 * assignment to. Now scoped: STORE_ADMINs only see stores listed in their
 * team-member assignments. OPS_HEAD continues to see all (capped at 200).
 *
 * Also tightened the legacy `city` try/catch fallback. Previously any error
 * (timeout, connection drop, missing FK target) was caught and the response
 * silently returned `{stores: []}` — indistinguishable from "no stores
 * exist". Now an error returns 500 with the actual message; the UI can
 * tell apart "empty" from "broken".
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import labstack, { labstackOr } from "@/lib/db/labstack";
import { UserRole } from "@prisma/client";

interface RawStore {
  id: number;
  storeName: string;
  city: string | null;
}

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.STORE_ADMIN) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Resolve the store-id whitelist for STORE_ADMINs. Empty array → returns
  // an empty list (the admin has no assignments yet); the UI's empty state
  // calls this out explicitly rather than silently showing zero stats.
  let allowedStoreIds: number[] | null = null;
  if (user.role === UserRole.STORE_ADMIN) {
    const member = await prisma.teamMember.findFirst({
      where: { userId: user.id },
      include: { storeAssignments: { select: { storeId: true } } },
    });
    allowedStoreIds = member?.storeAssignments.map((a) => a.storeId) ?? [];
    if (allowedStoreIds.length === 0) {
      return NextResponse.json({ stores: [] });
    }
  }

  // labstackOr returns null on timeout / breaker-open / any rejection so
  // a slow or stuck labstack degrades to 503 instead of holding the
  // request open until the pool timeout (and dragging other requests
  // along with it).
  const stores = await labstackOr(
    allowedStoreIds === null
      ? labstack.$queryRawUnsafe<RawStore[]>(
          `SELECT id, "storeName", city FROM public."Store" ORDER BY "storeName" ASC LIMIT 200`
        )
      : labstack.$queryRawUnsafe<RawStore[]>(
          // pg expands an int[] param via ANY($1::int[])
          `SELECT id, "storeName", city FROM public."Store"
            WHERE id = ANY($1::int[]) ORDER BY "storeName" ASC LIMIT 200`,
          allowedStoreIds
        ),
    null,
  );

  if (stores === null) {
    return NextResponse.json(
      { error: "Labstack temporarily unavailable", code: "LABSTACK_TIMEOUT" },
      { status: 503 },
    );
  }
  return NextResponse.json({ stores });
}
