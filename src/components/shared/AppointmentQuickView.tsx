"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import CallButton from "@/components/shared/CallButton";
import TaskActionCard, { type ActionableTask } from "@/components/shared/TaskActionCard";
import { formatISTTimestamp } from "@/lib/utils/timezone";
import { labstackConsoleUrl } from "@/lib/utils/labstackConsole";

// The Appointments-source analogue of OrderQuickView. Heads open this for an
// appointment task so the drawer shows appointment context (date/time, doctor +
// contact, meeting link) instead of order fields for an unrelated same-id order.

interface AppointmentDetail {
  id: number;
  appointmentType: string | null;
  appointmentStatus: string | null;
  appointmentDate: string | null;
  duration: number | null;
  referenceId: string | null;
  appointmentUrl: string | null;
  notes: string | null;
  internalNotes: string | null;
  orderId: number | null;
  patientName: string | null;
  patientMobile: string | null;
  doctorName: string | null;
  doctorMobile: string | null;
  storeName: string | null;
}

type ApptTask = ActionableTask;

interface AppointmentQuickViewProps {
  appointmentId: number;
  onClose: () => void;
  // See OrderQuickView's `variant` doc — same modal/inline split.
  variant?: "modal" | "inline";
}

const APPT_STATUS_COLOR: Record<string, string> = {
  PENDING: "text-amber-400",
  CREATED: "text-amber-400",
  CONFIRMED: "text-blue-400",
  RESCHEDULED: "text-purple-400",
  CHECKED_IN: "text-teal-400",
  COMPLETED: "text-emerald-400",
  DELAYED: "text-orange-400",
  CANCELED: "text-red-400",
};

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-[10px] text-zinc-600 w-28 shrink-0 pt-0.5">{label}</span>
      <span className="text-xs text-zinc-300 flex-1 break-words">{value ?? "—"}</span>
    </div>
  );
}

