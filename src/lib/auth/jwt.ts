/**
 * JWT utilities using `jose` — works in both Node.js and Edge runtimes.
 * jose replaces jsonwebtoken so the middleware (Edge runtime) can verify tokens.
 */
import { SignJWT, jwtVerify } from "jose";
import { JwtPayload } from "@/types";

function getSecret() {
  return new TextEncoder().encode(
    process.env.JWT_SECRET ?? "taskos-jwt-secret-change-in-production"
  );
}

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
