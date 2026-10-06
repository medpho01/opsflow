/**
 * Provider communication scenarios — create orders locally, run the real
 * engine through simulated time, and read what labs would receive as a
 * transcript:
 *
 *   [Wed 7 Oct 09:00] Message 3 → Sim Lab A group: Reminder — 1 hour after the order · order #999100001
 *
 * Nothing is sent: no gateway runs, so messages stop in wa_outbound and are
 * read back from there. Each scenario lists what must happen and the run
 * fails if the transcript differs.
 *
 *   bash scripts/provider-comms-sim.sh            # all scenarios
 *   bash scripts/provider-comms-sim.sh "phlebo"   # scenarios whose name matches
 *
 * Needs two THROWAWAY databases (the .sh builds them) and refuses otherwise:
 *   SOURCE_DATABASE_URL  a LabStack copy named *_sim   (orders are created in it)
 *   DATABASE_URL         an OpsFlow DB named *scratch* (reset between scenarios)
 *
 * The pattern reply reader is used (PROVIDER_REPLY_EXTRACTOR=stub) so runs
 * are deterministic. Patient names are never printed.
 */
import prisma from "@/lib/db/client";
import { labstack } from "@/lib/db/labstack";
import { runNonApiLabTick } from "@/lib/non-api-labs/runner";

// ── Guard ────────────────────────────────────────────────────────────────
const dbName = (url: string | undefined) => (url ?? "").split("/").pop()?.split("?")[0] ?? "";
if (!dbName(process.env.SOURCE_DATABASE_URL).endsWith("_sim")) throw new Error("Refusing: SOURCE_DATABASE_URL must be a *_sim LabStack copy");
if (!/scratch/.test(dbName(process.env.DATABASE_URL))) throw new Error("Refusing: DATABASE_URL must be a scratch OpsFlow DB");
process.env.PROVIDER_REPLY_EXTRACTOR = "stub";

// ── Virtual clock (IST) ──────────────────────────────────────────────────
const DAY = "2026-10-07";
/** "09:30" (IST on the test day) or "+1d 19:00" → instant. */
function at(time: string): Date {
  const [dayPart, clock] = time.includes(" ") ? time.split(" ") : ["", time];
  const days = dayPart ? Number(dayPart.replace("d", "")) : 0;
  const base = new Date(`${DAY}T${clock}:00+05:30`);
  return new Date(base.getTime() + days * 86_400_000);
}
const ist = (d: Date) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).format(d).replace(",", "");
const naive = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "");

// ── Labs ─────────────────────────────────────────────────────────────────
type LabKey = "A" | "B";
const LABS: Record<LabKey, { labId: number; name: string; jid: string; manager: string }> = {
  A: { labId: 5, name: "Sim Lab A", jid: "120363000000000101@g.us", manager: "919000000101" },
  B: { labId: 4, name: "Sim Lab B", jid: "120363000000000102@g.us", manager: "919000000102" },
};
const templateOrder = new Map<number, number>();
let nextOrderId = 0;
const aliases = new Map<number, string>();

async function prepareLabStack() {
  const labIds = Object.values(LABS).map((l) => l.labId);
  // Only scenario orders are open: everything else of these labs is parked.
  await labstack.$executeRawUnsafe(
    `UPDATE public."Order" SET "orderStatus" = 'REPORT_DELIVERED' WHERE "labId" = ANY($1::int[]) AND id < 999100000`, labIds);
  await labstack.$executeRawUnsafe(`UPDATE public."Order" SET "orderStatus" = 'CANCELED' WHERE id >= 999100000`);
  for (const labId of labIds) {
    const [row] = await labstack.$queryRawUnsafe<Array<{ id: number }>>(
      `SELECT o.id FROM public."Order" o
        WHERE o."labId" = $1 AND o."orderType" = 'HOME_SAMPLE'
          AND EXISTS (SELECT 1 FROM public."Profile" p WHERE p."profileUserId" = o."userId")
          AND EXISTS (SELECT 1 FROM public."_OrderToPackage" op WHERE op."A" = o.id)
        ORDER BY o.id DESC LIMIT 1`, labId);
    templateOrder.set(labId, row.id);
  }
  const [{ max }] = await labstack.$queryRawUnsafe<Array<{ max: number }>>(`SELECT GREATEST(max(id), 999100000) AS max FROM public."Order"`);
  nextOrderId = Number(max) + 1;
}

