/**
 * Reply composition — turns an intent + replica lookup into the text the
 * bot WOULD post. In dry-run this is only logged; nothing is sent.
 *
 * Only AUTO_ANSWER intents produce a real reply. Everything else produces
 * a "disposition note" describing what the live bot will do (create a
 * console task, escalate to the lab group, route to a human) so you can
 * see the full decision in the dry-run log before any of it goes live.
 */

const IST = { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" };
const fmt = (d) => (d ? new Date(d).toLocaleString("en-IN", IST) : "—");

// LabStack Order status → human phrasing + whether a report is expected.
function describeOrder(o) {
  const s = (o.status || "").toUpperCase();
  const appt = o.appointmentTime ? ` · appt ${fmt(o.appointmentTime)}` : "";
  const map = {
    ORDER_SCHEDULED: "scheduled, awaiting phlebo",
    PHLEBO_ASSIGNED: "phlebo assigned",
    SAMPLE_COLLECTED: "sample collected, processing",
    SAMPLE_PROCESSING: "sample processing at lab",
    SAMPLE_DELIVERED: "sample delivered to lab",
    REPORT_DELIVERED: "report delivered ✅",
    CANCELED: "cancelled",
    CANCELLED: "cancelled",
    PATIENT_MISSED: "patient missed / not available",
    RESCHEDULED: "rescheduled",
  };
  return `#${o.id} — ${map[s] || o.status}${appt}`;
}
function describeRequest(r) {
  return `Request #${r.id} — ${r.status}`;
}

/**
 * Returns { willReply: boolean, text: string, note: string }.
 *   willReply → an actual status answer we'd post (AUTO_ANSWER).
 *   note      → the disposition explanation (always present).
 */
export function compose({ intent, disposition, lookup }) {
  const { orders = [], requests = [] } = lookup || {};
  const found = orders.length + requests.length;

  if (disposition === "AUTO_ANSWER") {
    if (found === 0) {
      return { willReply: false, text: "", note: `AUTO_ANSWER but no matching order/request found — would ask for a valid id` };
    }
    const lines = [...orders.map(describeOrder), ...requests.map(describeRequest)];

    if (intent === "REPORT_REQUEST") {
      const parts = orders.map((o) =>
        (o.status || "").toUpperCase() === "REPORT_DELIVERED"
          ? `#${o.id} — report delivered ✅`
          : `#${o.id} — ${o.status} · report not ready yet`
      );
      return { willReply: true, text: parts.join("\n") || lines.join("\n"), note: "AUTO_ANSWER: report status" };
    }
    if (intent === "CANCEL_REASON") {
      const parts = orders.map((o) => `#${o.id} — ${o.status}`);
      return { willReply: true, text: parts.join("\n"), note: "AUTO_ANSWER: cancellation status (reason field TODO)" };
    }
    // STATUS_CHECK default
    return { willReply: true, text: lines.join("\n"), note: "AUTO_ANSWER: live status" };
  }

  const notes = {
    ROUTE_CONSOLE: `ROUTE_CONSOLE: would create an OpsFlow task (${intent}) — team works it in the console`,
    NEEDS_LAB: `NEEDS_LAB: would post to the lab group / call serviceability (${intent})`,
    HUMAN: `HUMAN: would ping a person fast (${intent})`,
    OUTBOUND: `OUTBOUND: a LabStack-side status post (${intent}) — could be auto-generated`,
    REVIEW: `REVIEW: needs conversation context — the LLM layer would resolve (${intent})`,
    NOISE: `NOISE: ignore (${intent})`,
  };
  return { willReply: false, text: "", note: notes[disposition] || `${disposition} (${intent})` };
}
