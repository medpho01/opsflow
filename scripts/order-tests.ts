/**
 * What each order's packages hold (29 Oct 2026): every package with all its tests, and tests booked
 * on their own — to hand a manual lab the full list by hand. Prints no patient details.
 *
 *   docker compose -f docker-compose.yml -f docker-compose.wa.yml exec -T app npx tsx scripts/order-tests.ts 93170 93172
 */
import { fetchOrderContactDetails, testsForLab } from "@/lib/non-api-labs/order-details";

async function main() {
  const ids = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) { console.log("usage: scripts/order-tests.ts <orderId> [orderId …]"); return; }
  const details = await fetchOrderContactDetails(ids);
  if (!details) { console.log("LabStack could not be read — try again"); return; }
  for (const id of ids) console.log(`#${id}\n   🧪 ${testsForLab(details.get(id) ?? null, "      ", Infinity) ?? "no tests on file"}\n`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
