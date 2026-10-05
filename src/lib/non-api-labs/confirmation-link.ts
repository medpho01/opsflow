/**
 * The LabStack order-confirmation link a provider taps to confirm an order.
 *
 * The page lives in the LabStack console, not here: it decrypts the order id
 * from the URL and lets the lab confirm, which moves the order to
 * ORDER_SCHEDULED. OpsFlow only has to mint a URL that page can read, so this
 * mirrors LabStack's own `encrypt()` exactly:
 *
 *   AES-256-CBC, key = the 32 UTF-8 characters of the shared secret,
 *   random 16-byte IV, payload = the order id as a decimal string,
 *   base64(iv) + ":" + base64(ciphertext), then made URL-safe with
 *   "+" → "-", "/" → "_", "=" → "%3D", ":" → "%3A".
 *
 * The secret is LabStack's, so it is read from the environment and never
 * committed — this repository is public.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const DEFAULT_BASE_URL = "https://console.labstack.in/confirmation";

export class ConfirmationLinkConfigError extends Error {}

function keyFrom(secret: string | undefined): Buffer {
  if (!secret) {
    throw new ConfirmationLinkConfigError(
      "LABSTACK_CONFIRMATION_KEY is not set — order confirmation links cannot be created",
    );
  }
  // LabStack checks .length (characters) and uses Buffer.from(key) (UTF-8
  // bytes). AES-256 needs exactly 32 bytes, which only an ASCII key gives.
  const key = Buffer.from(secret, "utf8");
  if (secret.length !== 32 || key.length !== 32) {
    throw new ConfirmationLinkConfigError("LABSTACK_CONFIRMATION_KEY must be exactly 32 ASCII characters");
  }
  return key;
}

function toUrlSafe(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "%3D").replace(/:/g, "%3A");
}

function fromUrlSafe(value: string): string {
  return value.replace(/-/g, "+").replace(/_/g, "/").replace(/%3D/g, "=").replace(/%3A/g, ":");
}

/** The URL-safe token for one order. A fresh IV each call, so tokens differ. */
export function encryptOrderId(orderId: number | string, secret = process.env.LABSTACK_CONFIRMATION_KEY): string {
  const key = keyFrom(secret);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = cipher.update(String(orderId), "utf8", "base64") + cipher.final("base64");
  return toUrlSafe(`${iv.toString("base64")}:${encrypted}`);
}

/** Inverse of encryptOrderId — LabStack's decrypt(). Used by tests and support checks. */
export function decryptOrderToken(token: string, secret = process.env.LABSTACK_CONFIRMATION_KEY): string {
  const key = keyFrom(secret);
  const [ivBase64, encryptedBase64] = fromUrlSafe(token).split(":");
  if (!ivBase64 || !encryptedBase64) throw new Error("Malformed confirmation token");
  const decipher = createDecipheriv("aes-256-cbc", key, Buffer.from(ivBase64, "base64"));
  return decipher.update(encryptedBase64, "base64", "utf8") + decipher.final("utf8");
}

/** https://console.labstack.in/confirmation/<token> */
export function confirmationUrl(orderId: number | string, secret = process.env.LABSTACK_CONFIRMATION_KEY): string {
  const base = (process.env.LABSTACK_CONFIRMATION_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  return `${base}/${encryptOrderId(orderId, secret)}`;
}