async function resetOpsFlow(migrate = true) {
  await prisma.$executeRawUnsafe(`TRUNCATE taskos.provider_message_ledger, taskos.provider_message_rules, taskos.provider_order_facts,
    taskos.wa_polls, taskos.wa_messages, taskos.wa_outbound, taskos.lab_communications, taskos.lab_communication_workflows,
    taskos.non_api_lab_configs, taskos.wa_groups, taskos.provider_comms_settings, taskos.lab_communication_templates,
    taskos.provider_communication_rules, taskos.sla_milestone_configs, taskos.lab_scheduled_actions CASCADE`);
  for (const lab of Object.values(LABS)) {
    await prisma.waGroup.create({ data: { jid: lab.jid, subject: `LS<>${lab.name}`, active: true, sendEnabled: true, isMember: true } });
    await prisma.nonApiLabConfig.create({ data: {
      labId: lab.labId, labName: lab.name, waGroupJid: lab.jid, quietWindowMinutes: 10,
      managerName: "Manager", managerWhatsapp: lab.manager,
      // The evening list is on for both labs, as it is in production.
      dailyDigestEnabled: true, createdAt: at("-30d 09:00"),
    } });
  }
  // A tick at the start runs the one-time move to rules (seeds the built-ins).
  if (migrate) await runNonApiLabTick(at("-30d 09:00"));
}

// ── Scenario steps ───────────────────────────────────────────────────────
type OrderSpec = { lab?: LabKey; status?: string; placed: string; appointment: string | null; alias: string; phlebo?: [string, string] };

async function createOrder(spec: OrderSpec): Promise<number> {
  const labId = LABS[spec.lab ?? "A"].labId;
  const id = nextOrderId++;
  const placed = at(spec.placed);
  const patch = {
    id, labId, orderStatus: spec.status ?? "CREATED", orderType: "HOME_SAMPLE",
    createdAt: naive(placed), updatedAt: naive(placed), statusUpdatedAt: naive(placed),
    appointmentTime: spec.appointment ? naive(at(spec.appointment)) : null,
    phleboName: spec.phlebo?.[0] ?? null, phleboNumber: spec.phlebo?.[1] ?? null, labOrderId: null,
  };
  await labstack.$executeRawUnsafe(
    `INSERT INTO public."Order" SELECT (jsonb_populate_record(NULL::public."Order", to_jsonb(o) || $2::jsonb)).* FROM public."Order" o WHERE o.id = $1`,
    templateOrder.get(labId), JSON.stringify(patch));
  await labstack.$executeRawUnsafe(`INSERT INTO public."_OrderToPackage" ("A", "B") SELECT $1, "B" FROM public."_OrderToPackage" WHERE "A" = $2`, id, templateOrder.get(labId));
  aliases.set(id, spec.alias);
  return id;
}

async function updateOrder(id: number, when: string, change: { status?: string; phlebo?: [string, string] }) {
  const t = naive(at(when));
  if (change.status) await labstack.$executeRawUnsafe(`UPDATE public."Order" SET "orderStatus" = $2::text::"OrderStatus", "statusUpdatedAt" = $3::timestamp, "updatedAt" = $3::timestamp WHERE id = $1`, id, change.status, t);
  if (change.phlebo) await labstack.$executeRawUnsafe(`UPDATE public."Order" SET "phleboName" = $2, "phleboNumber" = $3 WHERE id = $1`, id, change.phlebo[0], change.phlebo[1]);
}

