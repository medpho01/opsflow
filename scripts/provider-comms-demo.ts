/**
 * Provider communication demo — a day and a half of three dummy labs, with
 * every message the rules send shown in full.
 *
 *   npm run demo:comms
 *
 * The labs, patients and addresses are made up (LabStack ids 990001+), so the
 * full text is safe to print. Orders are created in a throwaway LabStack copy
 * and the real minute tick runs every 5 simulated minutes from Tuesday 17:00 to
 * Wednesday 19:30. The labs act along the way — confirm, reply, tap polls — and
 * each action is shown where it happens. Nothing is sent.
 *
 * Output: the story in the terminal, and .sim/provider-comms-demo.html (a chat
 * view per lab). At the end every rule is listed with how often it fired.
 *
 * Needs the same throwaway databases as the scenarios (scripts/provider-comms-sim.sh).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import prisma from "@/lib/db/client";
import { labstack } from "@/lib/db/labstack";
import { runNonApiLabTick } from "@/lib/non-api-labs/runner";

const dbName = (url: string | undefined) => (url ?? "").split("/").pop()?.split("?")[0] ?? "";
if (!dbName(process.env.SOURCE_DATABASE_URL).endsWith("_sim")) throw new Error("Refusing: SOURCE_DATABASE_URL must be a *_sim LabStack copy");
if (!/scratch/.test(dbName(process.env.DATABASE_URL))) throw new Error("Refusing: DATABASE_URL must be a scratch OpsFlow DB");
process.env.PROVIDER_REPLY_EXTRACTOR = "stub";

// ── Clock: "09:30" is Wednesday 7 Oct IST, "-1d 17:30" is Tuesday ──────────
const DAY = "2026-10-07";
function at(time: string): Date {
  const [dayPart, clock] = time.includes(" ") ? time.split(" ") : ["", time];
  const days = dayPart ? Number(dayPart.replace("d", "")) : 0;
  return new Date(new Date(`${DAY}T${clock}:00+05:30`).getTime() + days * 86_400_000);
}
const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "Asia/Kolkata" }).format(d).replace(",", "");
const clock = (d: Date) => fmt(d, { hour: "2-digit", minute: "2-digit", hour12: false });
const dayName = (d: Date) => fmt(d, { weekday: "long", day: "numeric", month: "short" });
const naive = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "");

// ── Dummy labs and patients ────────────────────────────────────────────────
type LabKey = "A" | "B" | "C";
const LABS: Record<LabKey, { labId: number; name: string; city: string; jid: string; manager: string; theme: string; pings?: boolean }> = {
  A: { labId: 990001, name: "Demo Diagnostics Andheri", city: "Mumbai", jid: "120363000000000201@g.us", manager: "919000000201", theme: "New orders: confirmed, confirmed late, never confirmed" },
  B: { labId: 990002, name: "Demo Pathlabs Pune", city: "Pune", jid: "120363000000000202@g.us", manager: "919000000202", theme: "Appointment day: phlebo, ETA, appointment pings, status check", pings: true },
  C: { labId: 990003, name: "Demo Health Labs Delhi", city: "New Delhi", jid: "120363000000000203@g.us", manager: "919000000203", theme: "After collection: report chase, pending reports, status check" },
};
const PATIENTS = [
  { name: "Asha Demo", address: "Flat 12, Sample Residency, Link Road", locality: "Andheri West", city: "Mumbai", pincode: "400053", lat: 19.1364, lng: 72.8296 },
  { name: "Rohan Testwala", address: "B-4, Example Heights, SV Road", locality: "Goregaon", city: "Mumbai", pincode: "400062", lat: 19.1663, lng: 72.8526 },
  { name: "Meera Placeholder", address: "22, Demo Lane", locality: "Juhu", city: "Mumbai", pincode: "400049", lat: 19.1075, lng: 72.8263 },
  { name: "Vikram Fictional", address: "House 7, Sandbox Society, FC Road", locality: "Shivajinagar", city: "Pune", pincode: "411005", lat: 18.5308, lng: 73.8475 },
  { name: "Neha Sample", address: "Flat 301, Mock Towers, Baner Road", locality: "Baner", city: "Pune", pincode: "411045", lat: 18.559, lng: 73.7868 },
  { name: "Arjun Dummy", address: "12, Trial Gardens", locality: "Kothrud", city: "Pune", pincode: "411038", lat: 18.5074, lng: 73.8077 },
  { name: "Kavita Example", address: "C-18, Test Enclave", locality: "Saket", city: "New Delhi", pincode: "110017", lat: 28.5245, lng: 77.2066 },
  { name: "Sanjay Notreal", address: "45, Pretend Marg", locality: "Lajpat Nagar", city: "New Delhi", pincode: "110024", lat: 28.5677, lng: 77.2433 },
  { name: "Priya Madeup", address: "Flat 9, Imaginary Apartments", locality: "Dwarka", city: "New Delhi", pincode: "110075", lat: 28.5921, lng: 77.046 },
];
const FIRST_USER_ID = 990000001;
let templateOrderId = 0;
let nextOrderId = 0;
const orderIds = new Map<string, number>(); // "A1" → LabStack order id
const aliasOf = (id: number | null) => [...orderIds.entries()].find(([, v]) => v === id)?.[0] ?? (id ? `#${id}` : "");

async function prepareLabStack() {
  const [lab] = await labstack.$queryRawUnsafe<Array<{ centerType: string }>>(`SELECT "centerType"::text AS "centerType" FROM public."Lab" LIMIT 1`);
  for (const l of Object.values(LABS)) {
    await labstack.$executeRawUnsafe(
      `INSERT INTO public."Lab" (id, "labName", "centerType", city, active, "homeCollection", "createdAt", "updatedAt")
       VALUES ($1, $2, $3::text::"CenterType", $4, true, true, now(), now())
       ON CONFLICT (id) DO UPDATE SET "labName" = EXCLUDED."labName"`, l.labId, l.name, lab.centerType, l.city);
  }
  await labstack.$executeRawUnsafe(`DELETE FROM public."Profile" WHERE "profileUserId" BETWEEN $1 AND $2`, FIRST_USER_ID, FIRST_USER_ID + 999);
  for (const [i, p] of PATIENTS.entries()) {
    const id = FIRST_USER_ID + i;
    await labstack.$executeRawUnsafe(
      `INSERT INTO public."User" (id, name, mobile, role, "createdAt", "updatedAt") VALUES ($1, $2, $3, 'USER', now(), now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, mobile = EXCLUDED.mobile`, id, p.name, `90000000${String(i).padStart(2, "0")}`);
    await labstack.$executeRawUnsafe(
      `INSERT INTO public."Profile" ("profileUserId", address, locality, city, state, pincode, latitude, longitude, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, now(), now())`, id, p.address, p.locality, p.city, p.pincode, p.lat, p.lng);
  }
  // Earlier demo/scenario orders are closed so only this story's orders are open.
  await labstack.$executeRawUnsafe(`UPDATE public."Order" SET "orderStatus" = 'CANCELED' WHERE id >= 999100000`);
  // Packages and individual tests are copied from a real order (catalogue data, no patient data).
  const [template] = await labstack.$queryRawUnsafe<Array<{ id: number }>>(
    `SELECT o.id FROM public."Order" o
      WHERE o."orderType" = 'HOME_SAMPLE'
        AND EXISTS (SELECT 1 FROM public."_OrderToPackage" p WHERE p."A" = o.id)
        AND EXISTS (SELECT 1 FROM public."_MasterToOrder" m WHERE m."B" = o.id)
      ORDER BY o.id DESC LIMIT 1`);
  templateOrderId = template.id;
  const [{ max }] = await labstack.$queryRawUnsafe<Array<{ max: number }>>(`SELECT GREATEST(max(id), 999100000) AS max FROM public."Order"`);
  nextOrderId = Number(max) + 1;
}

async function resetOpsFlow() {
  await prisma.$executeRawUnsafe(`TRUNCATE taskos.provider_message_ledger, taskos.provider_message_rules, taskos.provider_order_facts,
    taskos.wa_polls, taskos.wa_messages, taskos.wa_outbound, taskos.lab_communications, taskos.lab_communication_workflows,
    taskos.non_api_lab_configs, taskos.wa_groups, taskos.provider_comms_settings, taskos.lab_communication_templates CASCADE`);
  for (const lab of Object.values(LABS)) {
    await prisma.waGroup.create({ data: { jid: lab.jid, subject: `LS<>${lab.name}`, active: true, sendEnabled: true, isMember: true } });
    await prisma.nonApiLabConfig.create({ data: {
      labId: lab.labId, labName: lab.name, waGroupJid: lab.jid, quietWindowMinutes: 10,
      managerName: `${lab.city} Manager`, managerWhatsapp: lab.manager,
      dailyDigestEnabled: true, appointmentRemindersEnabled: !!lab.pings, postAppointmentCheckEnabled: true,
      createdAt: at("-1d 12:00"),
    } });
  }
}

// ── What happens in the story ──────────────────────────────────────────────
type OrderSpec = { lab: LabKey; patient: number; status?: string; appointment: string };
type Action =
  | { kind: "place"; alias: string; order: OrderSpec }
  | { kind: "status"; alias: string; status: string; phlebo?: [string, string]; why: string }
  | { kind: "reply"; lab: LabKey; text: string; quoting?: string }
  | { kind: "tap"; alias: string; label: string };
type Step = { time: string; action: Action };

async function place(alias: string, spec: OrderSpec, when: Date) {
  const id = nextOrderId++;
  const patch = {
    id, labId: LABS[spec.lab].labId, userId: FIRST_USER_ID + spec.patient, orderStatus: spec.status ?? "CREATED", orderType: "HOME_SAMPLE",
    createdAt: naive(when), updatedAt: naive(when), statusUpdatedAt: naive(when), appointmentTime: naive(at(spec.appointment)),
    phleboName: null, phleboNumber: null, labOrderId: null, storeId: null, campId: null, requestId: null, entityId: null,
    notes: null, internalNotes: null, rawValues: null, standardizedValues: null, llmExtractionLog: null, referenceId: null, labOrderReference: null,
  };
  await labstack.$executeRawUnsafe(
    `INSERT INTO public."Order" SELECT (jsonb_populate_record(NULL::public."Order", to_jsonb(o) || $2::jsonb)).* FROM public."Order" o WHERE o.id = $1`,
    templateOrderId, JSON.stringify(patch));
  await labstack.$executeRawUnsafe(`INSERT INTO public."_OrderToPackage" ("A", "B") SELECT $1, "B" FROM public."_OrderToPackage" WHERE "A" = $2`, id, templateOrderId);
  await labstack.$executeRawUnsafe(`INSERT INTO public."_MasterToOrder" ("A", "B") SELECT "A", $1 FROM public."_MasterToOrder" WHERE "B" = $2`, id, templateOrderId);
  orderIds.set(alias, id);
}

async function perform(action: Action, when: Date): Promise<Entry> {
  const base = { at: when, kind: "lab" as const };
  switch (action.kind) {
    case "place": {
      await place(action.alias, action.order, when);
      const lab = LABS[action.order.lab];
      return { ...base, lab: action.order.lab, title: `Order ${action.alias} placed (#${orderIds.get(action.alias)})`,
        text: `${PATIENTS[action.order.patient].name} · appointment ${dayName(at(action.order.appointment))} ${clock(at(action.order.appointment))} · ${action.order.status ?? "CREATED"} · ${lab.name}` };
    }
    case "status": {
      const id = orderIds.get(action.alias)!;
      const t = naive(when);
      await labstack.$executeRawUnsafe(`UPDATE public."Order" SET "orderStatus" = $2::text::"OrderStatus", "statusUpdatedAt" = $3::timestamp, "updatedAt" = $3::timestamp WHERE id = $1`, id, action.status, t);
      if (action.phlebo) await labstack.$executeRawUnsafe(`UPDATE public."Order" SET "phleboName" = $2, "phleboNumber" = $3 WHERE id = $1`, id, action.phlebo[0], action.phlebo[1]);
      const lab = (Object.keys(LABS) as LabKey[]).find((k) => action.alias.startsWith(k))!;
      return { ...base, lab, title: `LabStack: ${action.alias} → ${action.status}`, text: action.why };
    }
    case "reply": {
      const group = await prisma.waGroup.findUniqueOrThrow({ where: { jid: LABS[action.lab].jid } });
      let replyToWaId: string | null = null;
      if (action.quoting) {
        const ours = await prisma.labCommunication.findFirst({ where: { orderId: orderIds.get(action.quoting) }, orderBy: { createdAt: "desc" } });
        if (ours?.waOutboundId) {
          replyToWaId = `sim-out-${ours.waOutboundId}`;
          await prisma.waOutbound.update({ where: { id: ours.waOutboundId }, data: { sentWaMsgId: replyToWaId, status: "SENT", sentAt: when } });
        }
      }
      await prisma.waMessage.create({ data: {
        waMsgId: `sim-in-${Date.now()}-${Math.random()}`, groupId: group.id, direction: "IN", fromMe: false,
        sender: `${LABS[action.lab].name} desk`, text: action.text, ts: when, replyToWaId, createdAt: when,
      } });
      return { ...base, lab: action.lab, title: `Lab replies in the group${action.quoting ? ` (quoting our message about ${action.quoting})` : ""}`, text: action.text };
    }
    case "tap": {
      const id = orderIds.get(action.alias)!;
      const ours = await prisma.labCommunication.findFirst({ where: { orderId: id }, orderBy: { createdAt: "desc" } });
      const outbound = ours?.waOutboundId ? await prisma.waOutbound.findUnique({ where: { id: ours.waOutboundId } }) : null;
      if (!outbound?.pollName) throw new Error(`No poll was sent about ${action.alias}`);
      await prisma.waPoll.create({ data: {
        waMsgId: `sim-poll-${outbound.id}`, outboundId: outbound.id, workflowId: ours!.workflowId, options: outbound.pollOptions ?? [],
        messageJson: {}, status: "VOTED", votedLabel: action.label, voterJid: "sim-lab-user", votedAt: when,
      } });
      const lab = (Object.keys(LABS) as LabKey[]).find((k) => action.alias.startsWith(k))!;
      return { ...base, lab, title: `Lab taps the poll about ${action.alias}`, text: action.label };
    }
  }
}

// Order names: A1 = first order of lab A. Patients by index into PATIENTS.
const STORY: Step[] = [
  // ── Tuesday evening ──
  { time: "-1d 17:30", action: { kind: "place", alias: "B1", order: { lab: "B", patient: 3, appointment: "11:00" } } },
  { time: "-1d 17:50", action: { kind: "status", alias: "B1", status: "ORDER_SCHEDULED", why: "Lab confirms with the link" } },
  { time: "-1d 18:00", action: { kind: "place", alias: "C3", order: { lab: "C", patient: 8, appointment: "15:00" } } },
  { time: "-1d 18:20", action: { kind: "status", alias: "C3", status: "ORDER_SCHEDULED", why: "Lab confirms with the link" } },
  // ── Wednesday ──
  { time: "07:00", action: { kind: "place", alias: "B2", order: { lab: "B", patient: 4, appointment: "13:00" } } },
  { time: "07:30", action: { kind: "place", alias: "B3", order: { lab: "B", patient: 5, appointment: "+1d 08:00" } } },
  { time: "09:00", action: { kind: "place", alias: "A1", order: { lab: "A", patient: 0, appointment: "+1d 08:00" } } },
  { time: "09:15", action: { kind: "place", alias: "A2", order: { lab: "A", patient: 1, appointment: "+1d 09:00" } } },
  { time: "09:40", action: { kind: "status", alias: "A1", status: "ORDER_SCHEDULED", why: "Lab confirms within the hour, so A1 gets no reminders" } },
  { time: "09:45", action: { kind: "reply", lab: "B", quoting: "B1", text: "Phlebo Suresh Patil 9812345678 will go" } },
  { time: "09:50", action: { kind: "status", alias: "B1", status: "PHLEBO_ASSIGNED", phlebo: ["Suresh Patil", "9812345678"], why: "Lab assigns the phlebo in LabStack" } },
  { time: "10:25", action: { kind: "reply", lab: "B", quoting: "B1", text: "Suresh reaching by 10:55 am" } },
  { time: "11:00", action: { kind: "place", alias: "A3", order: { lab: "A", patient: 2, appointment: "+1d 10:30" } } },
  { time: "11:10", action: { kind: "status", alias: "B1", status: "SAMPLE_COLLECTED", why: "Sample collected, so B1 gets no status check" } },
  { time: "11:30", action: { kind: "reply", lab: "C", quoting: "C1", text: "Report shared on email" } },
  { time: "12:20", action: { kind: "status", alias: "A3", status: "ORDER_SCHEDULED", why: "Lab confirms after the 1-hour reminder" } },
  { time: "13:00", action: { kind: "status", alias: "B3", status: "ORDER_SCHEDULED", why: "Lab finally confirms B3" } },
  { time: "13:40", action: { kind: "tap", alias: "B2", label: "🙅 Patient not available" } },
  { time: "15:45", action: { kind: "tap", alias: "C3", label: "✅ Sample collected" } },
  { time: "15:50", action: { kind: "status", alias: "C3", status: "SAMPLE_COLLECTED", why: "LabStack catches up" } },
];
// Already in LabStack before the story starts (collected earlier, reports pending).
const BEFORE: Array<{ alias: string; placed: string; order: OrderSpec }> = [
  { alias: "C1", placed: "-2d 09:00", order: { lab: "C", patient: 6, status: "SAMPLE_COLLECTED", appointment: "-1d 20:00" } },
  { alias: "C2", placed: "-3d 09:00", order: { lab: "C", patient: 7, status: "SAMPLE_PROCESSED", appointment: "-2d 09:00" } },
];

// ── Transcript ─────────────────────────────────────────────────────────────
type Entry = { at: Date; kind: "lab" | "message"; lab: LabKey; title: string; text: string; to?: string; poll?: string[]; rule?: string };
const entries: Entry[] = [];
const seen = new Set<string>();
const fired = new Map<string, number>();

async function collect() {
  const rows = await prisma.waOutbound.findMany({ where: { id: { notIn: [...seen] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  for (const row of rows) {
    seen.add(row.id);
    const communication = await prisma.labCommunication.findUnique({ where: { waOutboundId: row.id } });
    const groupLab = (Object.keys(LABS) as LabKey[]).find((k) => LABS[k].jid === row.targetJid);
    const managerLab = (Object.keys(LABS) as LabKey[]).find((k) => row.targetJid.startsWith(LABS[k].manager));
    const lab = groupLab ?? managerLab!;
    const rule = communication?.ruleId ? await prisma.providerMessageRule.findUnique({ where: { id: communication.ruleId } }) : null;
    if (rule) fired.set(rule.id, (fired.get(rule.id) ?? 0) + 1);
    const about = communication?.orderId ? ` · ${aliasOf(communication.orderId)}` : "";
    const options = Array.isArray(row.pollOptions) ? (row.pollOptions as Array<string | { label?: string }>).map((o) => (typeof o === "string" ? o : o.label ?? "")) : undefined;
    entries.push({
      at: row.createdAt, kind: "message", lab, rule: rule?.name,
      to: groupLab ? `${LABS[lab].name} group` : `${LABS[lab].name} manager (personal)`,
      title: communication ? `${rule?.name ?? communication.templateKey}${about}` : "Acknowledgement of the poll answer",
      text: row.text, poll: row.pollName ? options : undefined,
    });
  }
}

const indent = (text: string) => text.split("\n").map((l) => `        │ ${l}`).join("\n");
function printEntry(e: Entry, n: number) {
  if (e.kind === "lab") {
    console.log(`  ${clock(e.at)}  ↩ ${LABS[e.lab].name}: ${e.title}\n        ${e.text}`);
  } else {
    console.log(`\n  ${clock(e.at)}  ✉ Message ${n} → ${e.to}\n        ${e.title}`);
    console.log(indent(e.text));
    if (e.poll) console.log(indent(`📊 Poll: ${e.poll.join("  |  ")}`));
  }
}

// ── HTML view ──────────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const wa = (s: string) => esc(s)
  .replace(/\*([^*\n]+)\*/g, "<b>$1</b>").replace(/(^|\s)_([^_\n]+)_/g, "$1<i>$2</i>")
  .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

