// Emit the playbook + status phrasing as JSON so the Excel builder (python)
// reads the exact same definitions the bot uses.
import fs from "node:fs";
import path from "node:path";
import { PLAYBOOK, ORDER_STATUS_PHRASING, REQUEST_STATUS_PHRASING } from "../lib/playbook.mjs";
import { DISPOSITION } from "../lib/classifier.mjs";

const OUT = path.join(process.cwd(), "out");
fs.mkdirSync(OUT, { recursive: true });

const intents = Object.keys(PLAYBOOK).map((intent) => {
  const p = PLAYBOOK[intent];
  return {
    intent,
    disposition: p.disposition,
    action_type: p.action,
    needs_db_lookup: !!p.lookup,
    phase: p.phase,
    owner: p.owner,
    summary: p.summary,
    example_reply: (p.reply ? p.reply("<id>") : ""),
  };
});

fs.writeFileSync(path.join(OUT, "playbook.json"), JSON.stringify({
  intents,
  orderStatus: ORDER_STATUS_PHRASING,
  requestStatus: REQUEST_STATUS_PHRASING,
  dispositionMap: DISPOSITION,
}, null, 2));
console.log(`wrote out/playbook.json (${intents.length} intents)`);
