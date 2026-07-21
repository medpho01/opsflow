/**
 * GET /api/analytics/order-load?days=7|14|30
 *
 * Appointment-load analytics: how many order appointments land on each
 * (IST date, IST hour, orderType) cell, over a trailing window plus the
 * next 7 days. Powers the "Order Load" analytics tab — day-of-week ×
 * hour heatmap for shift planning ("when do appointments cluster"),
 * busiest-day ranking, and the upcoming-week load strip.
 *
 * Data lives in the labstack replica (public."Order".appointmentTime),
 * NOT in taskos — this measures order volume, independent of whether
 * any task rule fired. The query is bounded on the indexed
 * appointmentTime column and wrapped in labstackOr, so a sick replica
 * degrades to a clean 503 instead of a hang (June/July 2026 incident
 * discipline).
 *
 * Timestamps: labstack stores naive UTC. We shift by +05:30 in SQL so
 * date/hour grouping is in IST wall-clock — the timezone ops plans in.
 *
 * Scope note: appointments exist only on the labstack Order table, so
 * this endpoint ignores the analytics page's dataSource slicer; the
 * client groups by orderType instead (the meaningful axis within
 * orders). Revisit when a second appointment-bearing source lands.
 *
 * Auth: OPS_HEAD only (matches /api/analytics/* convention).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { labstackQuery, labstackOr } from "@/lib/db/labstack";
import { UserRole } from "@prisma/client";

interface LoadCell {
  istDate: string;   // YYYY-MM-DD (IST)
  istHour: number;   // 0-23 (IST)
  orderType: string;
  count: number;
}

interface RawRow {
  ist_date: string | Date;
  ist_hour: number;
  order_type: string;
  cnt: number;
}

const VALID_DAYS = new Set([7, 14, 30]);
const LOOKAHEAD_DAYS = 7;

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const days = parseInt(searchParams.get("days") ?? "14", 10);
  if (!VALID_DAYS.has(days)) {
    return NextResponse.json(
      { error: "Invalid days; must be 7, 14 or 30" },
      { status: 400 }
    );
  }

  // days is whitelist-validated above; LOOKAHEAD_DAYS is a constant.
  // Inlining into INTERVAL literals is injection-safe.
  const rows = await labstackOr<RawRow[] | null>(
    labstackQuery<RawRow>(
      `
      SELECT
        to_char((o."appointmentTime" + INTERVAL '330 minutes')::date, 'YYYY-MM-DD') AS ist_date,
        EXTRACT(HOUR FROM o."appointmentTime" + INTERVAL '330 minutes')::int        AS ist_hour,
        o."orderType"::text                                                          AS order_type,
        count(*)::int                                                                AS cnt
      FROM public."Order" o
      WHERE o."appointmentTime" >= NOW() - INTERVAL '${days} days'
        AND o."appointmentTime" <  NOW() + INTERVAL '${LOOKAHEAD_DAYS} days'
        AND o."orderStatus" NOT IN ('CANCELED')
      GROUP BY 1, 2, 3
      ORDER BY 1, 2
      `
    ),
    null,
    8_000,
    { breakerKey: "api" }
  );

  if (rows === null) {
    return NextResponse.json(
      { error: "Source database temporarily unavailable — try again in a moment", code: "LABSTACK_TIMEOUT" },
      { status: 503 }
    );
  }

  const cells: LoadCell[] = rows.map((r) => ({
    istDate:
      typeof r.ist_date === "string"
        ? r.ist_date
        : new Date(r.ist_date).toISOString().slice(0, 10),
    istHour: r.ist_hour,
    orderType: r.order_type,
    count: r.cnt,
  }));

  // Today's IST date string — the client uses it to split past (pattern
  // heatmap) from today/future (upcoming-load strip) without trusting
  // the browser clock.
  const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  return NextResponse.json({ days, lookaheadDays: LOOKAHEAD_DAYS, todayIST, cells });
}