function html(rules: Array<{ name: string; count: number; kind: string }>) {
  let day = "";
  let n = 0;
  const items = entries.map((e) => {
    const d = dayName(e.at);
    const header = d !== day ? `<div class="day">${(day = d)}</div>` : "";
    if (e.kind === "lab") {
      return `${header}<div class="row in" data-lab="${e.lab}"><div class="bubble lab"><div class="meta">${clock(e.at)} · ${esc(LABS[e.lab].name)}</div><div class="what">${esc(e.title)}</div><div>${wa(e.text)}</div></div></div>`;
    }
    n += 1;
    const poll = e.poll ? `<div class="poll">${e.poll.map((o) => `<div>○ ${esc(o)}</div>`).join("")}</div>` : "";
    return `${header}<div class="row out" data-lab="${e.lab}"><div class="bubble"><div class="meta">${clock(e.at)} · Message ${n} → ${esc(e.to!)}</div><div class="what">${esc(e.title)}</div><div class="text">${wa(e.text)}</div>${poll}</div></div>`;
  }).join("\n");
  const chips = (Object.keys(LABS) as LabKey[]).map((k) => `<button data-lab="${k}">${esc(LABS[k].name)}</button>`).join("");
  const themes = (Object.keys(LABS) as LabKey[]).map((k) => `<li><b>${esc(LABS[k].name)}</b> — ${esc(LABS[k].theme)}</li>`).join("");
  const table = rules.map((r) => `<tr class="${r.count ? "" : "zero"}"><td>${esc(r.name)}</td><td>${r.kind === "SUMMARY" ? "List" : "Order"}</td><td>${r.count}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lab Messages Demo</title><style>
:root{--bg:#efeae2;--panel:#fff;--out:#d9fdd3;--in:#fff;--lab:#fff7e0;--ink:#111b21;--muted:#667781;--line:#d1d7db;--accent:#008069}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0b141a;--panel:#111b21;--out:#005c4b;--in:#202c33;--lab:#3b3320;--ink:#e9edef;--muted:#8696a0;--line:#2a3942;--accent:#00a884}}
:root[data-theme="dark"]{--bg:#0b141a;--panel:#111b21;--out:#005c4b;--in:#202c33;--lab:#3b3320;--ink:#e9edef;--muted:#8696a0;--line:#2a3942;--accent:#00a884}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{background:var(--panel);border-bottom:1px solid var(--line);padding:16px;position:sticky;top:0;z-index:1}
h1{font-size:18px;margin:0 0 4px}header p{margin:0 0 10px;color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chips button{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:16px;padding:4px 12px;cursor:pointer;font:inherit}
.chips button.on{background:var(--accent);color:#fff;border-color:var(--accent)}
main{max-width:860px;margin:0 auto;padding:16px}.day{text-align:center;margin:18px 0 8px}.day:before{content:attr(data-x)}
.day{color:var(--muted);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.row{display:flex;margin:6px 0}.row.out{justify-content:flex-end}.bubble{max-width:min(620px,92%);background:var(--out);border-radius:8px;padding:8px 10px;box-shadow:0 1px .5px rgba(0,0,0,.13);overflow-wrap:anywhere}
.bubble.lab{background:var(--lab)}.meta{font-size:11px;color:var(--muted)}.what{font-weight:600;margin:2px 0 4px}.text{white-space:pre-wrap}
.poll{margin-top:8px;border-top:1px solid var(--line);padding-top:6px}.poll div{padding:2px 0}
a{color:var(--accent)}section{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin-bottom:16px}
section h2{font-size:15px;margin:0 0 8px}ul{margin:0;padding-left:18px}table{border-collapse:collapse;width:100%}td{padding:4px 6px;border-top:1px solid var(--line)}td:last-child{text-align:right}
tr.zero td{color:#c0392b}
</style></head><body><header><h1>Lab messages — demo day</h1><p>Dummy labs and patients · ${n} messages · Tue 17:00 → Wed 19:30 IST · nothing was sent</p><div class="chips"><button data-lab="" class="on">All labs</button>${chips}</div></header>
<main><section><h2>The three labs</h2><ul>${themes}</ul></section>
<section><h2>Rules and how often they fired</h2><table>${table}</table></section>
${items}</main>
<script>
document.querySelectorAll(".chips button").forEach(function(b){b.addEventListener("click",function(){
document.querySelectorAll(".chips button").forEach(function(x){x.classList.toggle("on",x===b)});
var lab=b.dataset.lab;document.querySelectorAll(".row").forEach(function(r){r.style.display=!lab||r.dataset.lab===lab?"":"none"});});});
</script></body></html>`;
}

// ── Run ────────────────────────────────────────────────────────────────────
async function main() {
  await prepareLabStack();
  await resetOpsFlow();
  for (const b of BEFORE) await place(b.alias, b.order, at(b.placed));

  // The first tick seeds the rules; then the communications that start paused are switched on.
  await runNonApiLabTick(at("-1d 16:55"));
  for (const key of ["ASSIGN_PHLEBO", "PHLEBO_ETA", "REPORT_CHASE", "SUMMARY_PENDING_REPORTS"]) {
    await prisma.providerMessageRule.update({ where: { builtInKey: key }, data: { isActive: true, version: { increment: 1 } } });
  }

  console.log("\nDemo labs:");
  for (const lab of Object.values(LABS)) console.log(`  • ${lab.name} — ${lab.theme}`);
  console.log("  C1, C2 were collected earlier and are waiting for reports.");

  const steps = [...STORY].sort((a, b) => at(a.time).getTime() - at(b.time).getTime());
  let printed = 0;
  let messages = 0;
  let day = "";
  for (let t = at("-1d 17:00").getTime(); t <= at("19:30").getTime(); t += 5 * 60_000) {
    const now = new Date(t);
    while (steps.length && at(steps[0].time).getTime() <= t) {
      const step = steps.shift()!;
      entries.push(await perform(step.action, at(step.time)));
    }
    await runNonApiLabTick(now);
    await collect();
    entries.sort((a, b) => a.at.getTime() - b.at.getTime() || (a.kind === "lab" ? -1 : 1));
    for (; printed < entries.length; printed += 1) {
      const e = entries[printed];
      if (dayName(e.at) !== day) console.log(`\n━━━━━━━━ ${(day = dayName(e.at))} ━━━━━━━━`);
      if (e.kind === "message") messages += 1;
      printEntry(e, messages);
    }
  }

  const rules = await prisma.providerMessageRule.findMany({ orderBy: [{ kind: "asc" }, { priority: "asc" }] });
  const counts = rules.map((r) => ({ name: r.name, kind: r.kind, count: fired.get(r.id) ?? 0, active: r.isActive }));
  console.log("\n━━━━━━━━ Rules and how often they fired ━━━━━━━━");
  for (const r of counts) console.log(`  ${r.count ? "✓" : "✗"} ${String(r.count).padStart(2)}  ${r.name}${r.active ? "" : " (paused)"}`);
  const silent = counts.filter((r) => r.count === 0);
  console.log(silent.length ? `\n${silent.length} rule(s) never fired.` : `\nAll ${counts.length} rules fired · ${messages} messages.`);

  mkdirSync(".sim", { recursive: true });
  writeFileSync(".sim/provider-comms-demo.html", html(counts));
  console.log("Chat view: .sim/provider-comms-demo.html");
  process.exitCode = silent.length ? 1 : 0;
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); await labstack.$disconnect?.(); });
