/**
 * Intent → Action playbook — the single, auditable definition of what the
 * WhatsApp bot does with every message. Grounded in the live LabStack schema
 * (Order.orderStatus, Request.status) so the reply templates map to states
 * that actually exist in the data.
 *
 * Used by:
 *   - scripts/build-analysis.mjs  → per-message action CSV + PRD numbers
 *   - the live bot (reply layer)  → the same decisions, in production
 *
 * ACTION TYPES (what the bot physically does):
 *   AUTO_REPLY        post an answer straight back into the group (status/report)
 *   AUTO_ASK_ID       auto-reply asking for a valid order/booking id (no id given)
 *   CONSOLE_TASK      create/route an OpsFlow task; team actions it in the console
 *   LAB_ESCALATION    post to the lab/serviceability group (or call the lab API)
 *   HUMAN_ESCALATION  ping a person immediately (angry customer / tech outage)
 *   OUTBOUND_POST     bot proactively posts a LabStack-side status update
 *   LLM_REVIEW        hand to the LLM+context layer (bare id / freeform)
 *   IGNORE            noise / system messages
 *
 * PHASE (when it ships):
 *   P0  rules + replica lookup only — buildable today
 *   P1  needs the LLM+context layer (resolves bare ids, freeform, extraction)
 *   P2  needs lab serviceability/slot/price data or a console write-API
 */

// ── LabStack Order.orderStatus → partner-facing phrasing ───────────────────
// Every value observed in the replica, mapped to a human line + whether a
// report is expected. Falls back to the raw enum so nothing leaks silently.
export const ORDER_STATUS_PHRASING = {
  CREATED:          "order created, being scheduled",
  PENDING:          "pending scheduling",
  ORDER_SCHEDULED:  "scheduled, awaiting phlebo assignment",
  PHLEBO_ASSIGNED:  "phlebo assigned, out for collection",
  SAMPLE_COLLECTED: "sample collected, processing at lab",
  SAMPLE_PROCESSED: "sample processed, report being generated",
  SAMPLE_DELIVERED: "sample delivered to lab",
  KIT_DISPATCHED:   "kit dispatched",
  REPORT_DELIVERED: "report delivered ✅",
  RESCHEDULED:      "rescheduled",
  PATIENT_MISSED:   "patient missed / not available at slot",
  CANCELED:         "cancelled",
  CANCELLED:        "cancelled",
};

// ── LabStack Request.status → partner-facing phrasing ──────────────────────
export const REQUEST_STATUS_PHRASING = {
  OPEN:            "open, being processed",
  CONSENTED:       "consented, booking in progress",
  QUOTED:          "quote shared, awaiting confirmation",
  ORDERED:         "booked / converted to order ✅",
  DISCHARGED:      "closed",
  UNREACHABLE:     "customer unreachable — need a reachable number/time",
  WRONG_NUMBER:    "wrong number — please re-share contact",
  NON_SERVICEABLE: "not serviceable at this location",
  DENIED:          "declined by customer",
  CANCELLED:       "cancelled",
};

// Terminal-positive states (used for "is it done?" answers + metrics).
export const ORDER_TERMINAL_POSITIVE = new Set(["REPORT_DELIVERED"]);
export const REQUEST_TERMINAL_POSITIVE = new Set(["ORDERED"]);

