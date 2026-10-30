/**
 * Which kinds of store request the store desk answers itself (30 Oct 2026). The same setting as the
 * chips on Agents › Desks, for when a kind is not shown there yet (a kind appears once it is graded).
 * An empty list means every kind; the rest are handed to a person in the group.
 *
 *   docker compose -f docker-compose.yml -f docker-compose.wa.yml exec -T app npx tsx scripts/store-live-intents.ts 6            # show
 *   docker compose -f docker-compose.yml -f docker-compose.wa.yml exec -T app npx tsx scripts/store-live-intents.ts 6 +reschedule
 */
import prisma from "@/lib/db/client";
import { STORE_INTENTS } from "@/lib/agents/store/readiness";

async function main() {
  const [idText, ...changes] = process.argv.slice(2);
  const storeId = Number(idText);
  if (!Number.isInteger(storeId)) { console.log("usage: scripts/store-live-intents.ts <storeId> [+kind|-kind …]"); return; }
  const where = { desk_scopeKind_scopeId: { desk: "STORE", scopeKind: "STORE", scopeId: storeId } };
  const row = await prisma.agentDeskState.findUnique({ where });
  if (!row) { console.log(`store ${storeId}: no store desk`); return; }
  let live = row.liveIntents.length ? [...row.liveIntents] : [...STORE_INTENTS];
  for (const c of changes) {
    const kind = c.slice(1);
    if (!(STORE_INTENTS as readonly string[]).includes(kind) || !/^[+-]/.test(c)) { console.log(`skipped "${c}": use +kind or -kind, kinds: ${STORE_INTENTS.join(", ")}`); continue; }
    live = c.startsWith("+") ? [...new Set([...live, kind])] : live.filter((x) => x !== kind);
  }
  if (changes.length) {
    const stored = live.length === STORE_INTENTS.length ? [] : live;
    await prisma.agentDeskState.update({ where, data: { liveIntents: stored } });
  }
  console.log(`store ${storeId} desk ${row.state}: answers ${live.length === STORE_INTENTS.length ? "every kind" : live.join(", ")} itself`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
