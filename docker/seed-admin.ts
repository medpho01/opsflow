/**
 * Minimal Docker bootstrap seed — creates exactly one OPS_HEAD admin user.
 *
 * Idempotent. Safe to run on every container start. The full operational
 * seed (skill tags, task types, rules, escalation chain) lives in
 * prisma/seed.ts and is intentionally NOT run here — those are
 * configurable from the UI and shouldn't be force-set on every deploy.
 *
 * Configurable via env (with sensible defaults so a fresh `docker compose up`
 * works without any extra setup):
 *   ADMIN_EMAIL    — default "admin@opsflow.local"
 *   ADMIN_PASSWORD — default "changeme123" (printed on success — change it)
 *   ADMIN_NAME     — default "Admin"
 */
import { PrismaClient, UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@opsflow.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "changeme123";
const ADMIN_NAME = process.env.ADMIN_NAME ?? "Admin";

async function main() {
  const prisma = new PrismaClient();
  try {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const user = await prisma.user.upsert({
      where: { email: ADMIN_EMAIL },
      update: { isActive: true },        // re-activate if previously soft-disabled
      create: {
        email: ADMIN_EMAIL,
        name: ADMIN_NAME,
        role: UserRole.OPS_HEAD,
        passwordHash,
        isActive: true,
      },
    });
    console.log(`✔ admin ready: ${user.email} (id=${user.id})`);
    if (ADMIN_PASSWORD === "changeme123") {
      console.log("  password: changeme123  ← change this in production via ADMIN_PASSWORD env");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("✘ admin seed failed:", err);
  process.exit(1);
});
