/**
 * Transcription sweep — sends a completed call's recording through the
 * self-hosted Whisper service (see whisper-service/) once a recording URL
 * exists. Exotel has no transcription of its own; this is the pipeline that
 * replaces it. Runs alongside the recording sweep in the same poller cycle.
 *
 * Transcription is CPU-bound and can take on the order of a minute per
 * call, so this only processes a small batch per cycle — enough for normal
 * call volume without risking a slow model run stalling the rest of the
 * poll cycle. WHISPER_SERVICE_URL is optional: if unset (or the service is
 * unreachable), this no-ops rather than failing the cycle.
 */
import prisma from "@/lib/db/client";
import { CallStatus } from "@prisma/client";

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 2;
const REQUEST_TIMEOUT_MS = 90_000;

export async function runTranscriptionSweep(): Promise<{ processed: number; succeeded: number }> {
  const whisperUrl = process.env.WHISPER_SERVICE_URL;
  if (!whisperUrl) return { processed: 0, succeeded: 0 };

  const candidates = await prisma.callLog.findMany({
    where: {
      status: CallStatus.COMPLETED,
      recordingUrl: { not: null },
      transcript: null,
      transcriptAttempts: { lt: MAX_ATTEMPTS },
    },
    take: BATCH_SIZE,
    orderBy: { updatedAt: "asc" },
  });

  let processed = 0;
  let succeeded = 0;
  for (const log of candidates) {
    processed++;
    try {
      const audioRes = await fetch(log.recordingUrl!);
      if (!audioRes.ok) throw new Error(`recording fetch failed: ${audioRes.status}`);
      const audioBuffer = await audioRes.arrayBuffer();

      const form = new FormData();
      form.append("file", new Blob([audioBuffer]), "call.audio");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(`${whisperUrl}/transcribe`, { method: "POST", body: form, signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!res.ok) throw new Error(`whisper service failed: ${res.status}`);

      const data = await res.json();
      const text = typeof data.text === "string" ? data.text.trim() : "";

      await prisma.callLog.update({
        where: { id: log.id },
        data: { transcript: text || null, transcriptAttempts: { increment: 1 } },
      });
      if (text) succeeded++;
    } catch (err) {
      console.error(`[TranscriptionSweep] call ${log.id} failed:`, err instanceof Error ? err.message : err);
      await prisma.callLog.update({
        where: { id: log.id },
        data: { transcriptAttempts: { increment: 1 } },
      }).catch(() => {});
    }
  }

  if (processed > 0) {
    console.log(`[TranscriptionSweep] processed ${processed}, succeeded ${succeeded}`);
  }
  return { processed, succeeded };
}
