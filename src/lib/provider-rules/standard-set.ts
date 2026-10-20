/**
 * One standard set of lab messages, the same for every lab — no per-lab
 * switches (decided 20 Oct 2026, after the chat review in
 * DOCS/features/provider-communication/CHAT-REVIEW-OCT-2026.md).
 *
 * Applied once to an existing install (ProviderCommsSettings.standardSetAt):
 *   - the built-in rules below are on or off for ALL labs (lab scoping that
 *     came from old per-lab switches is cleared);
 *   - rules converted from the old system (deadline watchers, timed rules) and
 *     per-lab copies of built-ins are paused — the standard set covers them;
 *   - every lab gets combined messages.
 * After that, Message Rules edits are global and stick; this never runs again.
 * Rules ops create themselves are never touched.
 */
import prisma from "@/lib/db/client";
import type { ProviderMessageRule } from "@prisma/client";
import { BUILT_IN_RULES } from "./builtins";
import type { RuleCondition } from "./types";

/** What every lab gets. */
export const STANDARD_ON = [
  "NEW_ORDER", "REMINDER_1H", "REMINDER_3H", "ESCALATION_5H", "APPT_2H",
  "STATUS_CHECK", "ASSIGN_PHLEBO", "REPORT_CHASE", "SUMMARY_TOMORROW",
];
/**
 * Off for every lab: noise or duplicates in the Oct 2026 chats. The 24 h / 30 min /
 * 10 min "unconfirmed" pings repeat the reminders and the evening list; "phlebo
 * on time?" asked about orders the lab was already handling; the 10:00
 * pending-reports list repeats the combined report chase.
 */
export const STANDARD_OFF = ["APPT_24H", "APPT_30M", "APPT_10M", "PHLEBO_ETA", "SUMMARY_PENDING_REPORTS"];

export async function applyStandardSet(now = new Date()) {
  const settings = await prisma.providerCommsSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
  if (settings.standardSetAt) return null;

  const report = { on: 0, off: 0, retired: 0, carried: 0, labs: 0 };
  for (const key of [...STANDARD_ON, ...STANDARD_OFF]) {
    const isActive = STANDARD_ON.includes(key);
    const updated = await prisma.providerMessageRule.updateMany({
      where: { builtInKey: key },
      data: { isActive, allowedLabIds: [], excludedLabIds: [], version: { increment: 1 } },
    });
    if (updated.count) report[isActive ? "on" : "off"] += 1;
  }

  // From the old system, or per-lab copies of a built-in: the standard set replaces them.
  const builtInNames = BUILT_IN_RULES.map((rule) => rule.name);
  const candidates = await prisma.providerMessageRule.findMany({ where: { builtInKey: null, isActive: true } });
  const retire = candidates.filter((rule) =>
    rule.milestoneLabel != null
    || rule.name.endsWith(" (converted)")
    || builtInNames.some((name) => rule.name.startsWith(`${name} — `) || rule.name.startsWith(`${name} (`)));
  // What a retired rule already sent counts as sent by the standard rule that
  // replaces it, so nothing is sent twice across the switch.
  for (const rule of retire) {
    const target = replacementFor(rule);
    if (!target) continue;
    const builtIn = await prisma.providerMessageRule.findUnique({ where: { builtInKey: target } });
    if (!builtIn) continue;
    const rows = await prisma.providerMessageLedger.findMany({ where: { ruleId: rule.id, entityType: "ORDER", shadow: false } });
    if (rows.length === 0) continue;
    report.carried += (await prisma.providerMessageLedger.createMany({
      data: rows.map(({ id: _id, ruleId: _rule, ...row }) => { void _id; void _rule; return { ...row, ruleId: builtIn.id, ruleVersion: builtIn.version, detail: `Carried over from "${rule.name}"` }; }),
      skipDuplicates: true,
    })).count;
  }
  if (retire.length) {
    report.retired = (await prisma.providerMessageRule.updateMany({
      where: { id: { in: retire.map((rule) => rule.id) } },
      data: { isActive: false, version: { increment: 1 } },
    })).count;
  }

  report.labs = (await prisma.nonApiLabConfig.updateMany({ data: { batchingMode: "LIVE" } })).count;
  await prisma.providerCommsSettings.update({ where: { id: "default" }, data: { standardSetAt: now } });
  console.log(`[MessageRules] Standard message set applied: ${JSON.stringify(report)}`);
  return report;
}

const nearest = (value: number, options: Array<[string, number]>) =>
  options.reduce((best, option) => (Math.abs(option[1] - value) < Math.abs(best[1] - value) ? option : best))[0];

/** The standard rule a retired one is replaced by, for carrying its history over. */
function replacementFor(rule: ProviderMessageRule): string | null {
  const copied = BUILT_IN_RULES.find((builtIn) => rule.name.startsWith(`${builtIn.name} — `));
  if (copied) return copied.builtInKey;
  if (rule.milestoneLabel === "Report uploaded") return "REPORT_CHASE";
  if (!rule.name.endsWith(" (converted)")) return null;
  const cond = rule.triggerCondition as unknown as RuleCondition;
  if (typeof cond.minutesSinceCreated === "number") {
    return nearest(cond.minutesSinceCreated, [["REMINDER_1H", 60], ["REMINDER_3H", 180], ["ESCALATION_5H", 300]]);
  }
  if (typeof cond.minutesBeforeAppointment === "number") return "APPT_2H";
  if (typeof cond.minutesAfterAppointment === "number") return cond.minutesAfterAppointment <= 120 ? "STATUS_CHECK" : "REPORT_CHASE";
  return null;
}