/** The lab writes in its group, optionally quoting our latest message about an order. */
async function labReplies(lab: LabKey, when: string, text: string, quotingOrder?: number) {
  const group = await prisma.waGroup.findUniqueOrThrow({ where: { jid: LABS[lab].jid } });
  let replyToWaId: string | null = null;
  if (quotingOrder) {
    const ours = await prisma.labCommunication.findFirst({ where: { orderId: quotingOrder }, orderBy: { createdAt: "desc" } });
    if (ours?.waOutboundId) {
      replyToWaId = `sim-out-${ours.waOutboundId}`;
      await prisma.waOutbound.update({ where: { id: ours.waOutboundId }, data: { sentWaMsgId: replyToWaId, status: "SENT", sentAt: at(when) } });
    }
  }
  await prisma.waMessage.create({ data: {
    waMsgId: `sim-in-${Date.now()}-${Math.random()}`, groupId: group.id, direction: "IN", fromMe: false,
    sender: `${LABS[lab].name} desk`, text, ts: at(when), replyToWaId, createdAt: at(when),
    // The gateway fills orderIds with the real orders a message names; do the same here.
    orderIds: [...aliases.keys()].filter((id) => text.includes(String(id))),
  } });
}

async function setRule(builtInKey: string, change: Record<string, unknown>) {
  await prisma.providerMessageRule.update({ where: { builtInKey }, data: { ...change, version: { increment: 1 } } });
}

// ── Transcript ───────────────────────────────────────────────────────────
type Line = { at: Date; text: string; short: string };
let transcript: Line[] = [];
const seen = new Set<string>();