// ── The playbook itself: one entry per intent ──────────────────────────────
// reply(sampleId) returns the template string a partner would see, so the CSV
// shows a concrete example even offline (live bot substitutes real values).
export const PLAYBOOK = {
  STATUS_CHECK: {
    disposition: "AUTO_ANSWER",
    action: "AUTO_REPLY",
    lookup: true,
    phase: "P0",
    owner: "bot",
    summary: "Answer the live order/booking status from LabStack.",
    reply: (id) => `#${id || "<id>"} — <live status> · appt <time> (auto, from LabStack)`,
    noId: "AUTO_ASK_ID",
  },
  REPORT_REQUEST: {
    disposition: "AUTO_ANSWER",
    action: "AUTO_REPLY",
    lookup: true,
    phase: "P0",
    owner: "bot",
    summary: "Answer report readiness; share the report/status when delivered.",
    reply: (id) => `#${id || "<id>"} — report delivered ✅ / not ready yet (auto, from LabStack)`,
    noId: "AUTO_ASK_ID",
  },
  CANCEL_REASON: {
    disposition: "AUTO_ANSWER",
    action: "AUTO_REPLY",
    lookup: true,
    phase: "P0",
    owner: "bot",
    summary: "Answer why an order was cancelled/missed (cancelReason field).",
    reply: (id) => `#${id || "<id>"} — cancelled: <cancelReason> (auto, from LabStack)`,
    noId: "AUTO_ASK_ID",
  },
  RESCHEDULE: {
    disposition: "ROUTE_CONSOLE",
    action: "CONSOLE_TASK",
    lookup: false,
    phase: "P1",
    owner: "team",
    summary: "Capture the new date/time and open a reschedule task in the console.",
    reply: () => `Reschedule task created for the team (new slot captured).`,
  },
  CANCEL_REQUEST: {
    disposition: "ROUTE_CONSOLE",
    action: "CONSOLE_TASK",
    lookup: false,
    phase: "P0",
    owner: "team",
    summary: "Open a cancellation task; team confirms + actions in the console.",
    reply: (id) => `Cancellation task created for #${id || "<id>"} — team will confirm.`,
  },
  NEW_BOOKING: {
    disposition: "ROUTE_CONSOLE",
    action: "CONSOLE_TASK",
    lookup: false,
    phase: "P1",
    owner: "team",
    summary: "Parse patient + slot into a booking draft task in the console.",
    reply: () => `New-booking draft created in the console for the team to confirm.`,
  },
  CREATE_ACTION: {
    disposition: "ROUTE_CONSOLE",
    action: "CONSOLE_TASK",
    lookup: false,
    phase: "P0",
    owner: "team",
    summary: "Partner asked to create/process an order/request → console task.",
    reply: () => `Task created in the console — team will process.`,
  },
  PATIENT_DATA: {
    disposition: "ROUTE_CONSOLE",
    action: "CONSOLE_TASK",
    lookup: false,
    phase: "P1",
    owner: "team",
    summary: "Structured patient row → extract fields, attach to booking/request.",
    reply: () => `Patient details captured → request/booking task created.`,
  },
  SERVICEABILITY: {
    disposition: "NEEDS_LAB",
    action: "LAB_ESCALATION",
    lookup: false,
    phase: "P2",
    owner: "lab",
    summary: "Check pincode/lab coverage; answer serviceable or route to lab group.",
    reply: () => `Serviceability check → answer from coverage data, else posted to lab group.`,
  },
  SLOT_CHECK: {
    disposition: "NEEDS_LAB",
    action: "LAB_ESCALATION",
    lookup: false,
    phase: "P2",
    owner: "lab",
    summary: "Check slot availability; answer or route to the lab group.",
    reply: () => `Slot availability check → answer, else posted to lab group.`,
  },
  FEASIBILITY_QUOTE: {
    disposition: "NEEDS_LAB",
    action: "LAB_ESCALATION",
    lookup: false,
    phase: "P2",
    owner: "lab",
    summary: "Provide price/feasibility from price list, else route to lab group.",
    reply: () => `Quote/feasibility → from price list if available, else posted to lab group.`,
  },
  ESCALATION: {
    disposition: "HUMAN",
    action: "HUMAN_ESCALATION",
    lookup: false,
    phase: "P0",
    owner: "human",
    summary: "Angry/complaint/SLA-breach → ping a human immediately + flag.",
    reply: () => `Escalated to ops lead immediately (no auto-reply).`,
  },
  TECH_ISSUE: {
    disposition: "HUMAN",
    action: "HUMAN_ESCALATION",
    lookup: false,
    phase: "P0",
    owner: "human",
    summary: "Console/app not working → notify tech/ops fast.",
    reply: () => `Routed to tech/ops (console/app issue).`,
  },
  OUTBOUND_UPDATE: {
    disposition: "OUTBOUND",
    action: "OUTBOUND_POST",
    lookup: false,
    phase: "P1",
    owner: "bot",
    summary: "LabStack-side status post (created/completed/cancelled/RNR) — bot can auto-generate these from events.",
    reply: () => `Bot can auto-post this update from the order event stream.`,
  },
  ID_ONLY: {
    disposition: "REVIEW",
    action: "LLM_REVIEW",
    lookup: true,
    phase: "P1",
    owner: "bot",
    summary: "Bare id after a question → LLM+context treats as status check for that id.",
    reply: (id) => `#${id || "<id>"} — LLM links to the prior question, then auto-answers status.`,
  },
  OTHER: {
    disposition: "REVIEW",
    action: "LLM_REVIEW",
    lookup: false,
    phase: "P1",
    owner: "bot",
    summary: "Freeform / ambiguous → LLM classifies with thread context, else human.",
    reply: () => `LLM+context resolves; falls back to a human if low confidence.`,
  },
  NOISE:  { disposition: "NOISE", action: "IGNORE", lookup: false, phase: "P0", owner: "—", summary: "Acknowledgement / chatter — ignored.", reply: () => `(ignored)` },
  SYSTEM: { disposition: "NOISE", action: "IGNORE", lookup: false, phase: "P0", owner: "—", summary: "WhatsApp system line / media placeholder — ignored.", reply: () => `(ignored)` },
};

// Coarse confidence for a message given its intent + whether an id was found.
// HIGH: precise rule fired (and, for lookups, an id is present).
// MED : rule fired but needs data/console the bot can't fully self-serve.
// LOW : REVIEW bucket — needs the LLM+context layer.
export function confidenceFor(intent, hasId) {
  const p = PLAYBOOK[intent];
  if (!p) return "LOW";
  if (p.action === "LLM_REVIEW") return "LOW";
  if (p.lookup && !hasId) return "MED";           // AUTO_ANSWER but must ask for id
  if (p.action === "AUTO_REPLY") return "HIGH";
  if (p.action === "IGNORE") return "HIGH";
  return "MED";
}
