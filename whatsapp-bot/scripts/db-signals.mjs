import "dotenv/config";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.SOURCE_DATABASE_URL, max: 2, statement_timeout: 20000 });

async function q(label, sql) {
  try {
    const r = await pool.query(sql);
    console.log(`\n== ${label} (${r.rowCount} rows) ==`);
    for (const row of r.rows) console.log("  " + Object.values(row).map((v) => (v === null ? "∅" : v)).join("  |  "));
  } catch (e) {
    console.log(`\n== ${label} ERROR: ${e.message}`);
  }
}

await q("Order.orderStatus distribution", `select "orderStatus", count(*)::int n from public."Order" group by 1 order by 2 desc`);
await q("Order.orderType distribution", `select "orderType", count(*)::int n from public."Order" group by 1 order by 2 desc limit 25`);
await q("Request.status distribution", `select status, count(*)::int n from public."Request" group by 1 order by 2 desc`);
await q("Order id range", `select min(id) lo, max(id) hi, count(*)::int n from public."Order" where id between 10000 and 999999`);
await q("Order columns", `select column_name, data_type from information_schema.columns where table_schema='public' and table_name='Order' order by ordinal_position`);
await q("Request columns", `select column_name, data_type from information_schema.columns where table_schema='public' and table_name='Request' order by ordinal_position`);
await pool.end();
