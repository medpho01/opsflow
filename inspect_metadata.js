const { PrismaClient } = require("./src/generated/prisma");

const prisma = new PrismaClient();

async function inspectMetadata() {
  // Get a few tasks with their metadata
  const tasks = await prisma.task.findMany({
    where: {
      isArchived: false,
      status: "COMPLETED"
    },
    select: {
      id: true,
      title: true,
      metadata: true,
      createdAt: true,
      entityId: true
    },
    take: 5
  });

  console.log("Sample tasks with metadata:");
  tasks.forEach(task => {
    console.log("\n---");
    console.log(`Task ID: ${task.id}`);
    console.log(`Title: ${task.title}`);
    console.log(`Entity ID (Order): ${task.entityId}`);
    console.log(`Created: ${task.createdAt}`);
    console.log(`Metadata:`, JSON.stringify(task.metadata, null, 2));
  });

  await prisma.$disconnect();
}

inspectMetadata().catch(console.error);
