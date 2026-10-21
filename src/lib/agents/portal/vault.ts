/**
 * The vault (DESIGN.md §4.12, decision 6): portal logins encrypted at rest so
 * the web app can STORE a secret but never read one back. Hybrid encryption:
 * a random AES-256-GCM key per secret, wrapped with the vault's RSA public
 * key. The web app holds AGENT_VAULT_PUBLIC_KEY; only the portal worker holds
 * AGENT_VAULT_PRIVATE_KEY. Every unwrap writes an access row.
 *
 * Generate a key pair once:
 *   node -e "const c=require('crypto');const {publicKey,privateKey}=c.generateKeyPairSync('rsa',{modulusLength:3072});
 *   console.log(publicKey.export({type:'spki',format:'pem'}));console.log(privateKey.export({type:'pkcs8',format:'pem'}))"
 */
import { createCipheriv, createDecipheriv, publicEncrypt, privateDecrypt, randomBytes, constants } from "node:crypto";
import prisma from "@/lib/db/client";

export type PortalLogin = { username: string; password: string; otpHint?: string | null };

const pem = (v: string | undefined) => v?.replace(/\\n/g, "\n");

export function vaultCanStore(): boolean { return !!pem(process.env.AGENT_VAULT_PUBLIC_KEY); }
export function vaultCanRead(): boolean { return !!pem(process.env.AGENT_VAULT_PRIVATE_KEY); }

export async function storePortalLogin(labId: number, login: PortalLogin, setBy: number | null, config?: Record<string, unknown>): Promise<string> {
  const pub = pem(process.env.AGENT_VAULT_PUBLIC_KEY);
  if (!pub) throw new Error("AGENT_VAULT_PUBLIC_KEY is not set; the vault cannot store a secret");
  const key = randomBytes(32); const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(login), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const wrappedKey = publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  await prisma.agentSecret.updateMany({ where: { labId, kind: "PORTAL_LOGIN", active: true }, data: { active: false } });
  const row = await prisma.agentSecret.create({ data: { labId, kind: "PORTAL_LOGIN", ciphertext, iv, authTag, wrappedKey, config: (config ?? {}) as object, keyVersion: 1, setBy } });
  return row.id;
}

/** Portal worker only. */
export async function readPortalLogin(labId: number, job: string): Promise<{ login: PortalLogin; config: Record<string, unknown>; secretId: string } | null> {
  const priv = pem(process.env.AGENT_VAULT_PRIVATE_KEY);
  if (!priv) throw new Error("AGENT_VAULT_PRIVATE_KEY is not set in this process");
  const row = await prisma.agentSecret.findFirst({ where: { labId, kind: "PORTAL_LOGIN", active: true }, orderBy: { setAt: "desc" } });
  if (!row || !row.wrappedKey) return null;
  const key = privateDecrypt({ key: priv, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(row.wrappedKey));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv));
  decipher.setAuthTag(Buffer.from(row.authTag));
  const plain = Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]).toString("utf8");
  await prisma.agentSecretAccess.create({ data: { secretId: row.id, job } });
  return { login: JSON.parse(plain) as PortalLogin, config: (row.config as Record<string, unknown>) ?? {}, secretId: row.id };
}
