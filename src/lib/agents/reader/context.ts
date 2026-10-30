/**
 * What the reader knows besides the message itself (30 Oct 2026). Read alone, "11:45 works" was
 * chatter, Orange's "Time: 10:15 am" quoting a team member was a note, and an RNR reply listed
 * blood, urine, stool, swab and sputum as missed on an order with blood and urine. A person reads a
 * message knowing the order, what is open on it, and what was just said; so does the reader now.
 *
 * One short block per order: the tests, what LabStack shows, what is open (a re-collection asked, a
 * slot the store picked), and the last messages about it in the store's and the lab's groups, ours
 * included. Built from stored rows; never fails the read — no context is an empty string.
 */
import prisma from "@/lib/db/client";
import { fetchOrderSnapshot } from "../journey/window";
import { openRecollectFor } from "../journey/run";
import { fetchOrderContactDetails } from "@/lib/non-api-labs/order-details";
import { isAutomated, loadTeam, makeTeamMatcher } from "@/lib/wa/team";

const TZ = () => process.env.TIMEZONE || "Asia/Kolkata";
const RECENT_MS = 2 * 3_600_000;
const MAX_LINES = 8;
const clock = (d: Date) => d.toLocaleTimeString("en-IN", { timeZone: TZ(), hour: "numeric", minute: "2-digit" });
const oneLine = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** "Waiting for: …" in words, from the journey's own state. */
function openLines(j: { waitingFor: unknown; subStates: string[] } | null, recollect: string | null): string[] {
  const out: string[] = [];
  if (recollect) out.push(`Open: ${recollect} sample to re-collect — the lab was asked for slots in the last day.`);
  const picked = j?.subStates.find((s) => s.startsWith("recollect-asked:"));
  if (picked) out.push(`Open: the store picked ${clock(new Date(picked.slice("recollect-asked:".length)))} for it — waiting for the lab to confirm.`);
  const requested = j?.subStates.find((s) => s.startsWith("requested:"));
  if (requested) out.push(`Open: the store asked to move the visit to ${new Date(requested.slice("requested:".length)).toLocaleString("en-IN", { timeZone: TZ(), weekday: "short", hour: "numeric", minute: "2-digit" })}.`);
  const w = j?.waitingFor as { what?: string; from?: string } | null;
  if (w?.what) out.push(`Next step: ${w.what.replace(/_/g, " ")} (from the ${String(w.from ?? "lab").toLowerCase()}).`);
  return out;
}

/**
 * The context block for these orders (at most two), as of `at`. `sender` (a lab or store member's
 * jid) adds what that person said in the 10 minutes before — "Checking." then the answer.
 */
export async function contextFor(orderIds: number[], at: Date, opts: { groupId?: string | null; senderJid?: string | null } = {}): Promise<string> {
  try {
    const ids = [...new Set(orderIds)].slice(0, 2);
    const blocks: string[] = [];
    const isTeam = makeTeamMatcher(await loadTeam());
    const details = ids.length ? await fetchOrderContactDetails(ids).catch(() => null) : null;
    for (const id of ids) {
      const [o, j, recollect] = await Promise.all([
        fetchOrderSnapshot(id).catch(() => null),
        prisma.agentJourney.findUnique({ where: { orderId: id }, select: { waitingFor: true, subStates: true } }).catch(() => null),
        openRecollectFor(id, at),
      ]);
      if (!o) continue;
      const d = details?.get(id);
      const tests = [...(d?.packages ?? []).map((p) => `${p.name}${p.tests.length ? ` (${p.tests.slice(0, 20).join(", ")}${p.tests.length > 20 ? ", …" : ""})` : ""}`), ...(d?.directTests ?? [])].join("; ");
      const head = `Order #${id}${o.labRef ? ` (lab ref ${o.labRef})` : ""} · lab ${o.labName ?? o.labId} · LabStack: ${o.orderStatus}${o.appointmentTime ? `, visit ${o.appointmentTime.toLocaleString("en-IN", { timeZone: TZ(), weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}`;
      const lines = [head, ...(tests ? [`Tests: ${oneLine(tests, 400)}`] : []), ...openLines(j, recollect)];
      // The last messages about it, in any group, ours and the team's included.
      const needles = [`#${id}`, String(id), ...(o.labRef ? [o.labRef] : [])];
      const recent = await prisma.waMessage.findMany({
        where: { ts: { gte: new Date(at.getTime() - RECENT_MS), lt: at }, OR: [{ orderIds: { has: id } }, ...needles.map((n) => ({ text: { contains: n, mode: "insensitive" as const } }))] },
        orderBy: { ts: "desc" }, take: MAX_LINES, select: { ts: true, sender: true, senderJid: true, fromMe: true, text: true, intent: true, group: { select: { role: true } } },
      }).catch(() => []);
      if (recent.length) {
        lines.push("Recent messages about it:");
        for (const m of recent.reverse()) {
          const who = m.fromMe || isAutomated(m) ? "us" : isTeam(m.sender, m.senderJid) ? "our team" : m.group.role === "PROVIDER" ? "lab" : "store";
          lines.push(`  ${clock(m.ts)} [${m.group.role === "PROVIDER" ? "lab group" : "store group"}] ${who}: ${oneLine(m.text, 220)}`);
        }
      }
      blocks.push(lines.join("\n"));
    }
    if (opts.groupId && opts.senderJid) {
      const before = await prisma.waMessage.findMany({ where: { groupId: opts.groupId, senderJid: opts.senderJid, ts: { gte: new Date(at.getTime() - 10 * 60_000), lt: at } }, orderBy: { ts: "asc" }, select: { ts: true, text: true } }).catch(() => []);
      if (before.length) blocks.push(`The same person just before:\n${before.map((m) => `  ${clock(m.ts)}: ${oneLine(m.text, 200)}`).join("\n")}`);
    }
    return blocks.join("\n\n").slice(0, 3000);
  } catch {
    return "";
  }
}
