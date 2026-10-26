/**
 * Each store's summary as it would be sent now, and how many of today's
 * visits are at risk because the customer did not answer (RNR). Prints only;
 * nothing is sent. Names and phones appear as the store would see them — read
 * it on the VM, do not paste it anywhere public.
 *
 *   docker compose exec -T app npx tsx scripts/store-digest-preview.ts            # stores with a connected group
 *   docker compose exec -T app npx tsx scripts/store-digest-preview.ts 6          # one store
 */
import prisma from "@/lib/db/client";
import { storeDays, digestText } from "@/lib/agents/store/digest";

async function main() {
  const arg = process.argv.slice(2).map(Number).filter(Number.isInteger);
  const groups = await prisma.waGroup.findMany({ where: { role: "SUPPORT", storeId: { not: null }, archivedAt: null }, select: { storeId: true, subject: true } });
  const ids = arg.length ? arg : [...new Set(groups.map((g) => g.storeId!))];
  const days = await storeDays(ids, new Date());
  let rnr = 0, owed = 0, missed = 0, centre = 0, total = 0;
  for (const d of days) {
    rnr += d.rnr.length; owed += d.owed.length; missed += d.missed.length; centre += d.centreMissed.length; total += d.total;
    const text = digestText(d, groups.find((g) => g.storeId === d.storeId)?.subject ?? `store ${d.storeId}`);
    if (!text) continue;
    console.log(`\n──── store ${d.storeId}\n${text}`);
  }
  console.log(`\nToday across ${days.length} store(s): ${total} visits · ${rnr} at risk — customer not reachable (RNR) · ${owed} sample owed · ${missed} visit passed, not collected · ${centre} centre visit not attended yet`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
