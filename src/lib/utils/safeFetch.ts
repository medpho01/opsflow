/**
 * Safe fetch for EXTERNAL, UNTRUSTED URLs (e.g. call-recording downloads whose
 * URL can arrive from the unauthenticated Exotel webhook).
 *
 * Threat: a forged webhook can set recordingUrl to an internal target
 * (http://169.254.169.254/… cloud metadata, http://whisper:8000, http://db:5432)
 * and, when the server fetches it, leak credentials or hit internal services
 * (SSRF). This helper closes that:
 *   • https only
 *   • the resolved host must NOT map to a private / loopback / link-local /
 *     reserved IP (blocks metadata + in-cluster services)
 *   • redirects are NOT followed (so a public host can't 3xx to an internal one)
 *   • hard timeout + response size cap (prevents slow-loris / memory blowup)
 *   • optional exact-host allowlist (defense-in-depth) via caller
 */
import { lookup } from "node:dns/promises";
import net from "node:net";

/** True if an IPv4/IPv6 literal is loopback / private / link-local / reserved. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;      // this-net, private, loopback
    if (a === 169 && b === 254) return true;                // link-local incl. 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;       // private
    if (a === 192 && b === 168) return true;                // private
    if (a === 100 && b >= 64 && b <= 127) return true;      // CGNAT
    if (a >= 224) return true;                              // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === "::1" || s === "::") return true;             // loopback / unspecified
    if (s.startsWith("fe80")) return true;                  // link-local
    if (s.startsWith("fc") || s.startsWith("fd")) return true; // unique-local
    const mapped = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true; // unparseable → treat as unsafe
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** If non-empty, the URL hostname must be an exact (case-insensitive) match. */
  allowedHosts?: string[];
}

/**
 * Download an untrusted external resource as an ArrayBuffer, or throw. See the
 * file header for the guarantees. Never pass an internal/trusted URL through
 * here expecting it to succeed — private targets are intentionally rejected.
 */
export async function fetchExternalResource(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<ArrayBuffer> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxBytes ?? 25 * 1024 * 1024;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "https:") throw new Error(`blocked non-https URL (${url.protocol})`);
  const host = url.hostname.toLowerCase();
  if (opts.allowedHosts && opts.allowedHosts.length > 0 && !opts.allowedHosts.includes(host)) {
    throw new Error(`host not in allowlist: ${host}`);
  }

  // Resolve and reject any private/reserved address (blocks metadata + internal
  // services even when the hostname itself looks public).
  const addrs = await lookup(url.hostname, { all: true });
  if (addrs.length === 0) throw new Error(`could not resolve ${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error(`blocked private/reserved address ${a.address} for ${host}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // redirect:"manual" — a 3xx must NOT be auto-followed to a re-validated host.
    const res = await fetch(url, { redirect: "manual", signal: controller.signal });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      throw new Error(`blocked redirect (status ${res.status})`);
    }
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);

    const declared = res.headers.get("content-length");
    if (declared && Number(declared) > maxBytes) {
      throw new Error(`resource too large (content-length ${declared} > ${maxBytes})`);
    }
    if (!res.body) return await res.arrayBuffer();

    // Stream with a hard byte cap so a lying/absent content-length can't blow up.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`resource exceeded size cap (${maxBytes} bytes)`);
        }
        chunks.push(value);
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out.buffer;
  } finally {
    clearTimeout(timer);
  }
}
