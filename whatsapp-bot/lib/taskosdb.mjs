/**
 * Connection to the OpsFlow (taskos) database — the integration bus between
 * the WhatsApp gateway and the console. Separate from lib/lookup.mjs, which
 * reads the read-only LabStack replica.
 *
 * TASKOS_DATABASE_URL points at the taskos schema. We strip Prisma's
 * `?schema=` param (node-postgres doesn't understand it) and instead set the
 * search_path via connection options so every query lands in `taskos`.
 */
import pg from "pg";

const rawUrl = process.env.TASKOS_DATABASE_URL || "";
const schemaMatch = rawUrl.match(/[?&]schema=([^&]+)/);
const schema = schemaMatch ? decodeURIComponent(schemaMatch[1]) : "public";
const connectionString = rawUrl.replace(/([?&])schema=[^&]+&?/, "$1").replace(/[?&]$/, "");

export const taskos = new pg.Pool({
  connectionString,
  max: 5,
  options: `-c search_path=${schema}`,
  statement_timeout: 10000,
});

taskos.on("error", (e) => console.error("[taskosdb] pool error:", e.message));

export async function taskosQuery(text, params) {
  const c = await taskos.connect();
  try { return await c.query(text, params); }
  finally { c.release(); }
}
