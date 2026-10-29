/**
 * The outcome auditor (29 Oct 2026). The other Brain passes judge the agent by its own rules — did
 * the ladder climb, did the reply match the team's. This one reads the groups as a person would and
 * judges whether the jobs got done, whatever the system did or did not do:
 *
 *   1. every order with a visit is tracked; a missed milestone is checked with the lab before a
 *      person has to ask
 *   2. what the lab says reaches the store when the store needs it — failures it must act on at once,
 *      orders at risk in batches — and nothing else
 *   3. store questions that need the lab are relayed and answered; reschedules, cancellations and
 *      test changes are done by people and tracked to done
 *   4. no clutter: nothing duplicated, wrong, irrelevant, or addressed to the wrong people
 *
 * It names what was met and missed with the messages as evidence, what the bot sent that it should
 * not have, what people did by hand that the bot should have done, and proposals — a new playbook,
 * a change to one, one to retire, a lesson — each with a trigger, an action, a scope and how to tell
 * it worked. It never sends anything. Proposals feed the weekly review and the coaching chat.
 *
 * Runs hourly in the day on the last ~75 minutes, and once at night on the whole day, on the
 * strongest model (llm.ts purpose "auditor").
 */
import prisma from "@/lib/db/client";
import { askModel, estimateCostPaise } from "../llm";
import { isAutomated, loadTeam, makeTeamMatcher } from "@/lib/wa/team";
import { fetchOrderSnapshots } from "../journey/window";

const H = 3_600_000;
const TZ = () => process.env.TIMEZONE || "Asia/Kolkata";
const hhmm = (d: Date) => d.toLocaleTimeString("en-IN", { timeZone: TZ(), hour: "2-digit", minute: "2-digit", hour12: false });
const ORDER_ID = /(?<![\d@+])#?(\d{5,6})(?!\d)/g;

export type AuditProposal = { kind: "new_playbook" | "change_playbook" | "retire_playbook" | "lesson" | "wording"; title: string; why: string; trigger: string; action: string; scope: string; measure: string; confidence: number };
export type AuditFindings = {
  summary: string;
  outcomes: Array<{ id: string; status: "met" | "partly" | "missed"; evidence: Array<{ group: string; time: string; order: string | null; quote: string; note: string }> }>;
  humanDidAgentWork: Array<{ group: string; time: string; order: string | null; what: string }>;
  noise: Array<{ group: string; time: string; order: string | null; quote: string; why: string }>;
  proposals: AuditProposal[];
};

const SYSTEM = [
  "You audit an AI operations agent that works in WhatsApp groups for LabStack, a diagnostics marketplace. Pharmacy and insurance 'stores' (e.g. Plum) book home sample collections; partner 'labs' (Orange Health, Thyrocare, Redcliffe — API-integrated, their status reaches LabStack's console automatically; and manual labs like Advaith or Star — no API, status comes only from asking people) send phlebotomists. LabStack's ops team sits between them in a WhatsApp group per store and per lab. The agent writes as 'Labstack Operations'.",
  "",
  "What the agent is for, in the head of operations' words:",
  "1. Proactively keep track of all orders with appointment times, make sure the milestones are hit, and if not, check in the lab groups for the latest status. Manual labs need checking at every level; API labs only when the console goes quiet past a milestone.",
  "2. Relay updates from the labs to the store group when the store needs them; if a lab does not respond, proactively tell the store in batches which orders are at risk and ask for a reschedule. Failures the customer must act on (not reachable, sample owed, lab cannot do it) go at once.",
  "3. Be a service agent for the store: questions that need the lab are relayed to the lab group and answered back; reschedules, cancellations and test changes are done by people — the agent only tracks whether they got done, silently.",
  "4. Keep learning what to ask, how, and when, so it gets more proactive with labs and with at-risk updates — without creating clutter.",
  "",
  "Judge from what happened in the groups and from the orders' data, not from the agent's own rules: those rules are what is under audit, and a rule followed perfectly can still fail the job. Be concrete and quote messages. People on LabStack's team are marked TEAM; the agent's own messages are AGENT.",
  "A proposal is a change you would make: a new playbook (a trigger, what to send to whom, when, for which labs or stores), a change to how an existing behaviour works, retiring a behaviour that adds noise, a one-line lesson, or a wording change. Each must say how to tell, from the groups, that it worked. Propose at most 8, most valuable first; propose nothing you cannot tie to evidence in this window.",
  "",
  'Return ONLY JSON: {"summary": "3-5 sentences: what the agent got done, what it missed, and the single most valuable change", "outcomes": [{"id": "1"|"2"|"3"|"4", "status": "met"|"partly"|"missed", "evidence": [{"group": "", "time": "HH:MM", "order": "#id or null", "quote": "", "note": ""}]}], "humanDidAgentWork": [{"group": "", "time": "", "order": null, "what": ""}], "noise": [{"group": "", "time": "", "order": null, "quote": "", "why": ""}], "proposals": [{"kind": "new_playbook"|"change_playbook"|"retire_playbook"|"lesson"|"wording", "title": "", "why": "evidence in one or two sentences", "trigger": "", "action": "", "scope": "which labs / stores", "measure": "how to tell it worked", "confidence": 0.0}]}',
].join("\n");

