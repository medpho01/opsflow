/**
 * WhatsApp alert sender.
 * Sends messages via the configured WhatsApp API (e.g. Meta Cloud API or Gupshup).
 * OpsFlow uses this for SLA breach escalations and urgent unassigned task alerts.
 *
 * Set WHATSAPP_API_URL and WHATSAPP_API_TOKEN in your .env to activate.
 * When either is blank, messages are logged to console only (dev / disabled mode).
 */

const WA_API_URL = process.env.WHATSAPP_API_URL ?? "";
const WA_API_TOKEN = process.env.WHATSAPP_API_TOKEN ?? "";

export interface WaMessage {
  to: string;      // phone number with country code, no +  e.g. "919876543210"
  body: string;    // text body
  taskId?: number; // optional for logging
}

export async function sendWhatsAppMessage(msg: WaMessage): Promise<boolean> {
  if (!WA_API_URL || !WA_API_TOKEN) {
    console.log(`[WhatsApp DISABLED] → ${msg.to}: ${msg.body}`);
    return false;
  }

  try {
    const res = await fetch(WA_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WA_API_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: msg.to,
        type: "text",
        text: { body: msg.body },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[WhatsApp] Send failed to ${msg.to}:`, err);
      return false;
    }

    console.log(`[WhatsApp] Sent to ${msg.to}: task #${msg.taskId}`);
    return true;
  } catch (e) {
    console.error("[WhatsApp] Network error:", e);
    return false;
  }
}

/**
 * Formats a standard SLA breach message.
 */
export function formatSlaBreachMessage(params: {
  taskTitle: string;
  orderId: number;
  patientName: string;
  assignedTo: string | null;
}): string {
  const assigneeLine = params.assignedTo
    ? `Assigned to: ${params.assignedTo}`
    : "⚠️ Currently unassigned";

  return [
    `🚨 *OpsFlow SLA Breach*`,
    ``,
    `Task: ${params.taskTitle}`,
    `Order: #${params.orderId} — ${params.patientName}`,
    `${assigneeLine}`,
    ``,
    `Please review and take action immediately.`,
  ].join("\n");
}
