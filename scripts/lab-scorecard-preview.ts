/**
 * The weekly lab scorecard, rendered for every lab exactly as Monday's run will
 * send it — without sending. Reads last week's journeys and combined messages,
 * computes the numbers (src/lib/agents/brain/scorecard.ts) and prints each
 * lab's message with what would happen to it (sent, shadow, desk off, no group).
 *
 *   docker compose exec -T app npx tsx scripts/lab-scorecard-preview.ts
 *   npx tsx scripts/lab-scorecard-preview.ts --now 2026-10-26T05:00:00Z   (as of another Monday)
 *
 * Read-only: nothing is queued, nothing goes to WhatsApp, no brain run is written.
 */
import { buildScorecards } from "@/lib/agents/brain/scorecard";
import { TIME_ZONE } from "@/lib/provider-rules/format";

async function main() {
  const arg = process.argv.indexOf("--now");
  const now = arg >= 0 && process.argv[arg + 1] ? new Date(process.argv[arg + 1]) : new Date();
  const { week, cards } = await buildScorecards(now);
  console.log(`Lab scorecards for ${week.label} (as of ${now.toLocaleString("en-IN", { timeZone: TIME_ZONE() })}) · ${cards.length} lab(s)\n`);
  const fate = (c: (typeof cards)[number]) => {
    if (c.numbers.orders === 0 && c.numbers.asks === 0) return "nothing to say — skipped";
    if (c.desk === "NOT_CONNECTED") return "no WhatsApp group — skipped";
    if (c.desk === "OFF") return "Lab desk OFF — skipped";
    if (c.desk === "SHADOW") return "Lab desk SHADOW — recorded only";
    return "Lab desk LIVE — goes to the group via the dispatcher";
  };
  for (const c of cards) {
    console.log(`── ${c.labName} (lab ${c.labId}) · ${fate(c)}`);
    console.log(c.text.replace("{{coordinator}}", "@coordinator").split("\n").map((l) => `   ${l}`).join("\n"));
    console.log();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
