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
 * Web Crypto rather than Node's crypto module: this is reached from the
 * every-minute runner, which webpack also bundles for instrumentation, and a
 * `node:` import fails that build — the reason the rest of this directory uses
 * globalThis.crypto too. AES-CBC here pads with PKCS#7, as Node's default does.
 *
 * The secret is LabStack's, so it is read from the environment and never
 * committed — this repository is public.
 */
const DEFAULT_BASE_URL = "https://console.labstack.in/confirmation";

export class ConfirmationLinkConfigError extends Error {}

async function keyFrom(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) {
    throw new ConfirmationLinkConfigError(
      "LABSTACK_CONFIRMATION_KEY is not set — order confirmation links cannot be created",
    );
  }
  // LabStack checks .length (characters) and uses Buffer.from(key) (UTF-8
  // bytes). AES-256 needs exactly 32 bytes, which only an ASCII key gives.
  const bytes = new TextEncoder().encode(secret);
  if (secret.length !== 32 || bytes.length !== 32) {
    throw new ConfirmationLinkConfigError("LABSTACK_CONFIRMATION_KEY must be exactly 32 ASCII characters");
  }
  return globalThis.crypto.subtle.importKey("raw", bytes, { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toUrlSafe(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "%3D").replace(/:/g, "%3A");
}

function fromUrlSafe(value: string): string {
  return value.replace(/-/g, "+").replace(/_/g, "/").replace(/%3D/g, "=").replace(/%3A/g, ":");
}

/** The URL-safe token for one order. A fresh IV each call, so tokens differ. */
export async function encryptOrderId(orderId: number | string, secret = process.env.LABSTACK_CONFIRMATION_KEY): Promise<string> {
  const key = await keyFrom(secret);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const encrypted = new Uint8Array(
    await globalThis.crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, new TextEncoder().encode(String(orderId))),
  );
  return toUrlSafe(`${toBase64(iv)}:${toBase64(encrypted)}`);
}

/** Inverse of encryptOrderId — LabStack's decrypt(). Used by tests and support checks. */
export async function decryptOrderToken(token: string, secret = process.env.LABSTACK_CONFIRMATION_KEY): Promise<string> {
  const key = await keyFrom(secret);
  const [ivBase64, encryptedBase64] = fromUrlSafe(token).split(":");
  if (!ivBase64 || !encryptedBase64) throw new Error("Malformed confirmation token");
  const decrypted = await globalThis.crypto.subtle.decrypt(
    { name: "AES-CBC", iv: fromBase64(ivBase64) }, key, fromBase64(encryptedBase64),
  );
  return new TextDecoder().decode(decrypted);
}

/** https://console.labstack.in/confirmation/<token> */
export async function confirmationUrl(orderId: number | string, secret = process.env.LABSTACK_CONFIRMATION_KEY): Promise<string> {
  const base = (process.env.LABSTACK_CONFIRMATION_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  return `${base}/${await encryptOrderId(orderId, secret)}`;
}
