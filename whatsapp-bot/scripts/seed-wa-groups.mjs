#!/usr/bin/env node
/**
 * Seed wa_groups from the Labstack groups the account is in. Idempotent:
 * inserts new jids, refreshes the subject on existing ones, never overwrites
 * an admin's role/mapping choices.
 *
 * Source: all-groups.txt (jid + subject lines the gateway wrote on connect),
 * filtered to subjects matching the Labstack group filter.
 *
 *   node scripts/seed-wa-groups.mjs
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { taskos } from "../lib/taskosdb.mjs";

const FILTER = new RegExp(process.env.GROUP_FILTER || "labstack", "i");
const FILE = path.join(process.cwd(), "all-groups.txt");
if (!fs.existsSync(FILE)) { console.error("all-groups.txt not found — start the gateway once to generate it."); process.exit(1); }

// parse "  <jid>@g.us   <subject>" → unique by jid, subject must match filter
const groups = new Map();
for (const line of fs.readFileSync(FILE, "utf8").split("\n")) {
  const m = line.match(/^\s*(\d[\d-]*@g\.us)\s+(.*\S)\s*$/);
  if (!m) continue;
  const [, jid, subject] = m;
  if (!FILTER.test(subject)) continue;
  groups.set(jid, subject); // last wins → dedupe
}

console.log(`seeding ${groups.size} Labstack groups…`);
let ins = 0, upd = 0;
for (const [jid, subject] of groups) {
  const r = await taskos.query(
    `INSERT INTO wa_groups (id, jid, subject, role, active, "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, 'SUPPORT', true, now())
     ON CONFLICT (jid) DO UPDATE SET subject = EXCLUDED.subject, "updatedAt" = now()
     RETURNING (xmax = 0) AS inserted`,
    [jid, subject]
  );
  if (r.rows[0].inserted) ins++; else upd++;
}
console.log(`done: ${ins} inserted, ${upd} refreshed`);
const total = await taskos.query(`SELECT count(*)::int n FROM wa_groups`);
console.log(`wa_groups now has ${total.rows[0].n} rows`);
await taskos.end();
