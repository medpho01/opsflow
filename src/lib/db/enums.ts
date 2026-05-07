/**
 * Database enum utilities
 * Fetches enum values directly from the database
 */

import prisma from "./client";

/**
 * Get all OrderType enum values from the database
 */
export async function getOrderTypesFromDB(): Promise<string[]> {
  try {
    const result = await prisma.$queryRawUnsafe(
      `SELECT enumlabel FROM pg_enum WHERE enumtypid = 'public."OrderType"'::regtype ORDER BY enumsortorder`
    );

    return (result as Array<{ enumlabel: string }>)
      .map((row) => row.enumlabel)
      .sort();
  } catch (error) {
    console.error("Failed to fetch OrderType values from database:", error);
    throw error;
  }
}

/**
 * Get all OrderStatus enum values from the database
 */
export async function getOrderStatusesFromDB(): Promise<string[]> {
  try {
    const result = await prisma.$queryRawUnsafe(
      `SELECT enumlabel FROM pg_enum WHERE enumtypid = 'public."OrderStatus"'::regtype ORDER BY enumsortorder`
    );

    return (result as Array<{ enumlabel: string }>)
      .map((row) => row.enumlabel)
      .sort();
  } catch (error) {
    console.error("Failed to fetch OrderStatus values from database:", error);
    throw error;
  }
}
