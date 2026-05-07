/**
 * GET /api/task-rules/metadata-fields
 * Returns documentation of available metadata fields on orders
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const metadataFields = [
    {
      fieldPath: "reportETA",
      type: "timestamp",
      description: "Expected report delivery timestamp (ISO-8601)",
      example: "2026-05-02T18:00:00Z",
      operators: [">", ">=", "<", "<=", "exists"],
      commonUse: "HSC-R6: Trigger when report ETA is approaching",
    },
    {
      fieldPath: "phleboNotes",
      type: "string",
      description: "Internal notes from phlebotomist",
      example: "Patient not available, call later",
      operators: ["exists", "contains", "starts_with", "ends_with", "equals"],
      commonUse: "Escalate if specific keywords in notes",
    },
    {
      fieldPath: "patientContactAttempts",
      type: "number",
      description: "Number of attempts to reach patient",
      example: 3,
      operators: [">", ">=", "<", "<=", "equals"],
      commonUse: "Escalate if too many failed attempts",
    },
  ];

  return NextResponse.json({
    fields: metadataFields,
    operators: [
      { value: "exists", label: "Field exists" },
      { value: "not_exists", label: "Field doesn't exist" },
      { value: "equals", label: "Equals" },
      { value: "not_equals", label: "Not equals" },
      { value: "contains", label: "Contains (string)" },
      { value: "starts_with", label: "Starts with (string)" },
      { value: "ends_with", label: "Ends with (string)" },
      { value: ">", label: "Greater than" },
      { value: ">=", label: "Greater or equal" },
      { value: "<", label: "Less than" },
      { value: "<=", label: "Less or equal" },
    ],
  });
}
