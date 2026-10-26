/**
 * The internal ops group (27 Oct 2026): LabStack's own WhatsApp group where the
 * agent posts what needs a person — an escalation nobody else can take, a task,
 * a question a lab or store asked the bot, a lab cancellation. Nothing is
 * assigned to anyone: whoever picks a post up replies "on it".
 *
 * The group is the one connected as INTERNAL on Connections › Groups (the one
 * named like "Internal <> ops" when there are several), or AGENT_OPS_GROUP_JID.
 */
import prisma from "@/lib/db/client";

export type OpsGroup = { id: string; jid: string; subject: string };

let cached: { at: number; group: OpsGroup | null } | null = null;

export async function opsGroup(): Promise<OpsGroup | null> {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.group;
  const env = process.env.AGENT_OPS_GROUP_JID?.trim();
  const rows = await prisma.waGroup.findMany({
    where: env ? { jid: env } : { role: "INTERNAL", active: true, archivedAt: null },
    select: { id: true, jid: true, subject: true },
  });
  const group = rows.find((g) => /internal/i.test(g.subject) && /\bops\b/i.test(g.subject)) ?? rows[0] ?? null;
  cached = { at: Date.now(), group };
  return group;
}

/** For tests and the reader: forget the cached group. */
export function resetOpsGroupCache() { cached = null; }
