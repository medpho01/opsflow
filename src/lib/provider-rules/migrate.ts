/**
 * The one-time move to message rules. Runs on the first engine pass after
 * deploy (guarded by ProviderCommsSettings.rulesMigratedAt) so nothing has
 * to be set up again:
 *
 *   1. seed the built-in rules;
 *   2. turn per-lab settings into rule scopes — appointment pings, status
 *      check, evening list (and its time), custom reminder timings and
 *      custom templates per lab;
 *   3. convert the legacy timed rules and the delivery-deadline watchers;
 *   4. record what was already sent (reminders, deadline alerts, today's
 *      evening list) so nothing goes twice;
 *   5. retire the legacy scheduler's pending steps.
 *
 * Nothing is deleted: the legacy tables stay, unused.
 */
import { Prisma, type NonApiLabConfig, type ProviderMessageRule } from "@prisma/client";
import prisma from "@/lib/db/client";
import { BUILT_IN_RULES, LEGACY_RUNG_TO_BUILT_IN, OPEN_CONVERSATION } from "./builtins";
import { localDayKey } from "./evaluate";
import { TIME_ZONE } from "./format";
import type { RuleCondition } from "./types";

const STATUS_RANK = [
  "PENDING", "CREATED", "ORDER_SCHEDULED", "RESCHEDULED", "PHLEBO_ASSIGNED", "KIT_DISPATCHED",
  "PATIENT_VISITED", "SAMPLE_COLLECTED", "SAMPLE_DELIVERED", "SAMPLE_PROCESSED", "REPORT_DELIVERED",
];
/** The status at or beyond which each milestone is done (as the deadline engine judged it). */
const MILESTONE_DONE_AT: Record<string, string> = {
  ORDER_CONFIRMED: "PHLEBO_ASSIGNED",
  PHLEBO_ASSIGNED: "PHLEBO_ASSIGNED",
  SAMPLE_COLLECTED: "SAMPLE_COLLECTED",
  SAMPLE_DELIVERED: "SAMPLE_DELIVERED",
  REPORT_UPLOADED: "REPORT_DELIVERED",
};
const MILESTONE_LABELS: Record<string, string> = {
  ORDER_CONFIRMED: "Order confirmed",
  PHLEBO_ASSIGNED: "Phlebotomist assigned",
  SAMPLE_COLLECTED: "Sample collected",
  SAMPLE_DELIVERED: "Sample delivered to lab",
  REPORT_UPLOADED: "Report uploaded",
};
/** Statuses in which a milestone is still outstanding. */
export function statusesBefore(milestone: string): string[] {
  return STATUS_RANK.slice(0, STATUS_RANK.indexOf(MILESTONE_DONE_AT[milestone] ?? "REPORT_DELIVERED"));
}

const MILESTONE_SEQUENCE = ["ORDER_CONFIRMED", "PHLEBO_ASSIGNED", "SAMPLE_COLLECTED", "SAMPLE_DELIVERED", "REPORT_UPLOADED"];

/**
 * Statuses in which a deadline watcher was counting. Anchored on the previous
 * milestone, it only counted once that milestone was done ("delivered within
 * 3 h of collection" starts at collection), so only the statuses between the
 * two qualify. Otherwise: every status before the milestone.
 */
export function milestoneStatuses(milestone: string, anchor: string): string[] {
  const previous = MILESTONE_SEQUENCE[MILESTONE_SEQUENCE.indexOf(milestone) - 1];
  if (anchor !== "PREV_MILESTONE_COMPLETED" || !previous) return statusesBefore(milestone);
  // A confirmed order is a scheduled one.
  const from = previous === "ORDER_CONFIRMED" ? "ORDER_SCHEDULED" : MILESTONE_DONE_AT[previous];
  return STATUS_RANK.slice(STATUS_RANK.indexOf(from), STATUS_RANK.indexOf(MILESTONE_DONE_AT[milestone] ?? "REPORT_DELIVERED"));
}

/** Stages that happen at or after the visit: never overdue before the appointment. */
const AFTER_VISIT = new Set(["SAMPLE_COLLECTED", "SAMPLE_DELIVERED", "REPORT_UPLOADED"]);

