/**
 * Roster Validator
 * Validates agent availability for task assignment
 * Checks: Daily roster status, weekly schedule, exceptions
 */

import prisma from "@/lib/db/client";

export interface AvailabilityResult {
  available: boolean;
  status: "ACTIVE" | "ON_FIELD" | "ON_LEAVE" | "SICK" | "OFF" | "WORKING_HOURS" | "BREAK_TIME";
  workingHours?: {
    startTime: string; // HH:MM
    endTime: string; // HH:MM
    breakStart?: string;
    breakEnd?: string;
  };
  reason: string;
  exception?: {
    type: string;
    note?: string;
  };
}

/**
 * Get agent availability for a specific date
 */
export async function getAgentAvailability(
  teamMemberId: number,
  date: Date
): Promise<AvailabilityResult> {
  try {
    // 1. Check if there's a roster exception for this date
    const exception = await prisma.rosterException.findUnique({
      where: {
        teamMemberId_date: {
          teamMemberId,
          date: new Date(date.toISOString().split("T")[0]),
        },
      },
    });

    if (exception) {
      return {
        available: false,
        status: exception.status as any,
        reason: `Agent has exception: ${exception.status}`,
        exception: {
          type: exception.status,
          note: exception.note || undefined,
        },
      };
    }

    // 2. Check daily roster (if exists)
    const dailyRoster = await prisma.dailyRoster.findUnique({
      where: {
        teamMemberId_date: {
          teamMemberId,
          date: new Date(date.toISOString().split("T")[0]),
        },
      },
    });

    if (dailyRoster) {
      if (dailyRoster.status !== "ACTIVE") {
        return {
          available: false,
          status: dailyRoster.status as any,
          reason: `Agent daily roster status: ${dailyRoster.status}`,
        };
      }
    }

    // 3. Check weekly schedule
    const dayOfWeek = date.getDay(); // 0=Sunday, 1=Monday, etc.
    const weeklySchedule = await prisma.weeklySchedule.findUnique({
      where: {
        teamMemberId_dayOfWeek: {
          teamMemberId,
          dayOfWeek,
        },
      },
    });

    if (!weeklySchedule || !weeklySchedule.isWorking) {
      return {
        available: false,
        status: "OFF",
        reason: `Agent not scheduled to work on ${getDayName(dayOfWeek)}`,
      };
    }

    // 4. Check if within working hours
    if (weeklySchedule.startTime && weeklySchedule.endTime) {
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

      // Check if in break time
      if (
        weeklySchedule.breakStart &&
        weeklySchedule.breakEnd &&
        isTimeBetween(currentTime, weeklySchedule.breakStart, weeklySchedule.breakEnd)
      ) {
        return {
          available: true,
          status: "BREAK_TIME",
          workingHours: {
            startTime: weeklySchedule.startTime,
            endTime: weeklySchedule.endTime,
            breakStart: weeklySchedule.breakStart,
            breakEnd: weeklySchedule.breakEnd,
          },
          reason: `Agent is on break (${weeklySchedule.breakStart}-${weeklySchedule.breakEnd})`,
        };
      }

      // Check if within working hours
      if (
        !isTimeBetween(
          currentTime,
          weeklySchedule.startTime,
          weeklySchedule.endTime
        )
      ) {
        return {
          available: true, // Still "available" but not in working hours now
          status: "WORKING_HOURS",
          workingHours: {
            startTime: weeklySchedule.startTime,
            endTime: weeklySchedule.endTime,
            breakStart: weeklySchedule.breakStart || undefined,
            breakEnd: weeklySchedule.breakEnd || undefined,
          },
          reason: `Agent working hours: ${weeklySchedule.startTime}-${weeklySchedule.endTime}`,
        };
      }
    }

    return {
      available: true,
      status: "ACTIVE",
      workingHours: weeklySchedule.startTime
        ? {
            startTime: weeklySchedule.startTime,
            endTime: weeklySchedule.endTime!,
            breakStart: weeklySchedule.breakStart || undefined,
            breakEnd: weeklySchedule.breakEnd || undefined,
          }
        : undefined,
      reason: "Agent is available",
    };
  } catch (error) {
    console.error("[RosterValidator] Error checking availability:", error);
    // Default to available if we can't check (roster not configured yet)
    return {
      available: true,
      status: "ACTIVE",
      reason: "Roster not configured (allowing assignment)",
    };
  }
}

/**
 * Check if multiple agents are available on a specific date
 */
export async function getAvailableAgents(
  teamMemberIds: number[],
  date: Date
): Promise<Array<{ teamMemberId: number; available: boolean; status: string }>> {
  const results = await Promise.all(
    teamMemberIds.map(async (id) => {
      const availability = await getAgentAvailability(id, date);
      return {
        teamMemberId: id,
        available: availability.available,
        status: availability.status,
      };
    })
  );

  return results;
}

/**
 * Check if time is between two times (in HH:MM format)
 */
function isTimeBetween(time: string, start: string, end: string): boolean {
  return time >= start && time <= end;
}

/**
 * Get day name from day of week number
 */
function getDayName(dayOfWeek: number): string {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return days[dayOfWeek] || "Unknown";
}

/**
 * Validate assignment is allowed based on roster
 */
export async function validateAssignmentByRoster(
  teamMemberId: number,
  taskDate?: Date
): Promise<{ valid: boolean; reason: string }> {
  const checkDate = taskDate || new Date();

  const availability = await getAgentAvailability(teamMemberId, checkDate);

  if (!availability.available) {
    return {
      valid: false,
      reason: `Cannot assign: ${availability.reason}`,
    };
  }

  return {
    valid: true,
    reason: availability.reason,
  };
}
