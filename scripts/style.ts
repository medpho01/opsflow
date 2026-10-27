/**
 * Message style: what wording each message kind uses, what is on trial, and how
 * each arm engaged (brain/style.ts). Read-only.
 *
 *   npx tsx scripts/style.ts            every kind with a trial or a track record
 *   npx tsx scripts/style.ts --all      every kind
 */
import prisma from "@/lib/db/client";
import { STYLE_KEYS } from "@/lib/agents/style";
import { styleStats } from "@/lib/agents/brain/style";

async function main() {
  const all = process.argv.includes("--all");
  const now = new Date();
  for (const key of STYLE_KEYS) {
    const stats = await styleStats(key, now);
    const variants = await prisma.agentMessageVariant.findMany({ where: { key }, orderBy: { version: "desc" }, take: 3, select: { id: true, version: true, status: true, rationale: true, body: true, createdAt: true } });
    if (!all && stats.live.sends === 0 && variants.length === 0) continue;
    const pct = (r: number) => `${Math.round(r * 100)}%`;
    console.log(`\n${key}: live ${stats.live.sends} sends, ${pct(stats.live.rate)} engaged${stats.live.medianMin != null ? `, median ${stats.live.medianMin} min` : ""}`);
    for (const v of variants) {
      const arm = stats.trials.find((t) => t.id === v.id)?.stats;
      console.log(`  v${v.version} ${v.status}${arm ? ` — ${arm.sends} sends, ${pct(arm.rate)} engaged` : ""} (${v.createdAt.toISOString().slice(0, 10)})${v.rationale ? `\n     ${v.rationale}` : ""}\n     ${JSON.stringify(v.body)}`);
    }
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
