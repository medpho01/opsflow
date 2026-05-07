/**
 * GET /api/order-statuses
 * Returns all valid LabstackOrderStatus values directly from the database
 * This endpoint provides a single source of truth for order statuses
 */

import { NextResponse } from "next/server";
import { getOrderStatusesFromDB } from "@/lib/db/enums";

export async function GET() {
  try {
    const statuses = await getOrderStatusesFromDB();

    return NextResponse.json(
      {
        statuses,
        count: statuses.length,
        description: "All valid Labstack order statuses for task rule triggers",
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Failed to fetch order statuses:", error);
    return NextResponse.json(
      { error: "Failed to fetch order statuses" },
      { status: 500 }
    );
  }
}
