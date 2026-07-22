/**
 * Source analytics registry — the "analytics contract" per data source.
 *
 * Each labstack table OpsFlow wants load/status analytics for declares a
 * small config mapping its columns onto universal semantic slots. ONE
 * generic engine (/api/analytics/source-load) and ONE generic panel
 * (SourceLoadPanel) render whatever a contract provides — adding a new
 * source is adding an entry here, never building a new view.
 *
 * Tiers (the panel renders whichever tiers a source unlocks):
 *   T0  eventTimeField                → volume heatmap, busiest days, trend
 *   T1  + statusField                 → current status distribution
 *   T2  + statusMap                   → fulfillment rate, open-backlog aging
 *   T3  + dimensions                  → per-type slicing / concentrations
 *
 * Column names declared here are trusted constants (this file is code,
 * not user input), but the API still validates every one against
 * information_schema at query time and DEGRADES the tier rather than
 * erroring when a column doesn't exist — a wrong guess in a contract
 * must produce a smaller panel, never a 500 or a hung replica. Runtime
 * warnings in the response say exactly what was dropped and why.
 *
 * Statuses in statusMap that don't exist are harmless (they just never
 * match). Statuses that exist but aren't mapped count as "open" — the
 * raw status distribution (T1) always shows ground truth, so a mapping
 * gap is visible rather than silent.
 */

export interface SourceDimension {
  key: string;    // stable key used in API params/response
  label: string;  // chip label in the panel
  column: string; // column on the source table
}

export interface SourceAnalyticsContract {
  key: string;              // registry key, used as ?source= param
  label: string;            // display name
  table: string;            // bare table name in labstack's public schema
  createdField: string;     // when the entity came into existence
  eventTimeField: string;   // the operationally-meaningful instant (heatmap axis)
  eventTimeLabel: string;   // how the panel names that axis
  // Days of future eventTime to include (appointment-style sources have
  // booked-ahead load; creation-time sources have none).
  lookaheadDays: number;
  statusField?: string;
  statusMap?: {
    fulfilled: string[];    // terminal-success statuses
    failed: string[];       // terminal-failure statuses
    // everything else counts as open
  };
  dimensions?: SourceDimension[];
}

export const SOURCE_ANALYTICS: Record<string, SourceAnalyticsContract> = {
  orders: {
    key: "orders",
    label: "Orders",
    table: "Order",
    createdField: "createdAt",
    eventTimeField: "appointmentTime",
    eventTimeLabel: "appointment time",
    lookaheadDays: 7,
    statusField: "orderStatus",
    statusMap: {
      fulfilled: ["REPORT_DELIVERED"],
      failed: ["CANCELED", "PATIENT_MISSED"],
    },
    dimensions: [{ key: "type", label: "Type", column: "orderType" }],
  },
  requests: {
    key: "requests",
    label: "Requests",
    table: "Request",
    createdField: "createdAt",
    eventTimeField: "createdAt", // requests have no appointment; arrival IS the event
    eventTimeLabel: "creation time",
    lookaheadDays: 0,
    statusField: "status",
    // Calibrated 22 Jul with ops (Abhishek): "Ordered" is the TERMINAL
    // POSITIVE state for a request — the request was converted into an
    // order, i.e. fulfilled/closed. Before this mapping the panel counted
    // every completed request as open (0% fulfilled, a fake 5.8K "rotting
    // backlog"). Earlier guesses kept as harmless aliases; matching is
    // case-insensitive in the engine.
    statusMap: {
      fulfilled: ["Ordered", "RESOLVED", "CLOSED", "COMPLETED", "FULFILLED", "DONE"],
      failed: ["REJECTED", "CANCELLED", "CANCELED", "EXPIRED"],
    },
    dimensions: [{ key: "type", label: "Type", column: "requestType" }],
  },
  pharma: {
    key: "pharma",
    label: "Pharma Orders",
    table: "PharmaOrder",
    // Schema verified 22 Jul (replica information_schema): orderDate,
    // createdAt, orderStatus (enum), orderType (enum) all exist.
    createdField: "createdAt",
    eventTimeField: "orderDate",
    eventTimeLabel: "order date",
    lookaheadDays: 7,
    statusField: "orderStatus",
    // Vocabulary calibrated 22 Jul against the live table (60d GROUP BY):
    // FULL_DELIVERED / CANCELLED / PLACED. PARTIAL_DELIVERED kept
    // speculatively (harmless if absent); PLACED and anything new count
    // as open and surface in the T1 status-mix card.
    statusMap: {
      fulfilled: ["FULL_DELIVERED", "PARTIAL_DELIVERED"],
      failed: ["CANCELLED", "CANCELED", "REJECTED", "RETURNED"],
    },
    // Single value today (HOME_DELIVERY) — the panel auto-hides type
    // chips when there's only one, so this costs nothing until a second
    // type appears.
    dimensions: [{ key: "type", label: "Type", column: "orderType" }],
  },
  appointments: {
    key: "appointments",
    label: "Appointments",
    table: "Appointment",
    createdField: "createdAt",
    eventTimeField: "appointmentTime",
    eventTimeLabel: "appointment time",
    lookaheadDays: 7,
    statusField: "status",
    statusMap: {
      fulfilled: ["COMPLETED", "FULFILLED", "DONE", "REPORT_DELIVERED"],
      failed: ["CANCELLED", "CANCELED", "NO_SHOW", "PATIENT_MISSED", "EXPIRED"],
    },
    dimensions: [{ key: "type", label: "Type", column: "appointmentType" }],
  },
};

/** Client-safe listing for the panel's source chips. */
export function listSources(): Array<{ key: string; label: string }> {
  return Object.values(SOURCE_ANALYTICS).map(({ key, label }) => ({ key, label }));
}
