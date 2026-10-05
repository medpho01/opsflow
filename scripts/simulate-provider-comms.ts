/**
 * Local end-to-end simulation of every provider communication.
 *
 *   SIM_MODE=LIVE|SHADOW npx tsx scripts/simulate-provider-comms.ts
 *
 * Needs two THROWAWAY databases and refuses to run otherwise:
 *   SOURCE_DATABASE_URL  a LabStack copy whose name ends in "_sim"  (it is modified!)
 *   DATABASE_URL         an OpsFlow DB whose name contains "scratch" or "_sim"
 *
 * Building the two databases from a local LabStack copy (`labstack`):
 *
 *   createdb labstack_sim
 *   pg_dump -s -d labstack | psql -q -d labstack_sim
 *   pg_dump -a --disable-triggers -d labstack -t 'public."Order"' -t 'public."User"' \
 *     -t 'public."Profile"' -t 'public."Lab"' -t 'public."Store"' -t 'public."Package"' \
 *     -t 'public."_OrderToPackage"' -t 'public."Master"' -t 'public."_MasterToPackage"' \
 *     -t 'public."_MasterToOrder"' -t 'public."OrderMetrics"' | psql -q -d labstack_sim
 *   createdb opsflow_sim_scratch
 *   DATABASE_URL=".../opsflow_sim_scratch?schema=taskos" npx prisma db push --skip-generate
 *
 * Run with LABSTACK_CONFIRMATION_KEY set (any 32 characters will do locally).
 * Re-create opsflow_sim_scratch between runs; labstack_sim can be reused.
 *
 * It shifts a handful of real orders of one lab to times relative to now, then
 * runs the real code paths — the poller's new-order step, the every-minute
 * tick (poll replies, message rules / legacy scheduler, deadline watchers,
 * evening list), a forced evening list and a simulated poll reply — and
 * reports what was queued for WhatsApp. Nothing is sent: with no gateway
 * running, messages stop in wa_outbound. Patient names are never printed.
 */
import prisma from "@/lib/db/client";
import { labstack } from "@/lib/db/labstack";
import { fetchAllActiveOrders } from "@/lib/engine/labstack";
import { startDetectedNonApiLabWorkflows } from "@/lib/non-api-labs/workflow";
import { runNonApiLabTick } from "@/lib/non-api-labs/runner";
import { setMessageRulesMode } from "@/lib/provider-rules/engine";
import { sendDigestForLab } from "@/lib/provider-comms/daily-digest";

const MODE = (process.env.SIM_MODE ?? "LIVE") as "LIVE" | "SHADOW";
const LAB_ID = Number(process.env.SIM_LAB_ID ?? 5);

function guard() {
  const source = process.env.SOURCE_DATABASE_URL ?? "";
  const target = process.env.DATABASE_URL ?? "";
  const dbName = (url: string) => url.split("/").pop()?.split("?")[0] ?? "";
  if (!dbName(source).endsWith("_sim")) throw new Error(`Refusing: SOURCE_DATABASE_URL must be a *_sim copy (got "${dbName(source)}")`);
  if (!/scratch|_sim/.test(dbName(target))) throw new Error(`Refusing: DATABASE_URL must be a scratch DB (got "${dbName(target)}")`);
}

type Scenario = { key: string; expect: string; status: string; createdAgoMin: number; apptInMin: number | null };
const SCENARIOS: Scenario[] = [
  { key: "A new order", expect: "new-order message", status: "CREATED", createdAgoMin: 1, apptInMin: 240 },
  { key: "B 61 min old, unconfirmed", expect: "new-order + 1h reminder", status: "CREATED", createdAgoMin: 61, apptInMin: 300 },
  { key: "C 3h old, unconfirmed", expect: "new-order + 3h reminder (1h too late)", status: "CREATED", createdAgoMin: 181, apptInMin: 360 },
  { key: "D appointment 31 min ago", expect: "status check + poll", status: "ORDER_SCHEDULED", createdAgoMin: 4320, apptInMin: -31 },
  { key: "E collected", expect: "nothing", status: "SAMPLE_COLLECTED", createdAgoMin: 4320, apptInMin: -31 },
  { key: "F cancelled", expect: "nothing", status: "CANCELED", createdAgoMin: 120, apptInMin: -31 },
  { key: "G tomorrow", expect: "in the evening list", status: "ORDER_SCHEDULED", createdAgoMin: 4320, apptInMin: null },
];