/** Audit the last `hours` of every connected store and lab group. Records one brain run; sends nothing. */
export async function runOutcomeAudit(now = new Date(), opts: { hours?: number; kind?: string } = {}): Promise<Record<string, number>> {
  const hours = opts.hours ?? 1.25;
  const since = new Date(now.getTime() - hours * H);
  const groups = await prisma.waGroup.findMany({ where: { active: true, archivedAt: null, OR: [{ role: "SUPPORT", storeId: { not: null } }, { role: "PROVIDER", labId: { not: null } }] }, select: { id: true, subject: true, role: true } });
  if (!groups.length) return { groups: 0, messages: 0 };
  const isTeam = makeTeamMatcher(await loadTeam());
  const msgs = await prisma.waMessage.findMany({ where: { groupId: { in: groups.map((g) => g.id) }, ts: { gt: since, lte: now } }, orderBy: { ts: "asc" }, select: { groupId: true, ts: true, sender: true, senderJid: true, fromMe: true, text: true, intent: true, mediaType: true } });
  if (!msgs.length) return { groups: groups.length, messages: 0 };

  // The groups as they read, one block each.
  const ids = new Set<number>();
  const blocks: string[] = [];
  for (const g of groups) {
    const mine = msgs.filter((m) => m.groupId === g.id).slice(-220);
    if (!mine.length) continue;
    const side = g.role === "SUPPORT" ? "STORE" : "LAB";
    const lines = mine.map((m) => {
      const who = m.fromMe ? (isAutomated(m) ? "AGENT" : "TEAM") : isTeam(m.sender, m.senderJid) ? "TEAM" : side;
      const text = (m.text ?? "").replace(/_Sent by [^_]+_/g, "").replace(/\s+/g, " ").trim().slice(0, 320) || (m.mediaType ? `[${m.mediaType}]` : "");
      for (const x of text.matchAll(ORDER_ID)) ids.add(Number(x[1]));
      return `${hhmm(m.ts)} ${who} ${m.fromMe ? "" : (m.sender || "").slice(0, 18)}: ${text}`;
    });
    blocks.push(`### ${g.subject} (${side === "STORE" ? "store group" : "lab group"})\n${lines.join("\n")}`);
  }

  // The orders those messages name, and the late ones nobody named — what LabStack and the agent knew.
  const late = await prisma.agentJourney.findMany({ where: { closedAt: null, checkpoints: { some: { status: "BREACHED", dueAt: { gte: new Date(now.getTime() - 12 * H), lte: now } } } }, select: { orderId: true }, take: 80 });
  for (const j of late) ids.add(j.orderId);
  const idList = [...ids].slice(0, 160);
  const snaps = await fetchOrderSnapshots(idList).catch(() => new Map());
  const journeys = await prisma.agentJourney.findMany({ where: { orderId: { in: idList } }, select: { orderId: true, checkpoints: { where: { status: { in: ["BREACHED", "PENDING"] } }, orderBy: { dueAt: "asc" }, take: 1, select: { name: true, dueAt: true, status: true } } } });
  const actions = await prisma.agentAction.findMany({ where: { orderId: { in: idList }, createdAt: { gt: new Date(since.getTime() - H) }, desk: { in: ["LAB", "STORE"] }, action: { notIn: ["wait", "portal_read"] } }, orderBy: { createdAt: "asc" }, select: { orderId: true, createdAt: true, action: true, outcome: true, blockedBy: true, reason: true } });
  const orderLines: string[] = [];
  for (const id of idList) {
    const o = snaps.get(id);
    if (!o) continue;
    const j = journeys.find((x) => x.orderId === id);
    const cp = j?.checkpoints[0];
    const acts = actions.filter((a) => a.orderId === id).slice(-6).map((a) => `${hhmm(a.createdAt)} ${a.action}→${a.outcome}${a.blockedBy ? ` (${a.blockedBy.slice(0, 60)})` : ""}`).join("; ");
    orderLines.push(`#${id} · ${o.labName ?? "?"} · visit ${o.appointmentTime ? o.appointmentTime.toLocaleString("en-IN", { timeZone: TZ(), day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "?"} · console ${o.orderStatus}${o.statusUpdatedAt ? ` (${hhmm(o.statusUpdatedAt)})` : ""}${cp ? ` · next ${cp.name} ${cp.status === "BREACHED" ? "LATE since" : "due"} ${hhmm(cp.dueAt)}` : ""}${acts ? ` · agent: ${acts}` : " · agent: nothing"}`);
  }

  const user = [
    `Window: ${since.toLocaleString("en-IN", { timeZone: TZ() })} to ${now.toLocaleString("en-IN", { timeZone: TZ() })} (${hours} h).`,
    "", "## The groups", blocks.join("\n\n"),
    "", "## The orders named above, and orders late in LabStack in the last 12 h (console status, the next milestone, and what the agent did)", orderLines.join("\n") || "(none)",
  ].join("\n");

  const run = await prisma.agentBrainRun.create({ data: { kind: opts.kind ?? "outcomes", inputs: { hours, groups: blocks.length, messages: msgs.length, orders: orderLines.length } }, select: { id: true } });
  const r = await askModel({ purpose: "auditor", system: SYSTEM, user, maxTokens: 16000, effort: "high", timeoutMs: 600_000 });
  if (!r) {
    await prisma.agentBrainRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), error: "no model result (no key, declined, or failed)" } }).catch(() => undefined);
    return { groups: blocks.length, messages: msgs.length, audited: 0 };
  }
  let findings: AuditFindings | null = null;
  try { findings = JSON.parse(r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1)) as AuditFindings; } catch { findings = null; }
  await prisma.agentBrainRun.update({
    where: { id: run.id },
    data: { finishedAt: new Date(), findings: (findings ?? { raw: r.text.slice(0, 20000) }) as object, brief: findings?.summary ?? null, model: r.model, tokens: r.inputTokens + r.outputTokens, costPaise: estimateCostPaise(r.model, r.inputTokens, r.outputTokens), ...(findings ? {} : { error: "unparsable model output" }) },
  });
  return { groups: blocks.length, messages: msgs.length, audited: findings ? 1 : 0, proposals: findings?.proposals?.length ?? 0, noise: findings?.noise?.length ?? 0 };
}

