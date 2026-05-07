/**
 * GET /api/task-rules/valid-statuses
 * Returns list of valid Labstack order statuses for rule configuration UI
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getValidOrderStatuses, LabstackOrderStatus } from "@/types";
import { UserRole } from "@prisma/client";

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const statuses = getValidOrderStatuses().map(status => ({
    value: status,
    label: formatStatusLabel(status),
    description: getStatusDescription(status),
  }));

  return NextResponse.json({ statuses });
}

function formatStatusLabel(status: string): string {
  return status
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function getStatusDescription(status: string): string {
  const descriptions: Record<string, string> = {
    ORDER_SCHEDULED: "Order is scheduled, awaiting confirmation",
    PHLEBO_ASSIGNED: "Phlebotomist assigned to the order",
    SAMPLE_COLLECTED: "Sample has been collected",
    SAMPLE_DELIVERED: "Sample delivered to lab",
    SAMPLE_IN_TRANSIT: "Sample in transit to lab",
    REPORT_READY: "Lab report is ready",
    REPORT_DELIVERED: "Report delivered to patient",
    CANCELED: "Order canceled",
    PATIENT_MISSED: "Patient missed appointment",
  };
  return descriptions[status] || status;
}
