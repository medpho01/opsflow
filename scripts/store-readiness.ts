/**
 * Grade a store's desk over past days — the same self-evaluation Agents › Desks
 * shows (store/readiness.ts): drafts vs the team's replies, a score per kind.
 *
 *   docker compose exec -T app npx tsx scripts/store-readiness.ts 6        # last 7 days
 *   docker compose exec -T app npx tsx scripts/store-readiness.ts 6 14     # last 14 days
 *   docker compose exec -T app npx tsx scripts/store-readiness.ts 6 3 --wrong   # also print every disagreement (names orders and quotes chats — read on the VM)
 */
import prisma from "@/lib/db/client";
import { runReadiness, scoreStore } from "@/lib/agents/store/readiness";

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const storeId = Number(args[0]); const days = Math.min(30, Number(args[1] ?? 7));
  if (!storeId) { console.log("usage: npx tsx scripts/store-readiness.ts <storeId> [days]"); return; }
  const r = await runReadiness(new Date(), { storeId, hours: days * 24, scoreDays: days });
  const s = await scoreStore(storeId, days);
  console.log(`store ${storeId} · ${days} d · ${r.questions} questions graded, ${r.judged} compared with the team · readiness ${s.score ?? "—"}`);
  for (const i of s.intents.filter((x) => x.n)) console.log(`  ${i.intent.padEnd(14)} ${String(i.score ?? "–").padStart(3)}  asked ${String(i.n).padStart(3)}  bot answered ${String(i.covered).padStart(3)}  missed ${String(i.missed).padStart(3)}  wrong ${i.bad} (${i.contradicts} contradict, ${i.wrongLinks} wrong order, ${i.wouldFail} would fail)${i.ready ? "  ✓ ready" : ""}`);
  if (s.recommended.length) console.log(`  ready to go live for: ${s.recommended.join(", ")}`);
  if (process.argv.includes("--wrong")) {
    const rows = await prisma.agentShadowEval.findMany({ where: { storeId, at: { gte: new Date(Date.now() - days * 86_400_000) }, verdict: { in: ["CONTRADICTS", "WRONG_LINK", "WOULD_FAIL"] } }, orderBy: { at: "asc" } });
    const t = (d: Date | null) => (d ? d.toLocaleString("en-IN", { timeZone: process.env.TIMEZONE || "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—");
    console.log(`\n${rows.length} disagreement(s):`);
    for (const r of rows) {
      console.log(`\n${t(r.at)}  ${r.verdict}  [${r.intent}]${r.orderId ? `  #${r.orderId}` : ""}${r.note ? `  — ${r.note}` : ""}`);
      console.log(`   store: ${r.question}`);
      console.log(`   bot:   ${r.botDraft ?? "—"}`);
      console.log(`   team:  ${r.teamReply ?? "—"}`);
    }
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