async function prepareLabStack(): Promise<Map<string, number>> {
  const candidates = await labstack.$queryRawUnsafe<Array<{ id: number }>>(
    `SELECT o.id FROM public."Order" o
      WHERE o."labId" = $1 AND o."orderType" = 'HOME_SAMPLE'
        AND EXISTS (SELECT 1 FROM public."Profile" p WHERE p."profileUserId" = o."userId")
        AND EXISTS (SELECT 1 FROM public."_OrderToPackage" op WHERE op."A" = o.id)
      ORDER BY o.id DESC LIMIT $2`, LAB_ID, SCENARIOS.length);
  if (candidates.length < SCENARIOS.length) throw new Error(`Lab ${LAB_ID} has too few usable orders`);
  // Park every other order of this lab far in the past, so only the scenarios are in play.
  await labstack.$executeRawUnsafe(
    `UPDATE public."Order" SET "orderStatus" = 'REPORT_DELIVERED' WHERE "labId" = $1 AND id <> ALL($2::int[])`,
    LAB_ID, candidates.map((c) => c.id));
  const ids = new Map<string, number>();
  for (const [index, scenario] of SCENARIOS.entries()) {
    const id = candidates[index].id;
    ids.set(scenario.key, id);
    const appt = scenario.apptInMin === null
      // Tomorrow 08:00 IST = 02:30 UTC.
      ? `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day 8 hours') AT TIME ZONE 'Asia/Kolkata' AT TIME ZONE 'UTC'`
      : `(now() AT TIME ZONE 'UTC') + make_interval(mins => ${scenario.apptInMin})`;
    await labstack.$executeRawUnsafe(
      `UPDATE public."Order"
          SET "orderStatus" = $2::text::"OrderStatus",
              "createdAt" = (now() AT TIME ZONE 'UTC') - make_interval(mins => $3::int),
              "statusUpdatedAt" = (now() AT TIME ZONE 'UTC') - make_interval(mins => $3::int),
              "updatedAt" = now() AT TIME ZONE 'UTC',
              "appointmentTime" = ${appt}
        WHERE id = $1`, id, scenario.status, scenario.createdAgoMin);
  }
  return ids;
}

async function prepareOpsFlow() {
  await prisma.waGroup.create({ data: { jid: "120363000000000001@g.us", subject: "LS<>Sim lab", active: true, sendEnabled: true, isMember: true, accountNumber: "910000000000" } });
  await prisma.nonApiLabConfig.create({ data: {
    labId: LAB_ID, labName: "Sim lab", waGroupJid: "120363000000000001@g.us", dailyDigestEnabled: true,
    // Configured two days ago: the 1h/3h orders came after it, D/E/G before.
    createdAt: new Date(Date.now() - 2 * 86_400_000),
  } });
  await setMessageRulesMode(MODE === "LIVE" ? "LIVE" : "SHADOW");
}

async function report(label: string, since: Date, ids: Map<string, number>) {
  const byOrder = new Map([...ids].map(([key, id]) => [id, key]));
  const sent = await prisma.labCommunication.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
  const rules = new Map((await prisma.providerMessageRule.findMany()).map((rule) => [rule.id, rule.name]));
  console.log(`\n── ${label}: ${sent.length} message(s) queued`);
  for (const message of sent) {
    const outbound = message.waOutboundId ? await prisma.waOutbound.findUnique({ where: { id: message.waOutboundId } }) : null;
    const who = message.orderId ? byOrder.get(message.orderId) ?? `order ${message.orderId}` : "lab (whole day)";
    const by = message.ruleId ? rules.get(message.ruleId) ?? "legacy rule" : message.type === "REMINDER" || message.type === "ESCALATION" ? "legacy scheduler" : "built-in";
    console.log(`   ${who.padEnd(30)} ${message.type.padEnd(20)} ${message.templateKey.padEnd(28)} ${outbound?.pollName ? "+poll " : "      "}via ${by}`);
  }
  const shadow = await prisma.providerMessageLedger.findMany({ where: { shadow: true, createdAt: { gte: since } } });
  for (const row of shadow) {
    console.log(`   ${(byOrder.get(row.entityId) ?? row.entityId).toString().padEnd(30)} SHADOW ${row.outcome.padEnd(14)} ${rules.get(row.ruleId)}`);
  }
  const missed = await prisma.providerMessageLedger.findMany({ where: { shadow: false, outcome: "MISSED", createdAt: { gte: since } } });
  for (const row of missed) console.log(`   ${(byOrder.get(row.entityId) ?? row.entityId).toString().padEnd(30)} too late, skipped     ${rules.get(row.ruleId)}`);
}

