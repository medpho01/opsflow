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
import { formatTestBreakdown, type OrderContactDetails } from "@/lib/non-api-labs/order-details";
import { isAwaitingConfirmation } from "@/lib/non-api-labs/source-check";
import type { TemplateVariables } from "@/lib/non-api-labs/templates";
import { dayLabel, durationText, formatTime, formatDate } from "./format";
import type { MessageRule, RuleOrder } from "./types";

/** A WhatsApp message has no second page, so the list is capped, not paged. */
export const SUMMARY_LIST_LIMIT = Number(process.env.PROVIDER_SUMMARY_LIST_LIMIT ?? 12);

export type SummaryEntry = { order: RuleOrder; details: OrderContactDetails | null; confirmLink: string | null };

/** The numbered list. `scope` decides how "when" reads: a time for one day, else date and time since. */
export function orderListBlock(entries: SummaryEntry[], rule: Pick<MessageRule, "summaryScope">, now: Date, timeZone: string): string {
  if (entries.length === 0) return "No orders on this list.";
  const sameDay = rule.summaryScope === "APPOINTMENT_TOMORROW" || rule.summaryScope === "APPOINTMENT_TODAY";
  const shown = entries.slice(0, SUMMARY_LIST_LIMIT).map(({ order, details, confirmLink }, index) => {
    const when = !order.appointmentTime ? "no appointment"
      : sameDay ? formatTime(order.appointmentTime)
        : `${formatDate(order.appointmentTime)} ${formatTime(order.appointmentTime)}`;
    const lines = [`*${index + 1}. ${when}* – ${order.patientName || "Name not on file"} · #${order.id}`];
    if (!sameDay && order.appointmentTime && order.appointmentTime.getTime() < now.getTime()) {
      lines.push(`   ⏱️ ${durationText((now.getTime() - order.appointmentTime.getTime()) / 60_000)} since the appointment`);
    }
    if (order.orderType === "CENTER_VISIT") {
      lines.push(`   🏥 Centre visit${details?.storeName ? ` – ${details.storeName}` : ""}`);
    } else {
      const where = details?.address ?? details?.area;
      if (where) lines.push(`   📍 ${where}`);
      if (details?.mapUrl) lines.push(`   🗺️ ${details.mapUrl}`);
    }
    const tests = formatTestBreakdown(details?.packages ?? [], details?.directTests ?? []);
    if (tests.length > 0) lines.push(...tests);
    else if (details?.tests) lines.push(`   🧪 ${details.tests}`);
    if (isAwaitingConfirmation(order.orderStatus)) {
      lines.push(confirmLink ? `   ⚠️ _Not confirmed_ – ${confirmLink}` : "   ⚠️ _Not confirmed_");
    }
    return lines.join("\n");
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

/** Entries in list order: by appointment, soonest (or oldest) first. */
export async function buildEntries(orders: RuleOrder[], details: Map<number, OrderContactDetails> | null): Promise<SummaryEntry[]> {
  const sorted = [...orders].sort((a, b) =>
    (a.appointmentTime?.getTime() ?? Infinity) - (b.appointmentTime?.getTime() ?? Infinity) || a.id - b.id);
  return Promise.all(sorted.map(async (order) => ({
    order,
    details: details?.get(order.id) ?? null,
    confirmLink: isAwaitingConfirmation(order.orderStatus) ? await safeConfirmationUrl(order.id) : null,
  })));
}

/**
 * The variables a summary template can use. The tomorrow_* / today_* /
 * digest_date names keep templates written for the earlier evening list working.
 */
export function summaryVariables(labName: string, rule: MessageRule, entries: SummaryEntry[], now: Date, timeZone: string): TemplateVariables {
  const listDay = rule.summaryScope === "APPOINTMENT_TOMORROW" ? new Date(now.getTime() + 86_400_000) : now;
  const pending = entries.filter((entry) => isAwaitingConfirmation(entry.order.orderStatus)).length;
  const list = orderListBlock(entries, rule, now, timeZone);
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
