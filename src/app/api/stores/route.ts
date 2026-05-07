/**
 * GET /api/stores — fetch all stores from labstack for assignment dropdowns.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

interface RawStore {
  id: number;
  storeName: string;
  city: string | null;
}

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Allow OPS_HEAD and STORE_ADMIN to view stores
  if (![UserRole.OPS_HEAD, UserRole.STORE_ADMIN].includes(user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const stores = await prisma.$queryRawUnsafe<RawStore[]>(
      `SELECT id, "storeName", city FROM public."Store" ORDER BY "storeName" ASC LIMIT 200`
    );
    return NextResponse.json({ stores });
  } catch {
    // Fallback if city column doesn't exist
    try {
      const stores = await prisma.$queryRawUnsafe<RawStore[]>(
        `SELECT id, "storeName", NULL AS city FROM public."Store" ORDER BY "storeName" ASC LIMIT 200`
      );
      return NextResponse.json({ stores });
    } catch {
      return NextResponse.json({ stores: [] });
    }
  }
}
