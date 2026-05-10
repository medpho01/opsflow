/**
 * GET /api/analytics/cohorts
 *
 * Per-cohort agent performance, where a "cohort" is the IST calendar
 * month a user was added to OpsFlow (User.createdAt). Lets the head
 * answer "agents hired this month vs last month — are the new ones
 * keeping up?" without exporting CSV and pivoting in a spreadsheet.
 *
 * Each row: cohort_month, agent_count, completed, breached, slaPercent,
 * avgCompletionMinutes. Includes only OPS_AGENT + STORE_ADMIN —
 * OPS_HEADs aren't a cohort that gets compared here.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

interface CohortRow {
  cohort_month: string;
  agent_count: bigint;
  completed: bigint;
  sla_compliant: bigint;
  breached: bigint;
  avg_completion_minutes: number | null;
}

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rows = await prisma.$queryRaw<CohortRow[]>`
    SELECT
      to_char(
        date_trunc('month', u."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata'),
        'YYYY-MM'
      )                                                                                          AS cohort_month,
      COUNT(DISTINCT u.id)                                                                       AS agent_count,
      COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED')                                          AS completed,
      COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED' AND t."slaBreachedAt" IS NULL)            AS sla_compliant,
      COUNT(t.id) FILTER (WHERE t."slaBreachedAt" IS NOT NULL)                                   AS breached,
      AVG(EXTRACT(EPOCH FROM (t."completedAt" - t."assignedAt")) / 60.0)
        FILTER (WHERE t.status = 'COMPLETED'
                AND t."completedAt" IS NOT NULL AND t."assignedAt" IS NOT NULL)                  AS avg_completion_minutes
    FROM taskos.users u
    LEFT JOIN taskos.tasks t
      ON t."assignedToId" = u.id AND t."isArchived" = false
    WHERE u.role IN ('OPS_AGENT', 'STORE_ADMIN')
      AND u."isActive" = true
    GROUP BY 1
    ORDER BY 1 DESC
  `;

  const cohorts = rows.map((r) => {
    const completed = Number(r.completed);
    const slaCompliant = Number(r.sla_compliant);
    const slaPercent = completed > 0 ? Math.round((slaCompliant / completed) * 100) : 100;
    return {
      cohortMonth: r.cohort_month,
      agentCount: Number(r.agent_count),
      completed,
      breached: Number(r.breached),
      slaPercent,
      avgCompletionMinutes:
        r.avg_completion_minutes !== null ? Math.round(Number(r.avg_completion_minutes)) : null,
    };
  });

  return NextResponse.json({ cohorts });
}
