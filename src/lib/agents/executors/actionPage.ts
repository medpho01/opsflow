/** The durable per-order action page link for labs and phlebos (FR-8.4, FR-8.8): the encrypted order id the confirmation link already uses. */
import { encryptOrderId, ConfirmationLinkConfigError } from "@/lib/non-api-labs/confirmation-link";

export async function actionPageUrl(orderId: number): Promise<string | null> {
  const base = process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.PROVIDER_ACTION_BASE_URL;
  if (!base) return null;
  try { return `${base.replace(/\/$/, "")}/provider/order/${await encryptOrderId(orderId)}`; }
  catch (error) { if (error instanceof ConfirmationLinkConfigError) return null; throw error; }
}
