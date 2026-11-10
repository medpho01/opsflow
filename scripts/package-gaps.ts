/**
 * Packages a lab cannot read (5 Nov 2026): the evening list names each package with every test in
 * it, from LabStack's catalogue links, else from the package's own free-text list. A package with
 * neither goes out as a bare name — "EN Complete Full Body Check with Vitamin Screening with CBC" —
 * and the lab asks what is in it. This lists those packages on recent and coming orders, so the
 * tests can be added in LabStack. Read-only; no patient data.
 *
 *   docker compose -f docker-compose.yml -f docker-compose.wa.yml exec -T app npx tsx scripts/package-gaps.ts        # visits from 7 days ago onward
 *   … scripts/package-gaps.ts 96350 96418                                                                            # these orders
 */
import { labstackWorkerQuery } from "@/lib/db/labstack";

type Row = { id: number; name: string; linked: number; listed: number; described: boolean; orders: number; labs: string | null; sample: number[] };

async function main() {
  const ids = process.argv.slice(2).map(Number).filter(Number.isInteger);
  const rows = await labstackWorkerQuery<Row>(
    `SELECT pk.id, pk."packageName" AS name,
            (SELECT count(*)::int FROM public."_MasterToPackage" mp WHERE mp."B" = pk.id) AS linked,
            CASE WHEN jsonb_typeof(to_jsonb(pk) -> 'panelSubTests') = 'array' THEN jsonb_array_length(to_jsonb(pk) -> 'panelSubTests') ELSE 0 END AS listed,
            COALESCE(length(to_jsonb(pk) ->> 'description'), 0) > 0 AS described,
            count(DISTINCT o.id)::int AS orders,
            string_agg(DISTINCT l."labName", ', ') AS labs,
            (array_agg(DISTINCT o.id))[1:5] AS sample
       FROM public."Order" o
       JOIN public."_OrderToPackage" op ON op."A" = o.id
       JOIN public."Package" pk ON pk.id = op."B"
       LEFT JOIN public."Lab" l ON l.id = o."labId"
      WHERE ${ids.length ? `o.id = ANY($1::int[])` : `o."appointmentTime" >= now() - interval '7 days' AND $1::int[] IS NOT NULL`}
      GROUP BY pk.id
      ORDER BY (SELECT count(*) FROM public."_MasterToPackage" mp WHERE mp."B" = pk.id) = 0 DESC, count(DISTINCT o.id) DESC`,
    [ids],
  );
  const bare = rows.filter((r) => r.linked === 0 && r.listed === 0);
  const text = rows.filter((r) => r.linked === 0 && r.listed > 0);
  const orders = (rs: Row[]) => rs.reduce((n, r) => n + r.orders, 0);
  console.log(`${rows.length} packages on ${ids.length ? "these orders" : "orders with a visit in the last 7 days or later"}`);
  console.log(`  ${rows.length - bare.length - text.length} have catalogue tests linked — the list shows every test`);
  console.log(`  ${text.length} have only a free-text list (${orders(text)} orders) — shown from that list since 10 Nov 2026`);
  console.log(`  ${bare.length} have NO tests in LabStack (${orders(bare)} orders) — the lab sees only the name\n`);
  for (const r of bare) console.log(`✗ package ${r.id} · ${r.name.trim()} · ${r.orders} orders · ${r.labs ?? "no lab"}${r.described ? " · has a description" : ""} · e.g. ${r.sample.map((x) => `#${x}`).join(" ")}`);
  for (const r of text) console.log(`~ package ${r.id} · ${r.name.trim()} · ${r.listed} tests as text · ${r.orders} orders`);
  if (ids.length) for (const r of rows.filter((x) => x.linked > 0)) console.log(`✓ package ${r.id} · ${r.name.trim()} · ${r.linked} tests linked`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