async function main() {
  guard();
  console.log(`Simulating with the message rules engine in ${MODE} mode, lab ${LAB_ID}.`);
  const ids = await prepareLabStack();
  await prepareOpsFlow();
  for (const s of SCENARIOS) console.log(`   ${s.key.padEnd(30)} expect: ${s.expect}`);

  // 1. The poller's new-order step, as a poll cycle runs it.
  let mark = new Date();
  const orders = await fetchAllActiveOrders();
  await startDetectedNonApiLabWorkflows(orders.filter((order) => order.labId === LAB_ID));
  await report("Poller: new orders", mark, ids);
  // Pretend each new-order message went out when its order arrived, as it
  // would have in production (the poller runs every few minutes).
  for (const id of ids.values()) {
    const workflow = await prisma.labCommunicationWorkflow.findUnique({ where: { orderId: id } });
    if (!workflow) continue;
    const order = orders.find((o) => o.id === id)!;
    const sentAt = new Date(new Date(order.createdAt).getTime() + 60_000);
    await prisma.labCommunication.updateMany({ where: { workflowId: workflow.id, type: "INITIAL_NOTIFICATION" }, data: { createdAt: sentAt, sentAt } });
  }

  // 2. The every-minute tick.
  mark = new Date();
  await runNonApiLabTick();
  await report("Tick 1", mark, ids);

  // 3. Again — nothing may repeat.
  mark = new Date();
  await runNonApiLabTick();
  await report("Tick 2 (must be empty)", mark, ids);

  // 4. A poll reply on the status check: "Rescheduled", then the lab's follow-up text.
  const check = await prisma.labCommunication.findFirst({ where: { templateKey: "NON_API_STATUS_CHECK" }, orderBy: { createdAt: "desc" } });
  if (check?.waOutboundId) {
    const outbound = await prisma.waOutbound.findUniqueOrThrow({ where: { id: check.waOutboundId } });
    await prisma.waPoll.create({ data: {
      waMsgId: `sim-${outbound.id}`, outboundId: outbound.id, workflowId: check.workflowId, options: outbound.pollOptions ?? [],
      messageJson: {}, status: "VOTED", votedLabel: "🔄 Rescheduled", voterJid: "sim-lab-user", votedAt: new Date(), awaitingReason: true,
    } });
    mark = new Date();
    await runNonApiLabTick();
    // Acknowledgements are queued straight to the outbox (no message-log row).
    const acks = await prisma.waOutbound.findMany({ where: { createdAt: { gte: mark } } });
    console.log(`\n── Poll reply 'Rescheduled': ${acks.length} acknowledgement(s) queued`);
    for (const ack of acks) console.log(`   ${ack.text.split("\n")[0].replace(/\(.*\)/, "(<patient>)")}`);
    await prisma.waPoll.update({ where: { waMsgId: `sim-${outbound.id}` }, data: { reason: "Tomorrow 9 am", reasonAt: new Date(), awaitingReason: false } });
    await runNonApiLabTick();
    const notes = await prisma.labCommunicationOrderEvent.findMany({ where: { workflowId: check.workflowId!, type: "PROVIDER_NOTE" } });
    console.log(`   timeline notes on that order: ${notes.length} (answer + follow-up)`);
  } else {
    console.log("\n── Poll reply: skipped (no status check was queued)");
  }

  // 5. The evening list, forced now.
  const config = await prisma.nonApiLabConfig.findUniqueOrThrow({ where: { labId: LAB_ID } });
  const digest = await sendDigestForLab(config, { force: true });
  const entries = (digest.text ?? "").split("\n").filter((line) => /^\*\d+\./.test(line)).length;
  console.log(`\n── Evening list: ${digest.outcome}, ${entries} order(s) listed for tomorrow`);
  // Shape only: names, addresses and map pins are real patient data in a LabStack copy.
  const masked = (digest.text ?? "").split("\n").map((line) =>
    /^\*\d+\./.test(line) ? line.replace(/ – .*$/, " – <patient>")
      : /^\s+📍/.test(line) ? "   📍 <address>"
        : /^\s+🗺️/.test(line) ? "   🗺️ <map link>"
          : line);
  console.log(masked.map((line) => `   | ${line}`).join("\n"));
}

main()
  .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); await labstack.$disconnect?.(); });
