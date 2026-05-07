/**
 * GET /api/order-types
 * Returns all available order types directly from the database
 * This endpoint provides a single source of truth for order types
 */

import { NextResponse } from "next/server";
import { getOrderTypesFromDB } from "@/lib/db/enums";

export async function GET() {
  try {
    const orderTypes = await getOrderTypesFromDB();

    return NextResponse.json(
      {
        orderTypes,
        count: orderTypes.length,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Failed to fetch order types:", error);
    return NextResponse.json(
      { error: "Failed to fetch order types" },
      { status: 500 }
    );
  }
}