// Compact identity card — Patient / Doctor / Store, matching the reference
// design's three-card layout (stacked here since the docked panel is
// narrower than the mockup's).
function InfoCard({
  icon,
  label,
  name,
  sub,
  action,
}: {
  icon: React.ReactNode;
  label: string;
  name: React.ReactNode;
  sub?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="bg-zinc-800/60 border border-zinc-700 rounded-lg px-3 py-3">
      <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">
        <span className="w-3.5 h-3.5 text-zinc-500">{icon}</span>
        {label}
      </div>
      <div className="text-sm font-medium text-zinc-100 truncate">{name}</div>
      {sub && <div className="text-xs text-zinc-500 mt-0.5">{sub}</div>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}

const PERSON_ICON = (
  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
);
const STORE_ICON = (
  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 9.5L12 3l9 6.5V21a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1V9.5z" /></svg>
);

export default function AppointmentQuickView({ appointmentId, onClose, variant = "modal" }: AppointmentQuickViewProps) {
  const [appt, setAppt] = useState<AppointmentDetail | null>(null);
  const [tasks, setTasks] = useState<ApptTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/appointments/${appointmentId}`);
      if (!res.ok) {
        // Error responses aren't always JSON (a 500 can be an HTML page) —
        // parse defensively so we show a clean message, not a JSON-parse error.
        let msg = `Failed to load appointment (HTTP ${res.status})`;
        try { const d = await res.json(); if (d?.error) msg = d.error; } catch { /* non-JSON body */ }
        throw new Error(msg);
      }
      const data = await res.json();
      setAppt(data.appointment);
      setTasks(data.tasks ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load appointment");
    } finally {
      setLoading(false);
    }
  }, [appointmentId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* Backdrop — modal only; the inline variant docks in a caller-sized
          column with nothing behind it to dim. */}
      {variant === "modal" && (
        <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      )}

      {/* Panel — fixed slide-over for "modal", plain full-height block for
          "inline" (caller provides width/border/positioning). */}
      <div
        ref={panelRef}
        className={
          variant === "modal"
            ? "fixed right-0 top-0 h-full w-full max-w-md bg-zinc-900 border-l border-zinc-700 shadow-2xl z-50 flex flex-col"
            : "h-full w-full bg-zinc-900 flex flex-col"
        }
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 shrink-0">
          <div>
            <div className="flex items-center gap-2">
              {/* The appointment # itself is the shortcut into the console —
                  no copy-pasting the number elsewhere, no separate button. */}
              {labstackConsoleUrl("APPOINTMENT", appointmentId) ? (
                <a
                  href={labstackConsoleUrl("APPOINTMENT", appointmentId)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open in LabStack Console"
                  className="text-sm font-semibold text-white hover:text-blue-300 hover:underline inline-flex items-center gap-1"
                >
                  Appointment #{appointmentId}
                  <svg className="w-3 h-3 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              ) : (
                <h2 className="text-sm font-semibold text-white">Appointment #{appointmentId}</h2>
              )}
              {appt?.appointmentStatus && (
                <span className={`text-[10px] font-semibold ${APPT_STATUS_COLOR[appt.appointmentStatus] ?? "text-zinc-400"}`}>
                  {appt.appointmentStatus}
                </span>
              )}
            </div>
            {appt?.appointmentType && (
              <p className="text-xs text-zinc-500 mt-0.5">{appt.appointmentType.replace(/_/g, " ")}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-5 h-5 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
            </div>
          ) : error ? (
            <div className="px-5 py-6">
              <div className="px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">{error}</div>
            </div>
          ) : appt ? (
            <div className="px-5 py-5 space-y-5">
              {/* Identity cards — Patient full-width (has a real callable
                  number here, unlike the Order view), Doctor + Store paired. */}
              <InfoCard
                icon={PERSON_ICON}
                label="Patient"
                name={appt.patientName ?? "—"}
                action={appt.patientMobile && (
                  <CallButton to={appt.patientMobile} name={appt.patientName} triggeredFrom="appt-patient" />
                )}
              />
              <div className="grid grid-cols-2 gap-3">
                <InfoCard
                  icon={PERSON_ICON}
                  label="Doctor"
                  name={appt.doctorName ?? "—"}
                  action={appt.doctorMobile && (
                    <CallButton to={appt.doctorMobile} name={appt.doctorName} triggeredFrom="appt-doctor" />
                  )}
                />
                <InfoCard icon={STORE_ICON} label="Store" name={appt.storeName ?? "—"} />
              </div>

              {/* Appointment */}
              <div>
                <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">Appointment Details</h3>
                <div className="space-y-2">
                  <InfoRow label="Date & Time" value={
                    appt.appointmentDate
                      ? formatISTTimestamp(appt.appointmentDate, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
                      : null
                  } />
                  <InfoRow label="Reference" value={appt.referenceId} />
                  {appt.appointmentUrl && (
                    <InfoRow label="Meeting" value={
                      <a href={appt.appointmentUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 hover:underline">
                        Join meeting
                      </a>
                    } />
                  )}
                </div>
              </div>

              {/* Notes */}
              {(appt.notes || appt.internalNotes) && (
                <div>
                  <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">Notes</h3>
                  <div className="space-y-2">
                    {appt.notes && (
                      <div>
                        <div className="text-[10px] text-zinc-600 mb-1">Appointment Notes</div>
                        <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap bg-zinc-800 rounded-lg px-3 py-2.5">{appt.notes}</p>
                      </div>
                    )}
                    {appt.internalNotes && (
                      <div>
                        <div className="text-[10px] text-zinc-600 mb-1">Internal Notes (OpsFlow)</div>
                        <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap bg-zinc-800 rounded-lg px-3 py-2.5">{appt.internalNotes}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* OpsFlow Tasks */}
              <div>
                <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">
                  OpsFlow Tasks
                  <span className="ml-1.5 text-zinc-600">({tasks.length})</span>
                </h3>
                {tasks.length === 0 ? (
                  <p className="text-xs text-zinc-600">No tasks created for this appointment</p>
                ) : (
                  <div className="space-y-2">
                    {tasks.map((task) => (
                      <TaskActionCard key={task.id} task={task} onChanged={load} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
