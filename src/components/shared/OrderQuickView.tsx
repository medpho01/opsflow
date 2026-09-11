"use client";

import { useState, useEffect } from "react";
import StatusBadge from "@/components/shared/StatusBadge";
import PriorityBadge from "@/components/shared/PriorityBadge";
import SlaCountdown from "@/components/shared/SlaCountdown";
import RiskBadge from "@/components/shared/RiskBadge";
import VipBadge from "@/components/shared/VipBadge";
import { formatISTTimestamp, formatISTDate } from "@/lib/utils/timezone";

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
  city: string | null;
  pincode: string | null;
  sampleCollectedTime: string | null;
  reportDeliveredTime: string | null;
}

interface OrderTask {
  id: number;
  title: string;
  status: string;
  priority: string;
  slaDeadline: string;
  slaBreachedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  assignedTo: { id: number; name: string } | null;
  taskType: { label: string } | null;
}

// Pickup-delay risk + VIP for this order — computed live per request by
// /api/tasks (see src/lib/priority/), not fetched separately here. The
// caller (MyWorkBoard) already has this on the Task it opened the drawer
// from, so it's passed straight through rather than re-fetched.
export interface OrderPriority {
  riskScore: number;
  riskBand: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  riskReasons: { code: string; label: string; points: number; detail: string }[];
  riskUnavailable: { signal: string; reason: string }[];
  vip: boolean;
  vipReasons: { code: string; label: string; detail: string }[];
  vipUnavailable: { signal: string; reason: string }[];
  isPriority: boolean;
}

interface OrderQuickViewProps {
  orderId: number;
  onClose: () => void;
  priority?: OrderPriority;
  // The priority (Urgent/High/Medium/Low) of the specific task the drawer
  // was opened from — real field off that Task row, not derived here.
  taskPriority?: string;
}

type Tab = "overview" | "history" | "notes" | "patient";

const RISK_BAND_STYLE: Record<OrderPriority["riskBand"], string> = {
  LOW: "text-zinc-400", MEDIUM: "text-yellow-400", HIGH: "text-orange-400", CRITICAL: "text-red-400",
};

// What actually made this a priority order — computed from the same two
// booleans the board uses (`isPriority = vip.vip || band is HIGH/CRITICAL`),
// never a separate guess.
function priorityTag(priority: OrderPriority): string | null {
  const elevatedRisk = priority.riskBand === "HIGH" || priority.riskBand === "CRITICAL";
  if (elevatedRisk && priority.vip) return "High Risk + VIP";
  if (elevatedRisk) return `${priority.riskBand === "CRITICAL" ? "Critical" : "High"} Risk`;
  if (priority.vip) return "VIP";
  return null;
}

