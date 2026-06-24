// Diagnose one order: its live labstack status vs the open OpsFlow tasks
// against it, and whether each task SHOULD be auto-retired (order status
// no longer in the rule's triggerCondition.statusIn).
// Usage: docker compose exec -e ORDER_ID=59186 app node /app/diagnose_order.js
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const ls = new PrismaClient({ datasources: { db: { url: process.env.SOURCE_DATABASE_URL } } });
const ORDER_ID = parseInt(process.env.ORDER_ID || "0", 10);

(async () => {
  // 1. Live order status from labstack (by-PK, safe even mid-storm)
  const ord = await ls.$queryRawUnsafe(
    `SELECT id, "orderStatus"::text AS status, "appointmentTime", "statusUpdatedAt"
     FROM public."Order" WHERE id = $1`, ORDER_ID);
  console.log("LABSTACK order:", ord[0] || "(not found)");

  // 2. Open OpsFlow tasks for this entity + their rule's statusIn
  const tasks = await p.task.findMany({
    where: { entityId: ORDER_ID, isArchived: false },
    select: {
      id: true, status: true, taskRuleId: true, createdAt: true,
      taskRule: { select: { name: true, triggerType: true, triggerCondition: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const liveStatus = ord[0]?.status ?? "<order-not-found>";
  const now = Date.now();
  console.log(`\n${tasks.length} task(s) on order ${ORDER_ID} (live status = ${liveStatus}):`);
  for (const t of tasks) {
    const cond = (t.taskRule?.triggerCondition || {});
    const statusIn = Array.isArray(cond.statusIn) ? cond.statusIn : [];
    const ageMin = Math.round((now - new Date(t.createdAt).getTime()) / 60000);
    const shouldRetire = statusIn.length > 0 && !statusIn.includes(liveStatus)
      && !["COMPLETED", "CANCELLED"].includes(t.status);
    console.log(`  task#${t.id} [${t.status}] rule="${t.taskRule?.name}"`);
    console.log(`     statusIn=${JSON.stringify(statusIn)}  ageMin=${ageMin}  SHOULD_RETIRE=${shouldRetire}${shouldRetire && ageMin < 10 ? " (but within 10-min grace — next cycle)" : ""}`);
  }
  await p.$disconnect(); await ls.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