/** The latest audit as a WhatsApp-sized text: what was missed, what was noise, the top proposals. */
export async function latestAuditText(): Promise<string> {
  const run = await prisma.agentBrainRun.findFirst({ where: { kind: { in: ["outcomes", "outcomes_day"] }, finishedAt: { not: null }, brief: { not: null } }, orderBy: { startedAt: "desc" }, select: { startedAt: true, kind: true, findings: true, brief: true } });
  if (!run) return "No outcome audit yet — the first runs at the next hour mark.";
  const f = run.findings as Partial<AuditFindings>;
  const at = run.startedAt.toLocaleString("en-IN", { timeZone: TZ(), day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const status = (f.outcomes ?? []).map((o) => `${o.id}: ${o.status}`).join(" · ");
  const props = (f.proposals ?? []).slice(0, 4).map((p, i) => `${i + 1}. *${p.title}* (${p.kind.replace("_", " ")}) — ${p.action}`);
  return [
    `*Outcome audit* · ${run.kind === "outcomes_day" ? "the whole day" : "last hour"} · ${at}`,
    run.brief ?? "",
    status ? `Jobs: ${status}` : "",
    (f.humanDidAgentWork ?? []).length ? `People did ${(f.humanDidAgentWork ?? []).length} thing(s) the agent should have.` : "",
    (f.noise ?? []).length ? `${(f.noise ?? []).length} agent message(s) were noise.` : "",
    props.length ? `\nProposals:\n${props.join("\n")}` : "",
  ].filter(Boolean).join("\n");
}
