/**
 * What the agent is about to send — rendered exactly as the dispatcher will,
 * without sending. Reads the queued outbox, groups by lab and ask, builds each
 * line the same way (reference, phone, place from LabStack at send time) and
 * prints the message text.
 *
 *   docker compose exec -T app npx tsx scripts/agents-preview-outbox.ts
 *
 * Read-only: nothing is marked sent, nothing goes to WhatsApp. Output names
 * patients and phones as the lab would see them — read it on the VM, do not
 * paste it anywhere public.
 */
import prisma from "@/lib/db/client";
import { itemLine } from "@/lib/provider-rules/batching";
import { TIME_ZONE } from "@/lib/provider-rules/format";
import { fetchOrderContactDetails } from "@/lib/non-api-labs/order-details";
import { BATCH_GENERIC_TEMPLATE, BATCH_TEMPLATE_BY_INTENT, ensureTemplate, renderLabTemplate } from "@/lib/non-api-labs/templates";
import { partitionQueued, type OutboxLine } from "@/lib/agents/executors/dispatcher";
import { loadDirectory, tierOf } from "@/lib/agents/directory";

async function main() {
  const now = new Date();
  const items = await prisma.agentOutboxItem.findMany({ where: { status: "QUEUED" }, orderBy: [{ counterparty: "asc" }, { ask: "asc" }, { createdAt: "asc" }] });
  if (!items.length) { console.log("Outbox is empty — nothing queued right now."); return; }
  const groups = new Map<string, typeof items>();
  for (const i of items) { const k = `${i.counterparty}|${i.ask}`; groups.set(k, [...(groups.get(k) ?? []), i]); }
  console.log(`${items.length} queued item(s) in ${groups.size} message(s):\n`);
  const directory = await loadDirectory();
  for (const [key, queued] of groups) {
    const [counterparty, ask] = key.split("|");
    const labId = Number(counterparty.split(":")[1]);
    const { fresh: list, stale } = partitionQueued(queued, ask, now, counterparty.startsWith("LAB:") ? tierOf(directory, labId) : null);
    if (stale.length) console.log(`── ${counterparty} · ${ask}: ${stale.length} item(s) will be dropped as stale or duplicate`);
    if (!list.length) { console.log(); continue; }
    const config = await prisma.nonApiLabConfig.findUnique({ where: { labId } });
    const details = await fetchOrderContactDetails(list.map((i) => i.orderId)).catch(() => null);
    const lines = list.map((i, index) => {
      const p = (i.payload as { line: OutboxLine & { appointment: string | null } }).line;
      const d = details?.get(i.orderId);
      return itemLine(ask, {
        n: index + 1, orderId: i.orderId, patientName: p.patientName, appointment: p.appointment ? new Date(p.appointment) : null,
        area: p.area ?? d?.area ?? null, phlebo: p.phlebo ?? null, labRef: p.labRef ?? d?.labRef ?? null, mobile: p.mobile ?? d?.patientMobile ?? null,
        milestone: p.milestone ?? null, dueAt: p.dueAt ? new Date(p.dueAt) : undefined, confirmUrl: null,
      }, now, TIME_ZONE());
    });
    const t = await ensureTemplate(BATCH_TEMPLATE_BY_INTENT[ask] ?? BATCH_GENERIC_TEMPLATE);
    const text = renderLabTemplate(t.body, {
      lab_name: config?.labName ?? `lab ${labId}`, manager_name: config?.managerName ?? "there", coordinator: "@coordinator",
      count: String(list.length), orders_word: list.length === 1 ? "order" : "orders", items: lines.join("\n"), batch_title: ask.toLowerCase().replace("_", " "),
    });
    const windowFrom = list.map((i) => i.windowFrom).sort((a, b) => a.getTime() - b.getTime())[0];
    console.log(`── ${counterparty} (${config?.labName ?? "not connected"}) · ${ask} · ${list.length} item(s) (first 10 go now) · earliest window ${windowFrom.toLocaleString("en-IN", { timeZone: TIME_ZONE() })}${list.some((i) => i.urgent) ? " · URGENT" : ""}`);
    console.log(text.split("\n").map((l) => `   ${l}`).join("\n"));
    console.log();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