/** A watcher's full condition: its statuses, its timing and, for after-visit stages, "the appointment has passed". */
export function milestoneCondition(milestone: string, anchor: string, offsetMinutes: number): RuleCondition {
  const cond: RuleCondition = { statusIn: milestoneStatuses(milestone, anchor), ...milestoneTiming(anchor, offsetMinutes) };
  if (AFTER_VISIT.has(milestone) && cond.minutesAfterAppointment == null && cond.minutesBeforeAppointment == null) cond.minutesAfterAppointment = 0;
  return cond;
}

/**
 * Watchers converted before milestoneCondition existed (Oct 2026) counted from
 * the last status change in ANY earlier status and ignored the appointment, so
 * "sample delivered within 3 h of collection" fired for an order merely
 * scheduled days ahead. Brings them in line; a no-op once done.
 */
async function repairMilestoneRules() {
  const rules = await prisma.providerMessageRule.findMany({ where: { milestoneLabel: { not: null }, builtInKey: null } });
  for (const rule of rules) {
    const milestone = Object.keys(MILESTONE_LABELS).find((key) => MILESTONE_LABELS[key] === rule.milestoneLabel);
    const cond = rule.triggerCondition as unknown as RuleCondition;
    if (!milestone) continue;
    const next: RuleCondition = { ...cond };
    // Counted from the previous step: only once that step is done.
    if (cond.minutesSinceStatusUpdated != null && JSON.stringify(cond.statusIn) === JSON.stringify(statusesBefore(milestone))) {
      next.statusIn = milestoneStatuses(milestone, "PREV_MILESTONE_COMPLETED");
    }
    // Collection, delivery, report: never overdue before the appointment.
    if (AFTER_VISIT.has(milestone) && cond.minutesAfterAppointment == null && cond.minutesBeforeAppointment == null) next.minutesAfterAppointment = 0;
    if (JSON.stringify(next) === JSON.stringify(cond)) continue;
    await prisma.providerMessageRule.update({
      where: { id: rule.id },
      data: { triggerCondition: next as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
    });
    console.log(`[MessageRules] "${rule.name}": now counts only in ${(next.statusIn ?? []).join(", ")}${next.minutesAfterAppointment != null ? ", after the appointment" : ""}`);
  }
}

/** A deadline config's anchor + offset as a Task-Rule timing field. */
export function milestoneTiming(anchor: string, offsetMinutes: number): Partial<RuleCondition> {
  if (anchor === "ORDER_CREATED") return { minutesSinceCreated: Math.max(0, offsetMinutes) };
  if (anchor === "APPOINTMENT_TIME") {
    return offsetMinutes >= 0 ? { minutesAfterAppointment: offsetMinutes } : { minutesBeforeAppointment: -offsetMinutes };
  }
  // PREV_MILESTONE_COMPLETED: the previous stage was reached when the status last changed.
  return { minutesSinceStatusUpdated: Math.max(0, offsetMinutes) };
}

const LADDER_KEYS = ["REMINDER_1H", "REMINDER_3H", "ESCALATION_5H", "APPT_24H", "APPT_2H", "APPT_30M", "APPT_10M"];
const SLOT_KEYS: Record<string, { field: keyof NonApiLabConfig; standard: string; keys: string[] }> = {
  initial: { field: "initialTemplateKey", standard: "NON_API_NEW_ORDER", keys: ["NEW_ORDER"] },
  reminder: { field: "reminderTemplateKey", standard: "NON_API_REMINDER", keys: ["REMINDER_1H", "REMINDER_3H"] },
  escalation: { field: "escalationTemplateKey", standard: "NON_API_ESCALATION", keys: ["ESCALATION_5H"] },
  appointment: { field: "appointmentTemplateKey", standard: "NON_API_APPOINTMENT_REMINDER", keys: ["APPT_24H", "APPT_2H", "APPT_30M", "APPT_10M"] },
};

type Report = { seeded: number; cloned: number; converted: number; imported: number; retired: number; notes: string[] };

async function seedBuiltIns(report: Report) {
  for (const builtIn of BUILT_IN_RULES) {
    try {
      await prisma.providerMessageRule.create({
        data: { ...builtIn, triggerCondition: builtIn.triggerCondition as unknown as Prisma.InputJsonValue },
      });
      report.seeded += 1;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
    }
  }
}

/** Restrict a built-in to the labs that had a per-lab switch on (none → paused). */
async function scopeToLabs(key: string, labIds: number[], allLabIds: number[]) {
  if (labIds.length === 0) {
    await prisma.providerMessageRule.update({ where: { builtInKey: key }, data: { isActive: false } });
  } else if (labIds.length < allLabIds.length) {
    await prisma.providerMessageRule.update({ where: { builtInKey: key }, data: { allowedLabIds: labIds } });
  }
}

/** A lab-specific copy of a built-in, with the built-in stepping aside for that lab. */
async function cloneForLab(builtIn: ProviderMessageRule, lab: NonApiLabConfig, overrides: Partial<Prisma.ProviderMessageRuleCreateInput>, report: Report) {
  const { id: _id, builtInKey: _key, createdAt: _c, updatedAt: _u, ...rest } = builtIn;
  void _id; void _key; void _c; void _u;
  await prisma.providerMessageRule.create({
    data: {
      ...(rest as unknown as Prisma.ProviderMessageRuleCreateInput),
      triggerCondition: rest.triggerCondition as Prisma.InputJsonValue,
      name: `${builtIn.name} — ${lab.labName}`,
      allowedLabIds: [lab.labId],
      excludedLabIds: [],
      version: 1,
      ...overrides,
    },
  });
  const excluded = new Set((builtIn.excludedLabIds as number[]) ?? []);
  excluded.add(lab.labId);
  await prisma.providerMessageRule.update({ where: { id: builtIn.id }, data: { excludedLabIds: [...excluded] } });
  report.cloned += 1;
}

async function convertLabSettings(configs: NonApiLabConfig[], report: Report) {
  const nonApi = configs.filter((c) => c.integrationType === "NON_API");
  const nonApiIds = nonApi.map((c) => c.labId);

  // Appointment pings and the status check were per-lab switches.
  const pings = nonApi.filter((c) => c.appointmentRemindersEnabled).map((c) => c.labId);
  for (const key of ["APPT_24H", "APPT_2H", "APPT_30M", "APPT_10M"]) await scopeToLabs(key, pings, nonApiIds);
  await scopeToLabs("STATUS_CHECK", nonApi.filter((c) => c.postAppointmentCheckEnabled).map((c) => c.labId), nonApiIds);

  // The evening list: on per lab, at a time per lab. One rule per distinct time.
  const digestLabs = configs.filter((c) => c.dailyDigestEnabled);
  const byTime = new Map<string, NonApiLabConfig[]>();
  for (const config of digestLabs) {
    const key = `${config.dailyDigestHour}:${config.dailyDigestMinute}`;
    byTime.set(key, [...(byTime.get(key) ?? []), config]);
  }
  const summary = await prisma.providerMessageRule.findUniqueOrThrow({ where: { builtInKey: "SUMMARY_TOMORROW" } });
  const groups = [...byTime.values()];
  if (groups.length === 0) {
    await prisma.providerMessageRule.update({ where: { id: summary.id }, data: { isActive: false } });
  } else {
    const [first, ...others] = groups;
    await prisma.providerMessageRule.update({
      where: { id: summary.id },
      data: { allowedLabIds: first.map((c) => c.labId), summaryHour: first[0].dailyDigestHour, summaryMinute: first[0].dailyDigestMinute },
    });
    for (const group of others) {
      const { id: _id, builtInKey: _k, createdAt: _c, updatedAt: _u, ...rest } = summary;
      void _id; void _k; void _c; void _u;
      const at = `${String(group[0].dailyDigestHour).padStart(2, "0")}:${String(group[0].dailyDigestMinute).padStart(2, "0")}`;
      await prisma.providerMessageRule.create({
        data: {
          ...(rest as unknown as Prisma.ProviderMessageRuleCreateInput),
          triggerCondition: rest.triggerCondition as Prisma.InputJsonValue,
          name: `${summary.name} (${at})`,
          allowedLabIds: group.map((c) => c.labId),
          summaryHour: group[0].dailyDigestHour,
          summaryMinute: group[0].dailyDigestMinute,
        },
      });
      report.cloned += 1;
    }
  }

  // Custom reminder timings and custom templates were per lab: those labs get their own copies.
  for (const lab of nonApi) {
    const timings: Record<string, number> = {};
    if (lab.confirmationSlaMinutes !== 60) timings.REMINDER_1H = lab.confirmationSlaMinutes;
    if (lab.reminderSlaMinutes !== 180) timings.REMINDER_3H = lab.reminderSlaMinutes;
    if (lab.escalationSlaMinutes !== 300) timings.ESCALATION_5H = lab.escalationSlaMinutes;
    const templates: Record<string, string> = {};
    for (const slot of Object.values(SLOT_KEYS)) {
      const labKey = lab[slot.field] as string;
      if (labKey && labKey !== slot.standard) for (const key of slot.keys) templates[key] = labKey;
    }
    for (const key of new Set([...Object.keys(timings), ...Object.keys(templates)])) {
      const builtIn = await prisma.providerMessageRule.findUniqueOrThrow({ where: { builtInKey: key } });
      const cond = builtIn.triggerCondition as unknown as RuleCondition;
      await cloneForLab(builtIn, lab, {
        ...(timings[key] ? { triggerCondition: { ...cond, minutesSinceCreated: timings[key] } as unknown as Prisma.InputJsonValue } : {}),
        ...(templates[key] ? { templateKey: templates[key] } : {}),
      }, report);
      report.notes.push(`${lab.labName}: own copy of "${builtIn.name}"`);
    }
  }
}

async function convertLegacyRules(configs: NonApiLabConfig[], report: Report): Promise<Map<string, ProviderMessageRule>> {
  const convertedFrom = new Map<string, ProviderMessageRule>();
  const legacy = await prisma.providerCommunicationRule.findMany();
  const settings = await prisma.providerCommsSettings.findUnique({ where: { id: "default" } });
  const milestoneConfigs = await prisma.slaMilestoneConfig.findMany();
  const labName = (id: number) => configs.find((c) => c.labId === id)?.labName ?? `lab ${id}`;

  // Timed sequence rules: they replaced the built-in ladder for the labs they covered.
  const sequence = legacy.filter((rule) => rule.triggerKind === "RELATIVE_DELAY" && rule.isActive);
  const covered = new Set<number>();
  let coversAll = false;
  for (const rule of sequence) {
    const labs = ((rule.allowedLabIds as number[]) ?? []).map(Number);
    if (labs.length === 0) coversAll = true;
    labs.forEach((id) => covered.add(id));
    const send = (rule.sendCondition ?? {}) as { sourceStatusIn?: string[]; workflowStatusIn?: string[]; sendWindow?: { startHour: number; endHour: number } };
    const cond: RuleCondition = { statusIn: send.sourceStatusIn ?? [] };
    if (rule.anchor === "ORDER") cond.minutesSinceCreated = Math.max(0, rule.offsetMinutes);
    else if (rule.offsetMinutes <= 0) cond.minutesBeforeAppointment = -rule.offsetMinutes;
    else cond.minutesAfterAppointment = rule.offsetMinutes;
    const converted = await prisma.providerMessageRule.create({
      data: {
        name: `${rule.name} (converted)`,
        description: `Converted from the earlier timed rule "${rule.name}".`,
        allowedLabIds: labs,
        allowedOrderTypes: (rule.allowedOrderTypes as string[]) ?? [],
        triggerCondition: cond as unknown as Prisma.InputJsonValue,
        conversationStatusIn: send.workflowStatusIn?.length ? send.workflowStatusIn : OPEN_CONVERSATION,
        onlyIfIntroduced: true,
        notAfterAppointment: true,
        action: rule.action === "ESCALATE" ? "ESCALATE" : "SEND",
        recipient: rule.recipient === "MANAGER" ? "MANAGER" : "LAB",
        templateKey: rule.templateKey,
        priority: rule.priority,
        sendWindowStartHour: send.sendWindow?.startHour ?? null,
        sendWindowEndHour: send.sendWindow?.endHour ?? null,
      },
    });
    convertedFrom.set(rule.id, converted);
    report.converted += 1;
  }
  if (coversAll) {
    await prisma.providerMessageRule.updateMany({ where: { builtInKey: { in: LADDER_KEYS } }, data: { isActive: false } });
  } else if (covered.size > 0) {
    for (const key of LADDER_KEYS) {
      const builtIn = await prisma.providerMessageRule.findUniqueOrThrow({ where: { builtInKey: key } });
      const excluded = new Set([...((builtIn.excludedLabIds as number[]) ?? []), ...covered]);
      await prisma.providerMessageRule.update({ where: { id: builtIn.id }, data: { excludedLabIds: [...excluded] } });
    }
  }
  // A lab's own copies of the ladder (custom timings) are replaced too.
  if (coversAll || covered.size > 0) {
    const ladder = await prisma.providerMessageRule.findMany({ where: { builtInKey: { in: LADDER_KEYS } } });
    const copies = await prisma.providerMessageRule.findMany({ where: { builtInKey: null } });
    for (const copy of copies) {
      const labs = ((copy.allowedLabIds as number[]) ?? []).map(Number);
      const isLadderCopy = ladder.some((builtIn) => copy.name.startsWith(`${builtIn.name} — `));
      if (isLadderCopy && labs.length === 1 && (coversAll || covered.has(labs[0]))) {
        await prisma.providerMessageRule.update({ where: { id: copy.id }, data: { isActive: false } });
      }
    }
  }

  // Delivery-deadline watchers → "repeat while late" rules.
  const watchers = legacy.filter((rule) => rule.triggerKind === "SLA_BREACH" && rule.slaMilestone);
  const sendingEnabled = !!settings?.slaBreachEnabled && !settings?.slaBreachDryRun;
  for (const watcher of watchers) {
    const labs = ((watcher.allowedLabIds as number[]) ?? []).map(Number);
    const milestone = watcher.slaMilestone!;
    // A lab's own deadline config wins over the global one, as the engine resolved it.
    const configFor = (labId: number | null) =>
      milestoneConfigs.find((c) => c.milestone === milestone && c.labId === labId)
      ?? milestoneConfigs.find((c) => c.milestone === milestone && c.labId === null);
    const groups = labs.length > 0 ? labs.map((labId) => ({ labIds: [labId], config: configFor(labId) })) : [{ labIds: [] as number[], config: configFor(null) }];
    for (const { labIds, config } of groups) {
      if (!config) { report.notes.push(`"${watcher.name}": no deadline configured, not converted`); continue; }
      const quiet = !config.ignoreQuietHours && settings?.quietHoursStart != null && settings?.quietHoursEnd != null;
      const created = await prisma.providerMessageRule.create({
        data: {
          name: `${MILESTONE_LABELS[milestone]} overdue${labIds.length ? ` — ${labIds.map(labName).join(", ")}` : ""}`,
          description: `Converted from the delivery-deadline watcher "${watcher.name}". Repeats while the order is still before "${MILESTONE_LABELS[milestone]}".`,
          isActive: watcher.isActive && config.enabled && sendingEnabled,
          allowedLabIds: labIds,
          integrationTypes: [],
          triggerCondition: milestoneCondition(milestone, config.anchor, config.offsetMinutes) as unknown as Prisma.InputJsonValue,
          onlyIfIntroduced: false,
          templateKey: watcher.templateKey || "PROVIDER_SLA_MILESTONE",
          milestoneLabel: MILESTONE_LABELS[milestone],
          priority: watcher.priority,
          repeatEveryMinutes: config.maxAttempts > 1 ? config.repeatIntervalMinutes : null,
          maxSends: Math.max(1, config.maxAttempts),
          // Quiet hours become the rule's send window (the hours outside them).
          sendWindowStartHour: quiet ? settings!.quietHoursEnd : null,
          sendWindowEndHour: quiet ? settings!.quietHoursStart : null,
        },
      });
      report.converted += 1;
      // Alerts already sent count as this rule's occurrences.
      const events = await prisma.slaBreachEvent.findMany({
        where: { milestone, attemptsSent: { gt: 0 }, ...(labIds.length ? { labId: { in: labIds } } : {}) },
      });
      const rows: Prisma.ProviderMessageLedgerCreateManyInput[] = [];
      for (const event of events) {
        for (let occurrence = 1; occurrence <= event.attemptsSent; occurrence += 1) {
          rows.push({
            ruleId: created.id, ruleVersion: 1, entityType: "ORDER", entityId: event.orderId, labId: event.labId,
            occurrence, outcome: "IMPORTED", shadow: false, detail: "Sent by the delivery-deadline watcher",
            createdAt: event.lastSentAt ?? event.firstBreachedAt,
          });
        }
      }
      if (rows.length) report.imported += (await prisma.providerMessageLedger.createMany({ data: rows, skipDuplicates: true })).count;
    }
  }
  return convertedFrom;
}

async function importLegacySends(convertedFrom: Map<string, ProviderMessageRule>, report: Report) {
  const all = await prisma.providerMessageRule.findMany();
  const byKey = new Map(all.filter((rule) => rule.builtInKey).map((rule) => [rule.builtInKey!, rule]));
  // A lab with its own timings has its own copy of the built-in; its earlier sends belong to that copy.
  const ruleFor = (builtInKey: string | undefined, labId: number) => {
    const builtIn = builtInKey ? byKey.get(builtInKey) : undefined;
    if (!builtIn) return undefined;
    return all.find((rule) => !rule.builtInKey && rule.name.startsWith(`${builtIn.name} — `)
      && ((rule.allowedLabIds as number[]) ?? []).map(Number).includes(labId)) ?? builtIn;
  };
  const rows: Prisma.ProviderMessageLedgerCreateManyInput[] = [];

  // Timed steps: non-api:<orderId>:<rungKey or earlier rule id>:<runAt>
  const timed = await prisma.labCommunication.findMany({
    where: { type: { in: ["REMINDER", "ESCALATION"] }, orderId: { not: null }, labId: { not: null }, idempotencyKey: { startsWith: "non-api:" } },
    select: { id: true, orderId: true, labId: true, idempotencyKey: true, createdAt: true },
  });
  for (const sent of timed) {
    const step = sent.idempotencyKey.split(":")[2] ?? "";
    const rule = convertedFrom.get(step) ?? ruleFor(LEGACY_RUNG_TO_BUILT_IN[step], sent.labId!);
    if (!rule) continue;
    rows.push({
      ruleId: rule.id, ruleVersion: rule.version, entityType: "ORDER", entityId: sent.orderId!, labId: sent.labId!,
      occurrence: 1, outcome: "IMPORTED", shadow: false, communicationId: sent.id, detail: "Sent by the earlier scheduler", createdAt: sent.createdAt,
    });
  }

  // Today's evening list: provider-digest:<labId>:<YYYY-MM-DD>
  const today = localDayKey(new Date(), TIME_ZONE());
  const digests = await prisma.labCommunication.findMany({
    where: { type: "DAILY_DIGEST", idempotencyKey: { endsWith: `:${today}` } },
    select: { id: true, labId: true, createdAt: true },
  });
  const summaries = await prisma.providerMessageRule.findMany({ where: { kind: "SUMMARY", templateKey: "PROVIDER_DAILY_DIGEST" } });
  for (const digest of digests) {
    if (!digest.labId) continue;
    const rule = summaries.find((r) => ((r.allowedLabIds as number[]) ?? []).includes(digest.labId!)) ?? summaries[0];
    if (!rule) continue;
    rows.push({
      ruleId: rule.id, ruleVersion: rule.version, entityType: "LAB_SUMMARY", entityId: digest.labId, labId: digest.labId,
      occurrence: Number(today.replaceAll("-", "")), outcome: "IMPORTED", shadow: false, communicationId: digest.id, createdAt: digest.createdAt,
    });
  }
  if (rows.length) report.imported += (await prisma.providerMessageLedger.createMany({ data: rows, skipDuplicates: true })).count;
}

/** Run the move once. Safe to call on every pass. */
export async function ensureMigratedToRules(): Promise<Report | null> {
  await repairMilestoneRules();
  // Polls were dropped (Oct 2026): labs answer in their own words. Clears any rule still
  // carrying one; a no-op after the first pass.
  await prisma.providerMessageRule.updateMany({ where: { pollKey: { not: null } }, data: { pollKey: null } });
  await prisma.providerMessageRule.updateMany({
    where: { builtInKey: "STATUS_CHECK", description: { contains: "one-tap poll" } },
    data: { description: BUILT_IN_RULES.find((rule) => rule.builtInKey === "STATUS_CHECK")!.description },
  });
  const settings = await prisma.providerCommsSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
  if (settings.rulesMigratedAt) return null;

  const report: Report = { seeded: 0, cloned: 0, converted: 0, imported: 0, retired: 0, notes: [] };
  // A rules engine that ran before this migration (Oct 2026 stage 1) left
  // built-ins seeded; seeding only creates the missing ones.
  await seedBuiltIns(report);
  const configs = await prisma.nonApiLabConfig.findMany();
  await convertLabSettings(configs, report);
  const convertedFrom = await convertLegacyRules(configs, report);
  await importLegacySends(convertedFrom, report);
  report.retired = (await prisma.labScheduledAction.updateMany({
    where: { status: { in: ["PENDING", "RUNNING"] } },
    data: { status: "SUPPRESSED", cancelledAt: new Date(), completedAt: new Date(), lastError: "Replaced by message rules", lockedAt: null, lockedBy: null },
  })).count;

  await prisma.providerCommsSettings.update({ where: { id: "default" }, data: { rulesMigratedAt: new Date(), messageRulesMode: "LIVE" } });
  console.log(`[MessageRules] Moved to message rules: ${JSON.stringify(report)}`);
  return report;
}
