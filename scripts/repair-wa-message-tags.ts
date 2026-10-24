/**
 * Repair wa_messages whose order tag disagrees with its own explanation.
 *
 * A row's idVia names the order the gateway resolved ("order 93709",
 * "reply · order 93709"), and readers take orderIds[0] as THE order. Until
 * 24 Oct 2026 ticket adoption and relinks could leave orderIds[0] pointing at
 * a different order than idVia names. This puts the named order first, keeping
 * the rest of the list.
 *
 *   npx tsx scripts/repair-wa-message-tags.ts          # dry run: counts and a sample
 *   npx tsx scripts/repair-wa-message-tags.ts --apply  # write the fix
 *
 * Idempotent: a second run finds nothing. Reads only wa_messages in this
 * database (DATABASE_URL); LabStack is not touched.
 */
import prisma from "@/lib/db/client";

const apply = process.argv.includes("--apply");
const NAMED = /\border (\d+)\b/i;

async function main() {
  const rows = await prisma.waMessage.findMany({
    where: { idVia: { contains: "order " }, NOT: { orderIds: { isEmpty: true } } },
    select: { id: true, idVia: true, orderIds: true, idType: true, ts: true },
    orderBy: { ts: "desc" },
  });
  const mismatched = rows.flatMap((r) => {
    const named = r.idVia?.match(NAMED);
    if (!named) return [];
    const want = Number(named[1]);
    return r.orderIds[0] === want ? [] : [{ ...r, want }];
  });
  console.log(`${rows.length} tagged messages read, ${mismatched.length} with orderIds[0] ≠ the order idVia names`);
  for (const r of mismatched.slice(0, 10)) console.log(`  ${r.ts.toISOString()}  ${r.idType ?? "-"}  ids=[${r.orderIds.join(",")}]  via="${r.idVia}"  → [${[r.want, ...r.orderIds.filter((x) => x !== r.want)].join(",")}]`);
  if (!apply) { console.log(mismatched.length ? "Dry run — re-run with --apply to fix." : "Nothing to fix."); return; }
  let fixed = 0;
  for (const r of mismatched) {
    await prisma.waMessage.update({ where: { id: r.id }, data: { orderIds: [r.want, ...r.orderIds.filter((x) => x !== r.want)] } });
    fixed += 1;
  }
  console.log(`Fixed ${fixed} message(s).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