async function collect() {
  const rows = await prisma.waOutbound.findMany({ where: { id: { notIn: [...seen] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  for (const row of rows) {
    seen.add(row.id);
    const communication = await prisma.labCommunication.findUnique({ where: { waOutboundId: row.id } });
    const lab = Object.values(LABS).find((l) => l.jid === row.targetJid);
    const labName = lab?.name ?? (await prisma.nonApiLabConfig.findFirst({ where: { managerWhatsapp: row.targetJid.split("@")[0] } }))?.labName ?? row.targetJid;
    const destination = lab ? `${labName} group` : `${labName} manager`;
    let what: string;
    let short: string;
    if (communication) {
      const rule = communication.ruleId ? await prisma.providerMessageRule.findUnique({ where: { id: communication.ruleId } }) : null;
      const about = communication.orderId ? ` · ${aliases.get(communication.orderId) ?? `order #${communication.orderId}`}` : "";
      what = `${rule?.name ?? communication.templateKey}${about}`;
      short = `${rule?.builtInKey ?? rule?.name}${about}`;
    } else {
      what = `reply: “${row.text.split("\n")[0].replace(/\(.*?\)/g, "(…)")}”`;
      short = "ack";
    }
    transcript.push({ at: row.createdAt, text: `[${ist(row.createdAt)}] Message ${transcript.length + 1} → ${destination}: ${what}`, short: `${ist(row.createdAt).split(" ").pop()} ${short}` });
  }
}

/** Run the minute tick every `step` minutes from `from` to `to` (inclusive). */
async function run(from: string, to: string, step = 5) {
  for (let t = at(from).getTime(); t <= at(to).getTime(); t += step * 60_000) {
    await runNonApiLabTick(new Date(t));
    await collect();
  }
}

// ── Scenarios ────────────────────────────────────────────────────────────
type Scenario = { name: string; run: () => Promise<void>; expect: string[]; upgrade?: boolean };

const scenarios: Scenario[] = [
  {
    name: "1. New order, confirmed within the hour — no reminders",
    run: async () => {
      const id = await createOrder({ placed: "09:00", appointment: "+1d 08:00", alias: "order-1" });
      await run("09:00", "09:35");
      await updateOrder(id, "09:40", { status: "ORDER_SCHEDULED" });
      await run("09:40", "15:00", 10);
    },
    expect: ["09:00 NEW_ORDER · order-1"],
  },
  {
    name: "2. Never confirmed — 1h, 3h, final reminder to the manager",
    run: async () => {
      await createOrder({ placed: "09:00", appointment: "+1d 08:00", alias: "order-2" });
      await run("09:00", "14:30", 5);
    },
    expect: ["09:00 NEW_ORDER · order-2", "10:00 REMINDER_1H · order-2", "12:00 REMINDER_3H · order-2", "14:00 ESCALATION_5H · order-2"],
  },
  {
    name: "3. Confirmed after the 1h reminder — the rest stop",
    run: async () => {
      const id = await createOrder({ placed: "09:00", appointment: "+1d 08:00", alias: "order-3" });
      await run("09:00", "10:30");
      await updateOrder(id, "10:35", { status: "ORDER_SCHEDULED" });
      await run("10:35", "15:00", 10);
    },
    expect: ["09:00 NEW_ORDER · order-3", "10:00 REMINDER_1H · order-3"],
  },
  {
    name: "4. Evening list of tomorrow's orders at 19:00",
    run: async () => {
      await createOrder({ status: "ORDER_SCHEDULED", placed: "-1d 10:00", appointment: "+1d 08:00", alias: "tomorrow-1" });
      await createOrder({ status: "CREATED", placed: "-1d 10:00", appointment: "+1d 09:30", alias: "tomorrow-2" });
      await run("18:55", "19:10", 5);
    },
    expect: ["19:00 SUMMARY_TOMORROW"],
  },
  {
    name: "5. Phlebo: intro, assign 2 h before (after the quiet window; stops when the lab names one), ETA 1 h before (stops on the ETA)",
    run: async () => {
      await setRule("ASSIGN_PHLEBO", { isActive: true });
      await setRule("PHLEBO_ETA", { isActive: true });
      const id = await createOrder({ status: "ORDER_SCHEDULED", placed: "-1d 10:00", appointment: "11:00", alias: "order-5" });
      await run("09:00", "09:10");
      await labReplies("A", "09:12", "Phlebo Ramesh 9876543210 will go", id);
      await run("09:15", "09:45");
      await updateOrder(id, "09:50", { status: "PHLEBO_ASSIGNED", phlebo: ["Ramesh", "9876543210"] });
      await run("09:50", "10:05");
      await labReplies("A", "10:07", "reaching by 10:50 am", id);
      await run("10:10", "10:55");
    },
    expect: ["09:00 NEW_ORDER · order-5", "09:10 ASSIGN_PHLEBO · order-5", "10:00 PHLEBO_ETA · order-5"],
  },
  {
    name: "6. Status check 30 min after the appointment, answered in the group — no repeat, sample-collected stops it",
    run: async () => {
      const id = await createOrder({ status: "ORDER_SCHEDULED", placed: "-1d 10:00", appointment: "11:00", alias: "order-6" });
      await run("11:25", "11:35");
      await labReplies("A", "11:37", "Patient not available, rescheduled to tomorrow 10 am", id);
      await run("11:40", "12:30", 10);
      // A second order: the lab says the sample is collected before the check is due.
      const other = await createOrder({ status: "ORDER_SCHEDULED", placed: "-1d 10:00", appointment: "12:00", alias: "order-6b" });
      await labReplies("A", "12:10", `Order ${other}: sample collected`);
      await run("12:15", "13:00", 5);
    },
    expect: ["11:30 STATUS_CHECK · order-6"],
  },
  {
    name: "7. Report chase 12 h after the appointment, repeats, stops when the report is shared",
    run: async () => {
      await setRule("REPORT_CHASE", { isActive: true });
      const id = await createOrder({ status: "SAMPLE_COLLECTED", placed: "-2d 10:00", appointment: "-1d 20:00", alias: "order-7" });
      await run("08:00", "11:05", 5);
      await labReplies("A", "11:10", "Report shared on whatsapp", id);
      await run("11:15", "15:00", 15);
    },
    expect: ["08:00 REPORT_CHASE · order-7", "11:00 REPORT_CHASE · order-7"],
  },
  {
    name: "8. Pending reports morning list",
    run: async () => {
      await setRule("SUMMARY_PENDING_REPORTS", { isActive: true });
      await setRule("REPORT_CHASE", { isActive: false });
      await createOrder({ status: "SAMPLE_PROCESSED", placed: "-3d 10:00", appointment: "-2d 08:00", alias: "pending-1" });
      await createOrder({ status: "SAMPLE_COLLECTED", placed: "-2d 10:00", appointment: "-1d 18:00", alias: "pending-2" });
      await run("09:55", "10:10", 5);
    },
    expect: ["10:00 SUMMARY_PENDING_REPORTS"],
  },
  {
    name: "9. Editing a rule applies to open orders — recent ones get it, long-past ones do not",
    run: async () => {
      await createOrder({ placed: "08:20", appointment: "+1d 08:00", alias: "order-9a" });
      await createOrder({ placed: "07:50", appointment: "+1d 08:00", alias: "order-9b" });
      await run("08:20", "08:30");
      await setRule("REMINDER_1H", { triggerCondition: { statusIn: ["PENDING", "CREATED"], minutesSinceCreated: 15 } });
      await run("08:40", "09:30");
    },
    expect: ["08:20 NEW_ORDER · order-9a", "08:20 NEW_ORDER · order-9b", "08:40 REMINDER_1H · order-9a"],
  },
  {
    name: "10. Cancelled order and paused rule — silence",
    run: async () => {
      const id = await createOrder({ placed: "09:00", appointment: "+1d 08:00", alias: "order-10" });
      await run("09:00", "09:05");
      await updateOrder(id, "09:20", { status: "CANCELED" });
      await setRule("STATUS_CHECK", { isActive: false });
      await run("09:30", "13:00", 30);
    },
    expect: ["09:00 NEW_ORDER · order-10"],
  },
  {
    name: "11. Upgrade from the old scheduler — history carries over, nothing is sent twice",
    upgrade: true,
    run: async () => {
      // Before the upgrade. Lab A: first reminder at 30 min (already sent for order-11a),
      // a step still queued in the old scheduler. Lab B: a custom timed rule in place of
      // the reminders, already sent for order-11b.
      await prisma.nonApiLabConfig.update({ where: { labId: LABS.A.labId }, data: { confirmationSlaMinutes: 30 } });
      const custom = await prisma.providerCommunicationRule.create({ data: {
        name: "Lab B nudge", triggerKind: "RELATIVE_DELAY", anchor: "ORDER", action: "SEND_REMINDER", offsetMinutes: 90,
        templateKey: "NON_API_REMINDER", allowedLabIds: [LABS.B.labId], isActive: true,
        sendCondition: { sourceStatusIn: ["PENDING", "CREATED"] },
      } });
      const legacy = async (lab: LabKey, alias: string, step: string, sentAt: string) => {
        const id = await createOrder({ lab, placed: "09:00", appointment: "+1d 08:00", alias });
        const workflow = await prisma.labCommunicationWorkflow.create({ data: {
          orderId: id, labId: LABS[lab].labId, orderSnapshot: {}, createdAt: at("09:00"),
          confirmationDeadline: at("10:00"), reminderDeadline: at("12:00"), escalationDeadline: at("14:00"),
        } });
        await prisma.labCommunication.create({ data: {
          workflowId: workflow.id, orderId: id, labId: LABS[lab].labId, type: "REMINDER", recipient: LABS[lab].jid,
          templateKey: "NON_API_REMINDER", templateVariables: {}, createdAt: at(sentAt),
          idempotencyKey: `non-api:${id}:${step}:${at(sentAt).toISOString()}`,
        } });
        return workflow;
      };
      const workflowA = await legacy("A", "order-11a", "ORDER_CONFIRMATION", "09:30");
      await legacy("B", "order-11b", custom.id, "10:30");
      await prisma.labScheduledAction.create({ data: {
        workflowId: workflowA.id, type: "SEND_REMINDER", runAt: at("12:00"), idempotencyKey: "sim-legacy-step",
      } });

      await run("10:35", "14:30", 5); // the first tick runs the upgrade

      const queued = await prisma.labScheduledAction.findUniqueOrThrow({ where: { idempotencyKey: "sim-legacy-step" } });
      if (queued.status !== "SUPPRESSED") throw new Error(`old scheduler step still ${queued.status}`);
    },
    expect: ["12:00 REMINDER_3H · order-11a", "14:00 ESCALATION_5H · order-11a"],
  },
  {
    name: "12. 'Sample delivered within 3 h of collection' — counts from collection, not from scheduling (repairs the earlier conversion)",
    run: async () => {
      // The rule as the first conversion wrote it: any status before delivery, 3 h after the last status change.
      await prisma.providerMessageRule.create({ data: {
        name: "Sample delivered to lab overdue", milestoneLabel: "Sample delivered to lab", integrationTypes: [], onlyIfIntroduced: false,
        triggerCondition: { statusIn: ["PENDING", "CREATED", "ORDER_SCHEDULED", "RESCHEDULED", "PHLEBO_ASSIGNED", "KIT_DISPATCHED", "PATIENT_VISITED", "SAMPLE_COLLECTED"], minutesSinceStatusUpdated: 180 },
        templateKey: "PROVIDER_SLA_MILESTONE", priority: 2, repeatEveryMinutes: 60, maxSends: 3,
      } });
      // Scheduled two days out (the reported case): not late for delivery.
      await createOrder({ status: "ORDER_SCHEDULED", placed: "-2d 07:00", appointment: "+2d 07:00", alias: "order-12-scheduled" });
      // Collected at 08:00 and still not at the lab by 11:00: late.
      const collected = await createOrder({ status: "ORDER_SCHEDULED", placed: "-2d 07:00", appointment: "07:30", alias: "order-12-collected" });
      await updateOrder(collected, "08:00", { status: "SAMPLE_COLLECTED" });
      await run("10:00", "13:30", 5);
    },
    expect: [
      "11:00 Sample delivered to lab overdue · order-12-collected",
      "12:00 Sample delivered to lab overdue · order-12-collected",
      "13:00 Sample delivered to lab overdue · order-12-collected",
    ],
  },
];

// ── Runner ───────────────────────────────────────────────────────────────
async function main() {
  const filter = (process.argv[2] ?? "").toLowerCase();
  await prepareLabStack();
  let failed = 0;
  for (const scenario of scenarios.filter((s) => s.name.toLowerCase().includes(filter))) {
    await prepareLabStack();
    await resetOpsFlow(!scenario.upgrade);
    transcript = [];
    seen.clear();
    for (const row of await prisma.waOutbound.findMany({ select: { id: true } })) seen.add(row.id);
    await scenario.run();
    // Same-minute messages may go in any order, so compare sorted (lines start with the time).
    const got = transcript.map((line) => line.short).sort();
    const ok = JSON.stringify(got) === JSON.stringify([...scenario.expect].sort());
    if (!ok) failed += 1;
    console.log(`\n${ok ? "PASS" : "FAIL"}  ${scenario.name}`);
    for (const line of transcript) console.log(`      ${line.text}`);
    if (transcript.length === 0) console.log("      (no messages)");
    if (!ok) console.log(`      expected: ${scenario.expect.join(" | ")}\n      got:      ${got.join(" | ")}`);
  }
  console.log(`\n${failed === 0 ? "All scenarios passed." : `${failed} scenario(s) failed.`}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); await labstack.$disconnect?.(); });
