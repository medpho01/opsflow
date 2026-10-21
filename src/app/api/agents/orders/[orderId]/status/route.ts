/**
 * GET /api/agents/orders/[orderId]/status — the order-status API for stores that want one (FR-9.7).
 * Auth: `Authorization: Bearer <key>`; keys per store in STORE_STATUS_API_KEYS as "storeId:key,storeId:key".
 * A store sees only its own orders. Returns status, sub-state, slot, phlebo, report link (when delivered) and last update.
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { fetchOrderSnapshot } from "@/lib/agents/journey/window";

function storeForKey(request: NextRequest): number | null {
  const key = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!key) return null;
  for (const pair of (process.env.STORE_STATUS_API_KEYS ?? "").split(",")) {
    const [storeId, k] = pair.split(":").map((s) => s.trim());
    if (k && k === key && storeId) return Number(storeId);
  }
  return null;
}

const STATE_LABEL: Record<string, string> = {
  PENDING: "awaiting lab confirmation", CREATED: "awaiting lab confirmation", ORDER_SCHEDULED: "confirmed", RESCHEDULED: "rescheduled", PHLEBO_ASSIGNED: "phlebo assigned",
  KIT_DISPATCHED: "kit dispatched", PATIENT_VISITED: "phlebo reached", SAMPLE_COLLECTED: "sample collected", SAMPLE_DELIVERED: "sample at the lab", SAMPLE_PROCESSED: "processing",
  REPORT_DELIVERED: "report delivered", CANCELED: "cancelled", PATIENT_MISSED: "patient missed",
};

export async function GET(request: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  const storeId = storeForKey(request);
  if (storeId == null) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const orderId = Number((await params).orderId);
  if (!Number.isInteger(orderId)) return NextResponse.json({ error: "Bad order id" }, { status: 400 });
  const order = await fetchOrderSnapshot(orderId);
  if (!order || order.storeId !== storeId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const journey = await prisma.agentJourney.findUnique({ where: { orderId }, select: { subStates: true, waitingFor: true, dueAt: true, health: true, updatedAt: true, checkpoints: { select: { name: true, status: true, metAt: true, dueAt: true } } } });
  const report = journey?.checkpoints.find((c) => c.name === "report_delivered");
  return NextResponse.json({
    orderId, status: order.orderStatus, statusLabel: STATE_LABEL[order.orderStatus] ?? order.orderStatus.toLowerCase(),
    subStates: journey?.subStates ?? [], slot: order.appointmentTime, phlebo: order.phleboName || null, lab: order.labName,
    expected: journey?.waitingFor ? { what: (journey.waitingFor as { what: string }).what, by: journey.dueAt } : null,
    reportExpectedBy: report && report.status !== "MET" ? report.dueAt : null,
    reportLink: order.orderStatus === "REPORT_DELIVERED" && process.env.LABSTACK_CONSOLE_URL ? `${process.env.LABSTACK_CONSOLE_URL.replace(/\/$/, "")}/orders/${orderId}/report` : null,
    lastUpdate: order.statusUpdatedAt ?? journey?.updatedAt ?? null,
  });
}
