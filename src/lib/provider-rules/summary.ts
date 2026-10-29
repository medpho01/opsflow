/**
 * SUMMARY rules: one message per lab at a time of day, listing the orders
 * that match the rule — tomorrow's collections, reports still pending, or
 * whatever a rule selects.
 *
 * Each order is a numbered entry a lab can work from: when, who, where (full
 * address + map pin for home visits), what (packages with their tests, and
 * tests booked on their own), and — while still unconfirmed in LabStack — the
 * link to confirm it.
 */
import { confirmationUrl, ConfirmationLinkConfigError } from "@/lib/non-api-labs/confirmation-link";
import { testsForLab, type OrderContactDetails } from "@/lib/non-api-labs/order-details";
import { isAwaitingConfirmation } from "@/lib/non-api-labs/source-check";
import type { TemplateVariables } from "@/lib/non-api-labs/templates";
import { dayLabel, durationText, formatTime, formatDate } from "./format";
import { renderLoose, STYLE_DEFAULTS } from "@/lib/agents/style";
import type { MessageRule, RuleOrder } from "./types";

/** A WhatsApp message has no second page, so the list is capped, not paged. */
export const SUMMARY_LIST_LIMIT = Number(process.env.PROVIDER_SUMMARY_LIST_LIMIT ?? 12);

export type SummaryEntry = {
  order: RuleOrder;
  details: OrderContactDetails | null;
  confirmLink: string | null;
  /** The lab said "ok" in the group (reply fact `confirmed`) but LabStack still shows it unconfirmed. */
  confirmedInChat?: boolean;
};

/** The bodies the entries render from: the live or trial wording of SUMMARY_ENTRY_TOMORROW / SUMMARY_ENTRY_PAST. */
export type EntryBodies = { tomorrow?: string; past?: string };

/**
 * The numbered list. `scope` decides how "when" reads: a time for one day, else date and time since.
 * What an entry carries is the entry template's choice (27 Oct 2026: the pending-reports list
 * repeated every address and every test of a 13-test package — the lab needed the id, the name,
 * the phone and the visit date). Package names, never their tests — on that list only: tomorrow's
 * list is what the phlebo collects from, and a manual lab does not know what a package holds, so
 * each package carries every one of its tests (29 Oct 2026).
 */
export function orderListBlock(entries: SummaryEntry[], rule: Pick<MessageRule, "summaryScope">, now: Date, timeZone: string, bodies: EntryBodies = {}): string {
  if (entries.length === 0) return "No orders on this list.";
  const sameDay = rule.summaryScope === "APPOINTMENT_TOMORROW" || rule.summaryScope === "APPOINTMENT_TODAY";
  const body = sameDay ? bodies.tomorrow ?? STYLE_DEFAULTS.SUMMARY_ENTRY_TOMORROW.body : bodies.past ?? STYLE_DEFAULTS.SUMMARY_ENTRY_PAST.body;
  const shown = entries.slice(0, SUMMARY_LIST_LIMIT).map(({ order, details, confirmLink, confirmedInChat }, index) => {
    const time = order.appointmentTime ? formatTime(order.appointmentTime) : "no appointment";
    const dateTime = order.appointmentTime ? `${formatDate(order.appointmentTime)} ${formatTime(order.appointmentTime)}` : "no appointment";
    const since = order.appointmentTime && order.appointmentTime.getTime() < now.getTime() ? `${durationText((now.getTime() - order.appointmentTime.getTime()) / 60_000)} ago` : "";
    const centre = order.orderType === "CENTER_VISIT" ? `Centre visit${details?.storeName ? ` – ${details.storeName}` : ""}` : "";
    const packages = [...new Set((details?.packages ?? []).map((p) => p.name?.trim()).filter(Boolean))];
    const direct = [...new Set((details?.directTests ?? []).map((t) => t.trim()).filter(Boolean))];
    const what = (sameDay ? testsForLab(details, "      ", Infinity) : null) || [...packages, ...direct].join("; ") || details?.tests || "";
    const state = !isAwaitingConfirmation(order.orderStatus) ? "" : confirmedInChat ? "✅ _Confirmed in chat – not yet in LabStack_" : "⚠️ _Not confirmed_";
    return renderLoose(body, {
      n: String(index + 1), time, date_time: dateTime, name: order.patientName || "Name not on file", order_id: String(order.id),
      mobile: details?.patientMobile, address: centre ? "" : details?.address ?? details?.area, map_url: centre ? "" : details?.mapUrl, centre,
      packages: what, tests: direct.join(", "), since, confirm_line: state ? (confirmLink ? `${state} – ${confirmLink}` : state) : "",
    });
  });
  const remaining = entries.length - shown.length;
  if (remaining > 0) shown.push(`…and ${remaining} more — full list in LabStack.`);
  return shown.join("\n\n");
}

/** A confirmation link, or null when the deployment has no key configured. */
async function safeConfirmationUrl(orderId: number): Promise<string | null> {
  try {
    return await confirmationUrl(orderId);
  } catch (error) {
    if (error instanceof ConfirmationLinkConfigError) return null;
    throw error;
  }
}

/** Entries in list order: by appointment, soonest (or oldest) first. `confirmedInChat`: orders with a `confirmed` reply fact. */
export async function buildEntries(
  orders: RuleOrder[], details: Map<number, OrderContactDetails> | null, confirmedInChat: Set<number> = new Set(),
): Promise<SummaryEntry[]> {
  const sorted = [...orders].sort((a, b) =>
    (a.appointmentTime?.getTime() ?? Infinity) - (b.appointmentTime?.getTime() ?? Infinity) || a.id - b.id);
  return Promise.all(sorted.map(async (order) => ({
    order,
    details: details?.get(order.id) ?? null,
    confirmLink: isAwaitingConfirmation(order.orderStatus) ? await safeConfirmationUrl(order.id) : null,
    confirmedInChat: confirmedInChat.has(order.id),
  })));
}

/**
 * The variables a summary template can use. The tomorrow_* / today_* /
 * digest_date names keep templates written for the earlier evening list working.
 */
export function summaryVariables(labName: string, rule: MessageRule, entries: SummaryEntry[], now: Date, timeZone: string, bodies: EntryBodies = {}): TemplateVariables {
  const listDay = rule.summaryScope === "APPOINTMENT_TOMORROW" ? new Date(now.getTime() + 86_400_000) : now;
  const pending = entries.filter((entry) => isAwaitingConfirmation(entry.order.orderStatus)).length;
  const list = orderListBlock(entries, rule, now, timeZone, bodies);
  const count = String(entries.length);
  return {
    lab_name: labName,
    summary_date: dayLabel(listDay),
    order_count: count,
    order_list: list,
    confirmed_count: String(entries.length - pending),
    pending_count: String(pending),
    // Earlier evening-list names.
    digest_date: dayLabel(now),
    tomorrow_date: dayLabel(listDay),
    tomorrow_total: count,
    tomorrow_schedule: list,
    tomorrow_confirmed: String(entries.length - pending),
    tomorrow_unconfirmed: String(pending),
    tomorrow_home: String(entries.filter((e) => e.order.orderType === "HOME_SAMPLE").length),
    tomorrow_centre: String(entries.filter((e) => e.order.orderType === "CENTER_VISIT").length),
    tomorrow_first: entries[0]?.order.appointmentTime ? formatTime(entries[0].order.appointmentTime) : "—",
    today_total: "—", today_home: "—", today_centre: "—", today_collected: "—", today_pending: "—",
    today_reports_pending: "—", today_cancelled: "—", today_unconfirmed: "—", today_schedule: "—",
  };
}
