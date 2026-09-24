/**
 * Recording sweep — polls Exotel for the recording URL of calls that
 * completed without one on the status webhook.
 *
 * Exotel's webhook fires as soon as a call ends, but the recording itself
 * takes 45s to a few minutes to generate — so /api/exotel/callback usually
 * has no RecordingUrl yet. Runs as part of the same poller cycle as the SLA
 * and source-health watchers (see poller.ts), with exponential backoff per
 * call so a call that never gets a recording (very short, or a genuine
 * provider gap) doesn't get hammered on every cycle forever.
 */
import prisma from "@/lib/db/client";
import { CallStatus } from "@prisma/client";
import { fetchExotelCallDetails } from "@/lib/telephony/exotel";

// After this many misses we stop checking — recordingUrl stays null and the
// UI falls back to "no recording available".
const MAX_ATTEMPTS = 6;
// 1m, 2m, 4m, 8m, 16m, 32m — measured from the row's last update (the
// webhook write, or the previous sweep attempt).
const BASE_DELAY_MS = 60_000;

function dueForCheck(updatedAt: Date, attempts: number): boolean {
  const delay = BASE_DELAY_MS * 2 ** attempts;
  return Date.now() - updatedAt.getTime() >= delay;
}

export async function runCallRecordingSweep(): Promise<{ checked: number; resolved: number }> {
  const candidates = await prisma.callLog.findMany({
    where: {
      status: CallStatus.COMPLETED,
      recordingUrl: null,
      sid: { not: null },
      recordingCheckAttempts: { lt: MAX_ATTEMPTS },
    },
    take: 25,
    orderBy: { updatedAt: "asc" },
  });

  let checked = 0;
  let resolved = 0;
  for (const log of candidates) {
    if (!log.sid || !dueForCheck(log.updatedAt, log.recordingCheckAttempts)) continue;
    checked++;

    const details = await fetchExotelCallDetails(log.sid);
    if (details?.recordingUrl) {
      resolved++;
      await prisma.callLog.update({
        where: { id: log.id },
        data: {
          recordingUrl: details.recordingUrl,
          durationSec: details.durationSec ?? log.durationSec,
          recordingCheckAttempts: { increment: 1 },
        },
      });
    } else {
      await prisma.callLog.update({
        where: { id: log.id },
        data: { recordingCheckAttempts: { increment: 1 } },
      });
    }
  }

  if (checked > 0) {
    console.log(`[CallRecordingSweep] checked ${checked}, resolved ${resolved}`);
  }
  return { checked, resolved };
}
