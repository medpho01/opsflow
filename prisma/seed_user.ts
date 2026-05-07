import { PrismaClient, UserRole } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";

const prisma = new PrismaClient();

async function main() {
  const password = await hashPassword("changeme123");
  const user = await prisma.user.upsert({
    where: { email: "admin@opsflow.local" },
    update: {},
    create: {
      name: "Ops Head",
      email: "admin@opsflow.local",
      passwordHash: password,
      role: UserRole.OPS_HEAD,
      isActive: true,
    },
  });
  console.log("✅ Admin user created/updated:", user.email);
  console.log("   Password: changeme123");
}

main()
  .catch((e) => {
    console.error("❌ Error:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
