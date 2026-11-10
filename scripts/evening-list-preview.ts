/**
 * Why an evening list shows what it shows (11 Nov 2026: Star's list named packages without their
 * tests though LabStack holds them). For the given orders: what LabStack returns for each package,
 * the entry wording in use (live and any trial), and the 🧪 lines exactly as the list would render
 * them now. Read-only; sends nothing; prints no names, phones or addresses.
 *
 *   docker compose -f docker-compose.yml -f docker-compose.wa.yml exec -T app npx tsx scripts/evening-list-preview.ts 94467 96893 97327
 */
import prisma from "@/lib/db/client";
import { fetchOrderContactDetails, testsForLab } from "@/lib/non-api-labs/order-details";
import { STYLE_DEFAULTS, renderLoose } from "@/lib/agents/style";

async function main() {
  const ids = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) { console.log("usage: scripts/evening-list-preview.ts <orderId> [orderId …]"); return; }
  const details = await fetchOrderContactDetails(ids);
  if (!details) { console.log("LabStack could not be read — the list would be held (retry)"); return; }
  console.log("1. What LabStack returns");
  for (const id of ids) {
    const d = details.get(id);
    console.log(`   #${id}: ${d ? (d.packages.length ? d.packages.map((p) => `${p.name.trim()} — ${p.tests.length} tests`).join("; ") : "no packages") + (d.directTests.length ? ` · ${d.directTests.length} tests booked on their own` : "") : "not found"}`);
  }
  const live = await prisma.labCommunicationTemplate.findUnique({ where: { key: "SUMMARY_ENTRY_TOMORROW" }, select: { body: true, isActive: true, updatedAt: true, updatedById: true } });
  const variants = await prisma.agentMessageVariant.findMany({ where: { key: "SUMMARY_ENTRY_TOMORROW" }, select: { status: true, share: true, author: true, body: true, createdAt: true, decidedAt: true }, orderBy: { createdAt: "desc" }, take: 6 });
  const show = (b: string) => b.split("\n").map((l) => `      ${l}`).join("\n");
  console.log(`\n2. Entry wording in use${live ? ` (saved ${live.updatedAt.toISOString().slice(0, 10)}${live.isActive ? "" : ", PAUSED — the built-in wording is used"})` : " (none saved — the built-in wording)"}`);
  console.log(show(live?.isActive ? live.body : STYLE_DEFAULTS.SUMMARY_ENTRY_TOMORROW.body));
  for (const v of variants) console.log(`   variant ${v.status} · share ${v.share} · by ${v.author} · ${v.createdAt.toISOString().slice(0, 10)}\n${show(v.body)}`);
  const body = live?.isActive ? live.body : STYLE_DEFAULTS.SUMMARY_ENTRY_TOMORROW.body;
  console.log("\n3. The test lines as the list renders them now");
  for (const id of ids) {
    const what = testsForLab(details.get(id) ?? null, "      ", Infinity) ?? "";
    const out = renderLoose(body, { n: "1", time: "8:00 am", name: "PATIENT", order_id: String(id), mobile: "PHONE", address: "ADDRESS", map_url: "MAP", packages: what, tests: "" });
    const lines = out.split("\n"); const at = lines.findIndex((l) => l.includes("🧪"));
    console.log(at < 0 ? `   #${id}: the wording has no 🧪 line that renders — {{packages}} is ${/{{\s*packages\s*}}/.test(body) ? "present" : "MISSING from the wording"}` : lines.slice(at, at + 4).map((l) => `   ${l.slice(0, 200)}`).join("\n"));
  }
  const sent = await prisma.waOutbound.findMany({ where: { text: { contains: `#${ids[0]}` }, createdAt: { gte: new Date(Date.now() - 36 * 3_600_000) } }, select: { createdAt: true, text: true }, orderBy: { createdAt: "desc" }, take: 3 });
  console.log(`\n4. Messages sent in the last 36 h naming #${ids[0]}: ${sent.length}`);
  for (const s of sent) { const l = s.text.split("\n"); const i = l.findIndex((x) => x.includes(`#${ids[0]}`)); const t = l.slice(Math.max(0, i - 6), i + 3).filter((x) => x.includes("🧪") || /^\s{3,}\S/.test(x) && !/📍|🗺️|📞/.test(x)); console.log(`   ${s.createdAt.toISOString()} · ${l[0].slice(0, 60)}\n${t.map((x) => `      ${x.slice(0, 160)}`).join("\n")}`); }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
