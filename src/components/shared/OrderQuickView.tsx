"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import CallButton from "@/components/shared/CallButton";
import TaskActionCard, { type ActionableTask } from "@/components/shared/TaskActionCard";
import { formatISTTimestamp, formatISTDate } from "@/lib/utils/timezone";
import { labstackConsoleUrl } from "@/lib/utils/labstackConsole";

interface OrderDetail {
  id: number;
  orderType: string;
  orderStatus: string;
  appointmentTime: string;
  storeId: number | null;
  labId: number | null;
  userId: number;
  createdAt: string;
  updatedAt: string;
  statusUpdatedAt: string;
  internalNotes: string | null;
  notes: string | null;
  phleboName: string | null;
  phleboNumber: string | null;
  patientName: string;
  labName: string | null;
  storeName: string | null;
}

type OrderTask = ActionableTask;

interface OrderQuickViewProps {
  orderId: number;
  onClose: () => void;
  // "modal" (default): fixed slide-over with a dimming backdrop, for call
  // sites that open this on top of the current screen.
  // "inline": docks as a plain full-height block with no backdrop/fixed
  // positioning, for a persistent split-view panel that sits next to a
  // task list (the caller controls width/border).
  variant?: "modal" | "inline";
  // The task's actual entityType (e.g. "REQUEST"), when the caller has it —
  // drives the "Open in Console" link so it points at the right console
  // section instead of always assuming plain orders. Callers that don't
  // track entityType (this component predates most non-Order sources) fall
  // back to "ORDER", which is correct for them today.
  entityType?: string;
}

const ORDER_STATUS_COLOR: Record<string, string> = {
  PENDING: "text-amber-400",
  CONFIRMED: "text-blue-400",
  AGENT_ASSIGNED: "text-purple-400",
  SAMPLE_COLLECTED: "text-teal-400",
  REPORT_UPLOADED: "text-emerald-400",
  REPORT_DELIVERED: "text-emerald-400",
  CANCELED: "text-red-400",
  PATIENT_MISSED: "text-red-400",
};

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-[10px] text-zinc-600 w-28 shrink-0 pt-0.5">{label}</span>
      <span className="text-xs text-zinc-300 flex-1">{value ?? "—"}</span>
    </div>
  );
}

// Compact identity card — Patient / Phlebo / Store all render the same
// shape (icon, label, name, optional call button / link), matching the
// three-card layout from the reference design.
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

export default function OrderQuickView({ orderId, onClose, variant = "modal", entityType = "ORDER" }: OrderQuickViewProps) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [tasks, setTasks] = useState<OrderTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/orders/${orderId}`);
      if (!res.ok) {
        // Error responses aren't always JSON (a 500 can be an HTML page) —
        // parse defensively so we show a clean message, not a JSON-parse error.
        let msg = `Failed to load order (HTTP ${res.status})`;
        try { const d = await res.json(); if (d?.error) msg = d.error; } catch { /* non-JSON body */ }
        throw new Error(msg);
      }
      const data = await res.json();
      setOrder(data.order);
      setTasks(data.tasks ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load order");
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => { load(); }, [load]);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* Backdrop — modal only. The inline variant docks in a caller-sized
          column, so there's nothing to dim behind it. */}
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
              {/* The order # itself is the shortcut into the console — no
                  copy-pasting the number elsewhere, no separate button. */}
              {labstackConsoleUrl(entityType, orderId) ? (
                <a
                  href={labstackConsoleUrl(entityType, orderId)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open in LabStack Console"
                  className="text-sm font-semibold text-white hover:text-blue-300 hover:underline inline-flex items-center gap-1"
                >
                  Order #{orderId}
                  <svg className="w-3 h-3 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              ) : (
                <h2 className="text-sm font-semibold text-white">Order #{orderId}</h2>
              )}
              {order && (
                <span className={`text-[10px] font-semibold ${ORDER_STATUS_COLOR[order.orderStatus] ?? "text-zinc-400"}`}>
                  {order.orderStatus}
                </span>
              )}
            </div>
            {order && (
              <p className="text-xs text-zinc-500 mt-0.5">{order.orderType.replace(/_/g, " ")}</p>
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
          ) : order ? (
            <div className="px-5 py-5 space-y-5">
              {/* Identity cards — Patient full-width, Phlebo + Store paired.
                  No patient phone on the Order model (only Phlebo carries a
                  callable number) — not faking a Call button where there's
                  no number to call. */}
              <InfoCard icon={PERSON_ICON} label="Patient" name={order.patientName} sub={`User #${order.userId}`} />
              <div className="grid grid-cols-2 gap-3">
                <InfoCard
                  icon={PERSON_ICON}
                  label="Phlebo"
                  name={order.phleboName ?? "Not assigned"}
                  action={order.phleboNumber && (
                    <CallButton to={order.phleboNumber} name={order.phleboName} triggeredFrom="order-phlebo" />
                  )}
                />
                <InfoCard icon={STORE_ICON} label="Store" name={order.storeName ?? (order.storeId ? `#${order.storeId}` : "—")} sub={order.labName ? `Lab: ${order.labName}` : undefined} />
              </div>

              {/* Order info */}
              <div>
                <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">Order Details</h3>
                <div className="space-y-2">
                  <InfoRow label="Appointment" value={
                    <span>{formatISTTimestamp(order.appointmentTime, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                  } />
                  <InfoRow label="Created" value={formatISTDate(order.createdAt)} />
                  <InfoRow label="Last Updated" value={formatISTTimestamp(order.updatedAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} />
                </div>
              </div>

              {/* Notes */}
              {(order.notes || order.internalNotes) && (
                <div>
                  <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">Notes</h3>
                  <div className="space-y-2">
                    {order.notes && (
                      <div>
                        <div className="text-[10px] text-zinc-600 mb-1">Customer Notes</div>
                        <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap bg-zinc-800 rounded-lg px-3 py-2.5">{order.notes}</p>
                      </div>
                    )}
                    {order.internalNotes && (
                      <div>
                        <div className="text-[10px] text-zinc-600 mb-1">Internal Notes (OpsFlow)</div>
                        <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap bg-zinc-800 rounded-lg px-3 py-2.5">{order.internalNotes}</p>
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
                  <p className="text-xs text-zinc-600">No tasks created for this order</p>
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
