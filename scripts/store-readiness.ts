/**
 * Grade a store's desk over past days — the same self-evaluation Agents › Desks
 * shows (store/readiness.ts): drafts vs the team's replies, a score per kind.
 *
 *   docker compose exec -T app npx tsx scripts/store-readiness.ts 6        # last 7 days
 *   docker compose exec -T app npx tsx scripts/store-readiness.ts 6 14     # last 14 days
 */
import prisma from "@/lib/db/client";
import { runReadiness, scoreStore } from "@/lib/agents/store/readiness";

async function main() {
  const storeId = Number(process.argv[2]); const days = Math.min(30, Number(process.argv[3] ?? 7));
  if (!storeId) { console.log("usage: npx tsx scripts/store-readiness.ts <storeId> [days]"); return; }
  const r = await runReadiness(new Date(), { storeId, hours: days * 24, scoreDays: days });
  const s = await scoreStore(storeId, days);
  console.log(`store ${storeId} · ${days} d · ${r.questions} questions graded, ${r.judged} compared with the team · readiness ${s.score ?? "—"}`);
  for (const i of s.intents.filter((x) => x.n)) console.log(`  ${i.intent.padEnd(14)} ${String(i.score ?? "–").padStart(3)}  asked ${String(i.n).padStart(3)}  bot answered ${String(i.covered).padStart(3)}  missed ${String(i.missed).padStart(3)}  wrong ${i.bad} (${i.contradicts} contradict, ${i.wrongLinks} wrong order, ${i.wouldFail} would fail)${i.ready ? "  ✓ ready" : ""}`);
  if (s.recommended.length) console.log(`  ready to go live for: ${s.recommended.join(", ")}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
