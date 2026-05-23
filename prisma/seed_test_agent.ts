/**
 * Seed a test agent + assign a chunk of existing tasks to them.
 *
 * Creates:
 *   - User    agent@opsflow.local / agent123   (role: OPS_AGENT)
 *   - TeamMember row linking that user (required for assignment paths
 *     that go through teamMemberId)
 *
 * Then reassigns the first ~10 non-completed tasks to this agent so you
 * have something to look at in Smart View.
 *
 * Idempotent. Re-runs:
 *   - upsert the user, reset the password to agent123
 *   - upsert the team member
 *   - re-assign the latest 10 non-terminal tasks
 *
 * Run inside the app container:
 *   docker cp prisma/seed_test_agent.ts taskos-app-1:/app/prisma/
 *   docker compose exec app node node_modules/.bin/tsx prisma/seed_test_agent.ts
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient, TaskStatus, UserRole } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";

const prisma = new PrismaClient();

const EMAIL = "agent@opsflow.local";
const PASSWORD = "agent123";
const NAME = "Test Agent";
const ASSIGN_COUNT = 10;

async function main() {
  console.log("🌱  Seeding test agent + assigning tasks…");

  // 1. Upsert the user
  const passwordHash = await hashPassword(PASSWORD);
  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: { passwordHash, isActive: true, name: NAME, role: UserRole.OPS_AGENT },
    create: {
      name: NAME,
      email: EMAIL,
      passwordHash,
      role: UserRole.OPS_AGENT,
      isActive: true,
    },
  });
  console.log(`  ✔ User    id=${user.id}  ${user.email}`);

  // 2. Upsert the team member (engine + roster paths need this)
  const member = await prisma.teamMember.upsert({
    where: { userId: user.id },
    update: { isActive: true },
    create: {
      userId: user.id,
      isActive: true,
    },
  });
  console.log(`  ✔ TeamMember id=${member.id}`);

  // 3. Assign the latest N non-terminal tasks to this agent
  const NON_TERMINAL: TaskStatus[] = [
    TaskStatus.CREATED,
    TaskStatus.ASSIGNED,
    TaskStatus.IN_PROGRESS,
  ];
  const candidates = await prisma.task.findMany({
    where: { status: { in: NON_TERMINAL }, isArchived: false },
    orderBy: { createdAt: "desc" },
    take: ASSIGN_COUNT,
    select: { id: true, title: true },
  });
  if (candidates.length === 0) {
    console.log("  ⚠  No non-terminal tasks found to assign. Run prisma/seed_test_tasks.ts first.");
  } else {
    const result = await prisma.task.updateMany({
      where: { id: { in: candidates.map((t) => t.id) } },
      data: {
        assignedToId: user.id,
        teamMemberId: member.id,
        status: TaskStatus.ASSIGNED,
        assignedAt: new Date(),
        assignmentMethod: "manual",
      },
    });
    console.log(`  ✔ Assigned ${result.count} tasks to ${user.name}`);
    candidates.forEach((t) => console.log(`     · #${t.id}  ${t.title}`));
  }

  console.log("\n✅  Done.");
  console.log(`\n   Login:   ${EMAIL}`);
  console.log(`   Pass:    ${PASSWORD}`);
  console.log(`   Then go to:  http://localhost:3000/agent/smart-view\n`);
}

main()
  .catch((e) => { console.error("❌ ", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
