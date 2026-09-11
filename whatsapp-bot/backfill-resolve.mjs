#!/usr/bin/env node
// Re-resolve threads + ids for recently-stored WhatsApp messages against the
// current logic (validated ids, order canonicalization, reply-chain
// inheritance). Safe to re-run. Does NOT recover media — that needs a
// WhatsApp history re-fetch on the live gateway (BACKFILL command).
//
//   node backfill-resolve.mjs [days=3]
import "dotenv/config";
import * as CT from "./lib/controltower.mjs";

const days = Number(process.argv[2] || 3);
console.log(`Re-resolving messages from the last ${days} day(s) in active groups…`);
try {
  const res = await CT.reresolveWindow({ days });
  console.log(`✓ scanned ${res.scanned} · updated ${res.updated} · inherited-via-reply ${res.inherited} · tickets upserted ${res.tickets}`);
  const rr = await CT.backfillResponses();
  console.log(`✓ responses stamped on ${rr.stamped}/${rr.tickets} open cases`);
  const pc = await CT.backfillProviderCases({ days });
  console.log(`✓ provider cases: created ${pc.created} · attached ${pc.attached} · answered ${pc.answered} (scanned ${pc.scanned})`);
  const lm = await CT.mapLabGroups();
  console.log(`✓ lab-group mapping: mapped ${lm.mapped}/${lm.candidates} provider groups to their lab`);
} catch (e) {
  console.error("backfill failed:", e.message);
  process.exit(1);
}
process.exit(0);
