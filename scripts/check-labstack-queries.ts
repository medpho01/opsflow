/**
 * Runs the non-API-lab / provider-comms LabStack queries against a REAL LabStack
 * database and reports PASS/FAIL per query. Typecheck, build and schema push never
 * execute this raw SQL, so a column or status that exists only in the dummy
 * LabStack schema (docker/labstack-dummy) passes every other check and fails in prod.
 *
 * Usage (read-only against LabStack):
 *   DATABASE_URL=<a taskos DB with the current schema> \
 *   SOURCE_DATABASE_URL=<real LabStack replica or copy> \
 *   npx tsx scripts/check-labstack-queries.ts
 */
import { loadCandidateOrders, loadOrdersByIds } from "@/lib/provider-comms/order-source";
import { loadDaySummaries, loadDaySchedule } from "@/lib/provider-comms/day-summary";
import { resolveLabIdsForOrders } from "@/lib/provider-comms/order-lab";
import { resolveMilestoneState } from "@/lib/provider-comms/milestones";

const LABS = (process.env.CHECK_LAB_IDS ?? "4,2,14").split(",").map(Number);
const MILESTONES = ["ORDER_CONFIRMED", "PHLEBO_ASSIGNED", "SAMPLE_COLLECTED", "SAMPLE_DELIVERED", "REPORT_UPLOADED"] as const;

async function step(name: string, fn: () => Promise<string>) {
  try { console.log(`PASS  ${name}: ${await fn()}`); }
  catch (e) { console.log(`FAIL  ${name}: ${e instanceof Error ? e.message.split("\n").slice(-2).join(" ") : e}`); }
}

(async () => {
  let ids: number[] = [];
  await step("loadCandidateOrders (breach detection)", async () => {
    const orders = await loadCandidateOrders(LABS, { lookbackDays: 400, lookaheadDays: 30 });
    ids = orders.slice(0, 50).map((o) => o.id);
    const withSample = orders.filter((o) => o.sampleCollectedAt).length;
    const withReport = orders.filter((o) => o.reportDeliveredAt).length;
    const withTests = orders.filter((o) => o.packageName).length;
    const unknown = new Map<string, number>();
    for (const o of orders) for (const m of MILESTONES) {
      const s = resolveMilestoneState(o, m as never);
      if (s.source.startsWith("UNKNOWN_STATUS")) unknown.set(o.orderStatus, (unknown.get(o.orderStatus) ?? 0) + 1);
    }
    return `${orders.length} live orders; sampleCollectedAt on ${withSample}, reportDeliveredAt on ${withReport}, tests on ${withTests}; unknown statuses: ${unknown.size ? JSON.stringify(Object.fromEntries(unknown)) : "none"}`;
  });
  await step("loadOrdersByIds (breach resolution)", async () => {
    const m = await loadOrdersByIds(ids);
    const sample = [...m.values()][0];
    return `${m.size}/${ids.length} found; e.g. #${sample?.id} ${sample?.orderStatus} tests="${(sample?.packageName ?? "").slice(0, 40)}"`;
  });
  await step("resolveLabIdsForOrders (task-breach alerts)", async () => `${(await resolveLabIdsForOrders(ids)).size} mapped`);
  await step("loadDaySummaries (daily digest counts)", async () => {
    const m = await loadDaySummaries(LABS, "Asia/Kolkata");
    return `${m.size} labs summarised`;
  });
  await step("loadDaySchedule (digest tomorrow list)", async () => `${(await loadDaySchedule(4, "Asia/Kolkata", 1, 20)).length} orders tomorrow for lab 4`);
  process.exit(0);
})();
