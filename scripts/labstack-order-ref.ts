/**
 * What LabStack holds as a lab's own reference for an order — to check which
 * column carries the "BLR6362207"-style ids a lab's desk searches by.
 *
 *   npx tsx scripts/labstack-order-ref.ts 93856 93498
 *
 * Read-only on the replica; prints ids and references only, no patient data.
 */
import { labstackWorkerQuery } from "@/lib/db/labstack";

async function main() {
  const ids = process.argv.slice(2).map(Number).filter(Number.isInteger);
  if (!ids.length) { console.log("usage: npx tsx scripts/labstack-order-ref.ts <orderId> [...]"); return; }
  const rows = await labstackWorkerQuery<{ id: number; labId: number | null; labOrderId: string | null; labOrderReference: unknown; referenceId: string | null }>(
    `SELECT id, "labId", "labOrderId", "labOrderReference", "referenceId" FROM public."Order" WHERE id = ANY($1::int[]) ORDER BY id`, [ids],
  );
  for (const r of rows) console.log(`#${r.id}  lab ${r.labId ?? "-"}  labOrderId=${JSON.stringify(r.labOrderId)}  referenceId=${JSON.stringify(r.referenceId)}  labOrderReference=${JSON.stringify(r.labOrderReference)?.slice(0, 160)}`);
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) console.log(`not found: ${missing.join(", ")}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