// "Why is this a priority?" — the real reasons (risk signals that fired +
// VIP reasons that matched) surfaced as a single bulleted answer, not an
// invented summary.
function WhyPriorityCard({ priority }: { priority: OrderPriority }) {
  if (!priority.isPriority) return null;
  const tag = priorityTag(priority);
  const bullets: { key: string; text: string; points: number | null }[] = [
    ...priority.riskReasons.map((r) => ({ key: `risk-${r.code}`, text: r.detail, points: r.points })),
    ...priority.vipReasons.map((r) => ({ key: `vip-${r.code}`, text: r.detail, points: null })),
  ];
  return (
    <div className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-3">
      <div className="flex items-center justify-between mb-2 gap-2">
        <h3 className="text-xs font-semibold text-red-300">Why is this a priority?</h3>
        {tag && (
          <span className="text-[10px] font-medium text-red-300 bg-red-500/10 border border-red-500/30 rounded px-1.5 py-0.5 shrink-0">
            {tag}
          </span>
        )}
      </div>
      {bullets.length > 0 ? (
        <ul className="space-y-1.5">
          {bullets.map((b) => (
            <li key={b.key} className="text-xs text-zinc-300 flex gap-2">
              <span className="text-red-400 shrink-0">•</span>
              <span className="flex-1">{b.text}</span>
              {b.points !== null && <span className="text-zinc-500 tabular-nums shrink-0">+{b.points}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500">Flagged as VIP, no scored risk signals.</p>
      )}
    </div>
  );
}

// Every risk signal that actually fired, with its real point value — plus,
// collapsed by default, the signals this model cannot measure at all
// (blocked in riskConfig.ts) so "not shown" never gets mistaken for "zero".
function RiskBreakdownCard({ priority }: { priority: OrderPriority }) {
  return (
    <div>
      <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">Risk Breakdown</h3>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-3 space-y-3">
        <div className="flex items-center gap-2">
          <RiskBadge band={priority.riskBand} score={priority.riskScore} size="md" />
          <span className="text-[10px] text-zinc-600">/ 100</span>
        </div>
        {priority.riskReasons.length > 0 ? (
          <ul className="space-y-1.5">
            {priority.riskReasons.map((r) => (
              <li key={r.code} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-zinc-300">{r.label}</span>
                <span className="text-zinc-500 tabular-nums shrink-0">{r.points}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-zinc-600">No risk signals fired for this order.</p>
        )}
        {priority.riskUnavailable.length > 0 && (
          <details className="pt-2 border-t border-zinc-800">
            <summary className="text-[10px] text-zinc-600 cursor-pointer select-none hover:text-zinc-400">
              Signals not measured ({priority.riskUnavailable.length})
            </summary>
            <ul className="mt-1.5 space-y-1">
              {priority.riskUnavailable.map((u) => (
                <li key={u.signal} className="text-[10px] text-zinc-600">
                  <span className="text-zinc-500">{u.signal}</span> — {u.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

// The scorer already orders `reasons` most-significant-first — this is
// literally the first three, not a re-ranking.
function TopReasonsCard({ priority }: { priority: OrderPriority }) {
  const top = priority.riskReasons.slice(0, 3);
  if (top.length === 0) return null;
  return (
    <div>
      <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">Top Reasons</h3>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-3 space-y-2.5">
        {top.map((r, i) => (
          <div key={r.code} className="flex items-start gap-2.5">
            <span className="w-4 h-4 rounded-full bg-zinc-800 text-zinc-400 text-[10px] font-medium flex items-center justify-center shrink-0 mt-0.5">
              {i + 1}
            </span>
            <span className="text-xs text-zinc-300 flex-1">{r.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function VipDetailsCard({ priority }: { priority: OrderPriority }) {
  return (
    <div>
      <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">VIP Details</h3>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-3 space-y-2">
        <VipBadge vip={priority.vip} />
        {priority.vip ? (
          <ul className="space-y-1 pl-0.5">
            {priority.vipReasons.map((r) => (
              <li key={r.code} className="text-xs text-zinc-300 flex gap-2">
                <span className="text-amber-500 shrink-0">•</span>
                <span>{r.detail}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-zinc-600">No VIP signal matched this order.</p>
        )}
        {priority.vipUnavailable.length > 0 && (
          <details className="pt-2 border-t border-zinc-800">
            <summary className="text-[10px] text-zinc-600 cursor-pointer select-none hover:text-zinc-400">
              Not evaluated ({priority.vipUnavailable.length})
            </summary>
            <ul className="mt-1.5 space-y-1">
              {priority.vipUnavailable.map((u) => (
                <li key={u.signal} className="text-[10px] text-zinc-600">
                  <span className="text-zinc-500">{u.signal}</span> — {u.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

// Real phlebotomist contact — Order.phleboName / Order.phleboNumber, the
// same fields the board's row and Order Details already read. Given its
// own card because it's the one real "who do I call" contact this order
// actually has (the patient has no phone anywhere in the schema).
function PhleboCard({ order }: { order: OrderDetail }) {
  return (
    <div>
      <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">Phlebotomist</h3>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-3 flex items-center justify-between gap-2">
        {order.phleboName ? (
          <>
            <span className="text-sm text-zinc-200 font-medium">{order.phleboName}</span>
            {order.phleboNumber ? (
              <a href={`tel:${order.phleboNumber}`} className="text-xs text-blue-400 hover:text-blue-300">
                {order.phleboNumber}
              </a>
            ) : (
              <span className="text-[10px] text-zinc-600">no number on file</span>
            )}
          </>
        ) : (
          <span className="text-xs text-zinc-600">No phlebotomist assigned yet</span>
        )}
      </div>
    </div>
  );
}

function StatBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 min-w-0">
      <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1.5">{label}</div>
      {children}
    </div>
  );
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
  const isBlank = value === null || value === undefined || value === "";
  return (
    <div className="flex items-start gap-3">
      <span className="text-[10px] text-zinc-600 w-28 shrink-0 pt-0.5">{label}</span>
      <span className="text-xs text-zinc-300 flex-1">{isBlank ? "—" : value}</span>
    </div>
  );
}

// A real, chronological life-of-the-order timeline — every point taken
// straight off Order columns that already exist (createdAt, appointmentTime,
// statusUpdatedAt, sampleCollectedTime, reportDeliveredTime). Milestones
// that never happened (e.g. sample not yet collected) are simply absent,
// never shown as a blank/pending placeholder.
interface HistoryEvent { key: string; label: string; time: string }

function buildHistory(order: OrderDetail): HistoryEvent[] {
  const events: HistoryEvent[] = [
    { key: "created", label: "Order created", time: order.createdAt },
    { key: "appt", label: "Appointment scheduled", time: order.appointmentTime },
    { key: "status", label: `Status changed to ${order.orderStatus}`, time: order.statusUpdatedAt },
  ];
  if (order.sampleCollectedTime) events.push({ key: "collected", label: "Sample collected", time: order.sampleCollectedTime });
  if (order.reportDeliveredTime) events.push({ key: "delivered", label: "Report delivered", time: order.reportDeliveredTime });
  return events.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
}

function HistoryTimeline({ order }: { order: OrderDetail }) {
  const events = buildHistory(order);
  return (
    <div>
      <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">Order Timeline</h3>
      <div>
        {events.map((e, i) => (
          <div key={e.key} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className="w-2 h-2 rounded-full bg-blue-500 mt-1.5 shrink-0" />
              {i < events.length - 1 && <span className="w-px flex-1 bg-zinc-800" />}
            </div>
            <div className={i < events.length - 1 ? "pb-4 flex-1" : "flex-1"}>
              <div className="text-xs text-zinc-200">{e.label}</div>
              <div className="text-[10px] text-zinc-600 mt-0.5">
                {formatISTTimestamp(e.time, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TabBar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "history", label: "History" },
    { key: "notes", label: "Notes" },
    { key: "patient", label: "Patient" },
  ];
  return (
    <div className="flex items-center gap-5 border-b border-zinc-800 px-5 shrink-0">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => setTab(t.key)}
          className={`py-2.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
            tab === t.key ? "text-blue-400 border-blue-500" : "text-zinc-500 border-transparent hover:text-zinc-300"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export default function OrderQuickView({ orderId, onClose, priority, taskPriority }: OrderQuickViewProps) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [tasks, setTasks] = useState<OrderTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    setTab("overview");
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/orders/${orderId}`);
        if (!res.ok) {
          const d = await res.json();
          throw new Error(d.error ?? "Order not found");
        }
        const data = await res.json();
        setOrder(data.order);
        setTasks(data.tasks ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load order");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [orderId]);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const locationLine = order
    ? [order.city, order.pincode].filter(Boolean).join(" · ") ||
      (order.storeName ? `Near ${order.storeName}` : null)
    : null;

  return (
    <>
      {/* Transparent click-catcher — closes on outside click, but the board
          behind stays fully visible (not dimmed), matching the reference layout. */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      {/* Slide-over panel */}
      <div className="fixed right-0 top-0 h-full w-full max-w-xl bg-zinc-900 border-l border-zinc-700 shadow-2xl z-50 flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-800 shrink-0">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-semibold text-white">#{orderId}</h2>
              {priority && <RiskBadge band={priority.riskBand} />}
              {priority?.vip && <VipBadge vip />}
              {order && (
                <span className={`text-[10px] font-semibold ${ORDER_STATUS_COLOR[order.orderStatus] ?? "text-zinc-400"}`}>
                  {order.orderStatus}
                </span>
              )}
            </div>
            <button
              onClick={onClose}
              className="p-2 -mr-2 -mt-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors shrink-0"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {order && (
            <>
              <p className="text-base font-semibold text-white mt-2">{order.patientName || "—"}</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                {locationLine ?? "—"} · {order.orderType.replace(/_/g, " ")}
              </p>
            </>
          )}
        </div>

        <TabBar tab={tab} setTab={setTab} />

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
            <>
              {tab === "overview" && (
                <div className="px-5 py-5 space-y-6">
                  {priority && (
                    <div className="flex items-stretch gap-2">
                      <StatBox label="Risk Score">
                        <div className={`text-lg font-semibold tabular-nums ${RISK_BAND_STYLE[priority.riskBand]}`}>
                          {priority.riskScore}<span className="text-xs text-zinc-600">/100</span>
                        </div>
                      </StatBox>
                      <StatBox label="VIP">
                        <VipBadge vip={priority.vip} />
                      </StatBox>
                      {taskPriority && (
                        <StatBox label="Priority">
                          <PriorityBadge priority={taskPriority as never} />
                        </StatBox>
                      )}
                    </div>
                  )}

                  {priority && <WhyPriorityCard priority={priority} />}
                  {priority && <RiskBreakdownCard priority={priority} />}
                  {priority && <TopReasonsCard priority={priority} />}
                  {priority && <VipDetailsCard priority={priority} />}

                  <PhleboCard order={order} />

                  <div>
                    <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">Order Details</h3>
                    <div className="space-y-2">
                      <InfoRow label="Appointment" value={
                        <span>{formatISTTimestamp(order.appointmentTime, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                      } />
                      <InfoRow label="Store" value={order.storeName ?? (order.storeId ? `#${order.storeId}` : null)} />
                      <InfoRow label="Lab" value={order.labName ?? (order.labId ? `#${order.labId}` : null)} />
                      <InfoRow label="Created" value={formatISTDate(order.createdAt)} />
                      <InfoRow label="Last Updated" value={formatISTTimestamp(order.updatedAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} />
                    </div>
                  </div>
                </div>
              )}

              {tab === "history" && (
                <div className="px-5 py-5 space-y-6">
                  <HistoryTimeline order={order} />
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
                          <div key={task.id} className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-3">
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-medium text-zinc-200 leading-snug">{task.title}</div>
                                <div className="text-[10px] text-zinc-600 mt-0.5">
                                  #{task.id} · {task.taskType?.label ?? "Task"}
                                </div>
                              </div>
                              <StatusBadge status={task.status as never} />
                            </div>
                            <div className="flex items-center gap-3">
                              <PriorityBadge priority={task.priority as never} />
                              <span className="text-[10px] text-zinc-500">
                                {task.assignedTo ? task.assignedTo.name : "Unassigned"}
                              </span>
                              {task.status !== "COMPLETED" && task.status !== "CANCELLED" && (
                                <SlaCountdown deadline={task.slaDeadline} compact />
                              )}
                              {task.completedAt && (
                                <span className="text-[10px] text-emerald-500">
                                  Done {formatISTTimestamp(task.completedAt, { hour: "2-digit", minute: "2-digit" })}
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {tab === "notes" && (
                <div className="px-5 py-5">
                  {order.notes || order.internalNotes ? (
                    <div className="space-y-3">
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
                  ) : (
                    <p className="text-xs text-zinc-600">No notes recorded for this order.</p>
                  )}
                </div>
              )}

              {tab === "patient" && (
                <div className="px-5 py-5 space-y-2">
                  <InfoRow label="Name" value={order.patientName} />
                  <InfoRow label="User ID" value={`#${order.userId}`} />
                  <InfoRow label="Location" value={locationLine} />
                  <InfoRow label="Order Type" value={order.orderType.replace(/_/g, " ")} />
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
