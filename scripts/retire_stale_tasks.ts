/**
 * One-shot backfill: retire stale tasks.
 *
 * Runs the same logic as the cycle's task retirer (see
 * src/lib/engine/taskRetirer.ts) but as a standalone script. Use this
 * once after deploying the auto-retire change to clean up the existing
 * pile of phantom tasks that accumulated before the engine started
 * retiring on its own.
 *
 * Usage:
 *   docker compose exec app node -e "require('./dist/scripts/retire_stale_tasks.js').main()"
 *   # or via tsx if available:
 *   docker compose exec app npx tsx scripts/retire_stale_tasks.ts
 *
 * Idempotent: running twice is a no-op the second time (only retires
 * tasks whose source order is currently past the rule's statusIn).
 */
import { runTaskRetirer } from "../src/lib/engine/taskRetirer";

export async function main() {
  console.log("[Backfill] Starting one-shot task retirement…");
  const start = Date.now();
  const result = await runTaskRetirer();
  const durationMs = Date.now() - start;

  console.log(`[Backfill] Done in ${durationMs}ms`);
  console.log(`[Backfill] Total retired: ${result.totalRetired}`);
  if (result.perRule.length > 0) {
    console.log("[Backfill] Per-rule breakdown:");
    for (const r of result.perRule) {
      console.log(`  - ${r.ruleName} (${r.ruleId}): ${r.retired}`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("[Backfill] Error:", e);
  process.exit(1);
});
