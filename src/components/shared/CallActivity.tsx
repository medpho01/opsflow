"use client";

import { useEffect, useState } from "react";
import { formatISTShort } from "@/lib/utils/timezone";

interface CallLogEntry {
  id: number;
  status: string;
  targetMobile: string;
  targetUserName: string | null;
  triggeredFrom: string | null;
  recordingUrl: string | null;
  durationSec: number | null;
  transcript: string | null;
  createdAt: string;
  user: { id: number; name: string } | null;
}

const STATUS_STYLES: Record<string, { label: string; cls: string }> = {
  INITIATED: { label: "Calling…", cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
  RINGING: { label: "Ringing", cls: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  ANSWERED: { label: "In progress", cls: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  COMPLETED: { label: "Completed", cls: "bg-green-500/15 text-green-400 border-green-500/30" },
  FAILED: { label: "Failed", cls: "bg-red-500/15 text-red-400 border-red-500/30" },
  BUSY: { label: "Busy", cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  NO_ANSWER: { label: "No answer", cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  CANCELED: { label: "Cancelled", cls: "bg-zinc-600/15 text-zinc-500 border-zinc-600/30" },
};

// triggeredFrom is a free-form tag set at call time (e.g. "appt-doctor",
// "order-phlebo") — used only to label who was on the other end.
function relationLabel(triggeredFrom: string | null): string {
  if (!triggeredFrom) return "";
  if (triggeredFrom.includes("doctor")) return "doctor";
  if (triggeredFrom.includes("patient")) return "patient";
  if (triggeredFrom.includes("phlebo")) return "phlebo";
  return "";
}

function formatDuration(sec: number | null): string | null {
  if (sec == null) return null;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function CallActivity({ taskId }: { taskId: number }) {
  const [calls, setCalls] = useState<CallLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [transcriptOpenId, setTranscriptOpenId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tasks/${taskId}/calls`)
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((data) => { if (!cancelled) setCalls(data.calls ?? []); })
      .catch(() => { if (!cancelled) setError("Couldn't load call history."); });
    return () => { cancelled = true; };
  }, [taskId]);

  if (error) return null; // non-critical — don't clutter the drawer over this
  if (calls === null) return null; // loading — appears once ready, no skeleton flash
  if (calls.length === 0) return null; // nothing placed yet — no empty state needed here

  return (
    <div>
      <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Call Activity</h3>
      <div className="border border-zinc-800 rounded-lg overflow-hidden divide-y divide-zinc-800">
        {calls.map((call) => {
          const status = STATUS_STYLES[call.status] ?? { label: call.status, cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" };
          const relation = relationLabel(call.triggeredFrom);
          const duration = formatDuration(call.durationSec);
          const isPlaying = playingId === call.id;
          return (
            <div key={call.id} className="px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm text-zinc-200">
                    {call.targetUserName || call.targetMobile}
                    {relation && <span className="text-zinc-500"> · {relation}</span>}
                  </div>
                  <div className="text-[11px] text-zinc-600 mt-0.5">
                    {formatISTShort(call.createdAt)}
                    {call.user?.name ? ` · by ${call.user.name}` : ""}
                  </div>
                </div>
                <span className={`shrink-0 inline-flex items-center rounded border text-[10px] px-1.5 py-0.5 font-medium ${status.cls}`}>
                  {status.label}
                </span>
              </div>
              {(call.recordingUrl || duration) && (
                <div className="flex items-center gap-3 mt-2">
                  {call.recordingUrl && (
                    <button
                      type="button"
                      onClick={() => setPlayingId(isPlaying ? null : call.id)}
                      className="inline-flex items-center gap-1.5 text-xs text-zinc-300 border border-zinc-700 rounded px-2 py-1 hover:border-zinc-600 transition-colors"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        {isPlaying
                          ? <path strokeLinecap="round" strokeLinejoin="round" d="M10 9v6m4-6v6M5 5h14v14H5z" />
                          : <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                        }
                        {!isPlaying && <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />}
                      </svg>
                      {isPlaying ? "Hide" : "Play recording"}
                    </button>
                  )}
                  {duration && (
                    <span className="text-xs text-zinc-600">{duration}</span>
                  )}
                </div>
              )}
              {isPlaying && call.recordingUrl && (
                <audio controls autoPlay src={call.recordingUrl} className="w-full mt-2 h-8" />
              )}
              {call.recordingUrl && (
                call.transcript ? (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => setTranscriptOpenId(transcriptOpenId === call.id ? null : call.id)}
                      className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                    >
                      {transcriptOpenId === call.id ? "Hide transcript" : "View transcript"}
                    </button>
                    {transcriptOpenId === call.id && (
                      <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap bg-zinc-800/60 rounded px-2.5 py-2 mt-1.5">
                        {call.transcript}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="text-[11px] text-zinc-600 mt-2">Transcribing…</div>
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
