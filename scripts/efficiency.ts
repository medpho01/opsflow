/**
 * The Ops Efficiency Index, day by day — the same numbers the nightly brief
 * carries (brain/efficiency.ts). Read-only; prints counts, no names.
 *
 *   docker compose exec -T app npx tsx scripts/efficiency.ts          # last 7 days
 *   docker compose exec -T app npx tsx scripts/efficiency.ts 14       # last 14 days
 */
import { computeEfficiency, renderEfficiency } from "@/lib/agents/brain/efficiency";

const TZ = process.env.TIMEZONE || "Asia/Kolkata";
const H = 3_600_000;

async function main() {
  const days = Number(process.argv[2] ?? 7);
  const now = new Date();
  const todayLocal = new Date(now.toLocaleDateString("en-CA", { timeZone: TZ }) + "T00:00:00+05:30");
  const rows: Array<{ day: string; index: number | null }> = [];
  for (let d = days - 1; d >= 0; d -= 1) {
    const from = new Date(todayLocal.getTime() - d * 24 * H);
    const to = new Date(from.getTime() + 24 * H);
    const e = await computeEfficiency(from, to);
    const day = from.toLocaleDateString("en-IN", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
    rows.push({ day, index: e.index });
    console.log(`\n━━━ ${day} ━━━`);
    for (const line of renderEfficiency(e)) console.log(line);
  }
  console.log("\nIndex by day: " + rows.map((r) => `${r.day} ${r.index ?? "—"}`).join(" · "));
  const scored = rows.filter((r) => r.index != null).map((r) => r.index!);
  if (scored.length) console.log(`Average: ${Math.round(scored.reduce((a, b) => a + b, 0) / scored.length)}/100`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
