/**
 * The vault (DESIGN.md §4.12, decision 6): portal logins encrypted at rest.
 *
 * Two ways to hold the key, chosen by what is set in the environment:
 *   AGENT_VAULT_KEY          one secret shared by the web app and the portal
 *                            worker (AES-256-GCM, key = sha256 of the secret).
 *                            Simplest: set the same value on both services.
 *   AGENT_VAULT_PUBLIC_KEY / AGENT_VAULT_PRIVATE_KEY
 *                            RSA pair: the web app can STORE a secret but never
 *                            read one back; only the portal worker decrypts.
 * Either way every read writes an access row.
 *
 * Generate the RSA pair once (if you want the split):
 *   node -e "const c=require('crypto');const {publicKey,privateKey}=c.generateKeyPairSync('rsa',{modulusLength:3072});
 *   console.log(publicKey.export({type:'spki',format:'pem'}));console.log(privateKey.export({type:'pkcs8',format:'pem'}))"
 */
import { createCipheriv, createDecipheriv, createHash, publicEncrypt, privateDecrypt, randomBytes, constants } from "node:crypto";
import prisma from "@/lib/db/client";

export type PortalLogin = { username: string; password: string; otpHint?: string | null };

const pem = (v: string | undefined) => v?.replace(/\\n/g, "\n");

/** The shared symmetric key, when AGENT_VAULT_KEY is set. */
const sharedKey = () => (process.env.AGENT_VAULT_KEY ? createHash("sha256").update(process.env.AGENT_VAULT_KEY).digest() : null);

export function vaultCanStore(): boolean { return !!sharedKey() || !!pem(process.env.AGENT_VAULT_PUBLIC_KEY); }
export function vaultCanRead(): boolean { return !!sharedKey() || !!pem(process.env.AGENT_VAULT_PRIVATE_KEY); }
/** What to set, for the screen that reports a vault that cannot store. */
export const VAULT_SETUP_HINT = "set AGENT_VAULT_KEY (one secret, on the app and the portal worker) or the AGENT_VAULT_PUBLIC_KEY / PRIVATE_KEY pair";

export async function storePortalLogin(labId: number, login: PortalLogin, setBy: number | null, config?: Record<string, unknown>): Promise<string> {
  const pub = pem(process.env.AGENT_VAULT_PUBLIC_KEY);
  const shared = sharedKey();
  if (!pub && !shared) throw new Error(`The vault has no key; ${VAULT_SETUP_HINT}`);
  // RSA split when a public key is set; otherwise the shared key (keyVersion 2, no wrapped key).
  const key = pub ? randomBytes(32) : shared!; const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(login), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const wrappedKey = pub ? publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key) : null;
  await prisma.agentSecret.updateMany({ where: { labId, kind: "PORTAL_LOGIN", active: true }, data: { active: false } });
  const row = await prisma.agentSecret.create({ data: { labId, kind: "PORTAL_LOGIN", ciphertext, iv, authTag, wrappedKey, config: (config ?? {}) as object, keyVersion: pub ? 1 : 2, setBy } });
  return row.id;
}

/** Portal worker only. */
export async function readPortalLogin(labId: number, job: string): Promise<{ login: PortalLogin; config: Record<string, unknown>; secretId: string } | null> {
  const priv = pem(process.env.AGENT_VAULT_PRIVATE_KEY);
  const shared = sharedKey();
  if (!priv && !shared) throw new Error(`This process cannot read the vault; ${VAULT_SETUP_HINT}`);
  const row = await prisma.agentSecret.findFirst({ where: { labId, kind: "PORTAL_LOGIN", active: true }, orderBy: { setAt: "desc" } });
  if (!row) return null;
  let key: Buffer;
  if (row.wrappedKey) {
    if (!priv) throw new Error("This login was stored with the RSA vault; AGENT_VAULT_PRIVATE_KEY is not set in this process");
    key = privateDecrypt({ key: priv, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(row.wrappedKey));
  } else {
    if (!shared) throw new Error("This login was stored with the shared key; AGENT_VAULT_KEY is not set in this process");
    key = shared;
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv));
  decipher.setAuthTag(Buffer.from(row.authTag));
  const plain = Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]).toString("utf8");
  await prisma.agentSecretAccess.create({ data: { secretId: row.id, job } });
  return { login: JSON.parse(plain) as PortalLogin, config: (row.config as Record<string, unknown>) ?? {}, secretId: row.id };
}
