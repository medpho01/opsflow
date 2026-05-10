/**
 * JWT utilities using `jose` — works in both Node.js and Edge runtimes.
 * jose replaces jsonwebtoken so the middleware (Edge runtime) can verify tokens.
 */
import { SignJWT, jwtVerify } from "jose";
import { JwtPayload } from "@/types";

// Sentinels: any value matching one of these is treated as "not set" — they
// are the placeholders shipped in .env.example, docker-compose.yml, the dev
// .env, and the previous in-code fallback. Booting with one of these in prod
// would let anyone with the source forge an OPS_HEAD token, so we fail fast.
const INSECURE_JWT_SECRETS = new Set([
  "taskos-jwt-secret-change-in-production",
  "please-change-me-in-production",
  "dev-please-change-in-prod",
  "change-me",
  "changeme",
  "secret",
]);

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || INSECURE_JWT_SECRETS.has(secret) || secret.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "JWT_SECRET is unset, a known placeholder, or too short (<32 chars). " +
        "Refusing to start in production. Set a strong random value."
      );
    }
    // Dev: warn loudly once, but don't crash hot-reload.
    if (!warnedAboutInsecureJwt) {
      // eslint-disable-next-line no-console
      console.warn(
        "[jwt] JWT_SECRET is missing or insecure — using a dev fallback. " +
        "Set a strong JWT_SECRET (≥32 chars) before deploying."
      );
      warnedAboutInsecureJwt = true;
    }
    return new TextEncoder().encode("dev-only-fallback-not-for-production-use");
  }
  return new TextEncoder().encode(secret);
}
let warnedAboutInsecureJwt = false;

const EXPIRES_IN = "8h";

export async function signToken(payload: JwtPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(EXPIRES_IN)
    .sign(getSecret());
}

export async function verifyToken(token: string): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as unknown as JwtPayload;
  } catch {
    return null;
  }
}
