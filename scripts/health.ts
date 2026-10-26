/**
 * Run the health checks now and print them — the same checks the worker runs
 * every 5 minutes (src/lib/agents/health.ts). Heals what it can; sends no alert.
 *
 *   docker compose exec -T app npx tsx scripts/health.ts
 */
import { runHealth } from "@/lib/agents/health";

runHealth(new Date(), { alert: false }).then(({ checks, problems }) => {
  for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.key.padEnd(15)} ${c.detail}${c.healed ? `  [healed: ${c.healed}]` : ""}`);
  console.log(problems ? `\n${problems} problem(s)` : "\nall healthy");
  process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
