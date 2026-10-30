/**
 * Replays the last days' re-collection chats through today's code and says where each would stall
 * (30 Oct 2026). For every order with a sample left behind: the store's and the lab's real messages
 * in time order, what the agent would send now in answer to each, and a ⚠ wherever a message that
 * needs an answer would get none. Sends nothing, writes nothing; images are read again (without
 * saving) when their stored reading has no times.
 *
 *   docker compose -f docker-compose.yml -f docker-compose.wa.yml exec -T app npx tsx scripts/recollect-replay.ts [days=3] [orderId …]
 *
 * With -e NO_CONTEXT=1 (after `exec`) messages are read alone, as before the context packet: run both
 * and compare the stall counts.
 */
import prisma from "@/lib/db/client";
import { step, type StepOutput, type JourneyEvent } from "@/lib/agents/journey/step";
import { fetchOrderSnapshot } from "@/lib/agents/journey/window";
import { loadLiveSops, paramsFor } from "@/lib/agents/sop/load";
import { loadDirectory, tierOf } from "@/lib/agents/directory";
import { loadGuardState } from "@/lib/agents/guard/guard";
import { labChaseable, labGroup } from "@/lib/agents/store/scope";
import { explicitOrderIds } from "@/lib/agents/store/reader";
import { readMessage } from "@/lib/agents/reader/read";
import { contextFor } from "@/lib/agents/reader/context";
import { openRecollectFor } from "@/lib/agents/journey/run";
import { labstackWorkerQuery } from "@/lib/db/labstack";
import type { OrderSnapshot } from "@/lib/agents/journey/policy";
import { interpretImage } from "@/lib/wa/vision";
import { loadTeam, makeTeamMatcher } from "@/lib/wa/team";

const TZ = process.env.TIMEZONE || "Asia/Kolkata";
const ctxFor: typeof contextFor = (...a) => (process.env.NO_CONTEXT === "1" ? Promise.resolve("") : contextFor(...a));
const MIN = 60_000;
const t = (d: Date) => d.toLocaleString("en-IN", { timeZone: TZ, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const short = (s: string | null | undefined, n = 110) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const SAMPLE_LEFT = /\b(urine|stool|sputum|swab)\b[^.\n]{0,40}\b(not|pending|missed|left|skipped)\b|\b(not|pending)\b[^.\n]{0,20}\b(urine|stool|sputum|swab)\b/i;
const TIME = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}[:.]\d{2}\b/i;
const LAB_SIGNAL = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(ok|okay|done|booked|confirmed|scheduled|not available|not possible|can'?t|cannot|unable|no slots?|slots?)\b/i;

type Msg = { id: string; waMsgId: string; groupId: string; ts: Date; sender: string; senderJid: string | null; fromMe: boolean; text: string; mediaType: string | null; ocrText: string | null; replyToWaId: string | null; orderIds: number[]; refIds: string[] };

async function cases(days: number, only: number[]): Promise<number[]> {
  if (only.length) return only;
  const since = new Date(Date.now() - days * 86_400_000);
  const asked = await prisma.agentAction.findMany({ where: { desk: "LAB", action: "ask", createdAt: { gte: since }, params: { path: ["intent"], equals: "RECOLLECT" } }, select: { orderId: true } });
  const stores = await prisma.waGroup.findMany({ where: { role: "SUPPORT", storeId: { not: null } }, select: { id: true } });
  const said = await prisma.waMessage.findMany({ where: { groupId: { in: stores.map((g) => g.id) }, ts: { gte: since }, fromMe: false }, select: { text: true } });
  const ids = new Set<number>(asked.map((a) => a.orderId!).filter(Boolean));
  for (const m of said) if (SAMPLE_LEFT.test(m.text ?? "")) for (const id of explicitOrderIds(m.text ?? "")) ids.add(id);
  return [...ids].sort();
}

async function replay(orderId: number, ctx: { team: ReturnType<typeof makeTeamMatcher>; sops: Awaited<ReturnType<typeof loadLiveSops>>; directory: Awaited<ReturnType<typeof loadDirectory>>; desks: Map<string, string> }) {
  const order = await fetchOrderSnapshot(orderId).catch(() => null);
  if (!order) { console.log(`\n#${orderId}: not in LabStack's replica`); return { stalls: 0 }; }
  const storeGroup = order.storeId != null ? await prisma.waGroup.findFirst({ where: { role: "SUPPORT", storeId: order.storeId, active: true }, select: { id: true, subject: true } }) : null;
  const labG = order.labId != null ? await labGroup(order.labId) : null;
  const ref = (order.labRef ?? "").toUpperCase();
  const realAsks = await prisma.agentAction.findMany({ where: { orderId, desk: "LAB", action: "ask", outcome: "EXECUTED", params: { path: ["intent"], equals: "RECOLLECT" } }, select: { createdAt: true, params: true }, orderBy: { createdAt: "asc" } });
  // Our messages about this order, so a reply quoting one is known to be about it.
  const ourIds = new Set((await prisma.$queryRawUnsafe<Array<{ sentWaMsgId: string }>>(
    `SELECT o."sentWaMsgId" FROM wa_outbound o WHERE o."sentWaMsgId" IS NOT NULL AND (o.id IN (SELECT "outboundId" FROM agent_outbox_items WHERE "orderId" = $1 AND "outboundId" IS NOT NULL) OR o.id IN (SELECT "outboundId" FROM provider_batches WHERE items @> $2::jsonb AND "outboundId" IS NOT NULL))`,
    orderId, JSON.stringify([{ orderId }])).catch(() => [])).map((r) => r.sentWaMsgId));
  const batchLine = new Map<string, string>();
  for (const b of await prisma.$queryRawUnsafe<Array<{ text: string; sentWaMsgId: string | null }>>(`SELECT b.text, o."sentWaMsgId" FROM provider_batches b JOIN wa_outbound o ON o.id = b."outboundId" WHERE b.items @> $1::jsonb`, JSON.stringify([{ orderId }])).catch(() => [])) {
    const line = b.text.split("\n").find((l) => l.includes(`#${orderId}`) || (ref && l.toUpperCase().includes(ref)));
    if (b.sentWaMsgId && line) batchLine.set(b.sentWaMsgId, line.trim());
  }

  // The window: from the first word of a sample left behind (or our first ask) to a day later.
  const groups = [storeGroup?.id, labG?.id].filter(Boolean) as string[];
  const all: Msg[] = groups.length ? await prisma.waMessage.findMany({ where: { groupId: { in: groups }, ts: { gte: new Date(Date.now() - 6 * 86_400_000) } }, orderBy: { ts: "asc" }, select: { id: true, waMsgId: true, groupId: true, ts: true, sender: true, senderJid: true, fromMe: true, text: true, mediaType: true, ocrText: true, replyToWaId: true, orderIds: true, refIds: true } }) : [];
  // What the message itself says — never the gateway's tag, which a reply chain can carry to the wrong order.
  const names = (m: Msg) => explicitOrderIds(m.text ?? "").includes(orderId) || (!!ref && ((m.text ?? "").toUpperCase().includes(ref) || (m.ocrText ?? "").toUpperCase().includes(ref)));
  const start = [all.find((m) => m.groupId === storeGroup?.id && names(m) && SAMPLE_LEFT.test(m.text ?? ""))?.ts, realAsks[0]?.createdAt].filter(Boolean).sort((a, b) => a!.getTime() - b!.getTime())[0];
  if (!start) { console.log(`\n#${orderId}: no sample-left message or re-collection ask found`); return { stalls: 0 }; }
  const end = new Date(Math.min(Date.now(), start.getTime() + 24 * 3_600_000));
  const byWa = new Map(all.map((m) => [m.waMsgId, m]));
  const about = new Set<string>();
  const inWin = all.filter((m) => m.ts >= new Date(start.getTime() - 5 * MIN) && m.ts <= end);
  for (const m of inWin) {
    const q = m.replyToWaId ? byWa.get(m.replyToWaId) : null;
    if (names(m) || (m.replyToWaId && (ourIds.has(m.replyToWaId) || batchLine.has(m.replyToWaId) || (q && about.has(q.id))))) about.add(m.id);
  }

  // LabStack as it was at each message, from its change log — not as it is now.
  const changes = await labstackWorkerQuery<{ at: Date; status: string | null; appt: string | null }>(
    `SELECT "changeDate" AS at, new->>'orderStatus' AS status, new->>'appointmentTime' AS appt FROM public."OrderChange" WHERE "orderId" = $1 ORDER BY "changeDate"`, [orderId]).catch(() => []);
  const firstAppt = await labstackWorkerQuery<{ appt: string | null }>(
    `SELECT previous->>'appointmentTime' AS appt FROM public."OrderChange" WHERE "orderId" = $1 AND new ? 'appointmentTime' ORDER BY "changeDate" LIMIT 1`, [orderId]).catch(() => []);
  const firstStatus = await labstackWorkerQuery<{ status: string | null }>(
    `SELECT previous->>'orderStatus' AS status FROM public."OrderChange" WHERE "orderId" = $1 AND new ? 'orderStatus' ORDER BY "changeDate" LIMIT 1`, [orderId]).catch(() => []);
  const asOf = (at: Date): OrderSnapshot => {
    let status = firstStatus[0]?.status ?? order.orderStatus; let updated: Date | null = null;
    let appt = firstAppt[0]?.appt ? new Date(firstAppt[0].appt) : order.appointmentTime;
    for (const c of changes) {
      const t = new Date(c.at);
      if (t > at) break;
      if (c.status) { status = c.status; updated = t; }
      if (c.appt) appt = new Date(c.appt);
    }
    return changes.length ? { ...order, orderStatus: status, statusUpdatedAt: updated ?? order.statusUpdatedAt, appointmentTime: appt } : order;
  };
  console.log(`\n━━ #${orderId} · ${order.labName ?? `lab ${order.labId}`} · ${storeGroup?.subject ?? "no store group"} · LabStack at the start ${asOf(start).orderStatus}, now ${order.orderStatus}${labG ? "" : " · ⚠ lab has no connected group"}`);
  const labSop = ctx.sops.get("LAB") ?? null;
  const labTier = tierOf(ctx.directory, order.labId);
  const sop = paramsFor(labSop, { labTier, labId: order.labId, storeId: order.storeId, orderType: order.orderType });
  const chaseable = await labChaseable(order.labId, ctx.desks).catch(() => false);
  let prev: StepOutput | null = null;
  let simAskAt: Date | null = null;
  let slotThreadAt: Date | null = null;
  let lastStoreNamedAt = new Map<string, Date>();
  let stalls = 0;
  const flag = (why: string) => { stalls += 1; console.log(`      ⚠ STALL — ${why}`); };
  const run = async (m: Msg, events: JourneyEvent[]) => {
    // As production decides it (an ask by the agent or by our team in the lab group), plus asks this replay made.
    const simOpen = !!simAskAt && simAskAt <= m.ts && m.ts.getTime() - simAskAt.getTime() <= 24 * 3_600_000;
    const sample = (await openRecollectFor(orderId, m.ts, order.labRef ?? null)) ?? (simOpen ? (/\b(urine|stool|sputum|swab)\b/i.exec(all.filter((x) => about.has(x.id)).map((x) => x.text).join(" "))?.[1]?.toLowerCase() ?? "sample") : null);
    const r = step({ now: new Date(m.ts.getTime() + MIN), order: asOf(m.ts), journey: prev?.journey ?? null, checkpoints: prev?.checkpoints ?? [], events, sop, labTier, timeZone: TZ, labChaseable: chaseable, openRecollect: sample });
    prev = r;
    for (const a of r.actions) {
      if (a.desk === "LAB" && a.action === "ask") { if (a.params.intent === "RECOLLECT") simAskAt = m.ts; console.log(`      → lab: ${(a.params.line as { note?: string })?.note ?? a.params.intent}`); }
      else if (a.action === "store_alert") console.log(`      → store: Lab says: ${a.params.detail}`);
      else if (a.action === "store_reply") console.log(`      → store: ${short(String(a.params.text ?? a.params.template), 140)}`);
      else if (a.action === "ack") console.log(`      → store: ${a.params.template} (${a.params.intent})`);
      else if (a.action === "store_handoff") console.log(`      → team (silent handoff): ${short(String(a.params.note ?? a.params.intent), 120)}`);
      else if (a.action === "create_task") console.log(`      → task: ${short(String(a.params.action), 120)}`);
    }
    return r;
  };

  for (const m of inWin) {
    const side = m.groupId === storeGroup?.id ? "STORE" : "LAB ";
    const team = !m.fromMe && ctx.team(m.sender, m.senderJid);
    const q = m.replyToWaId ? byWa.get(m.replyToWaId) : null;
    const quoteTag = !m.replyToWaId ? "" : ourIds.has(m.replyToWaId) || batchLine.has(m.replyToWaId) ? " ↩ours" : q && (q.fromMe || ctx.team(q.sender, q.senderJid)) ? " ↩team" : " ↩other";
    const rel = about.has(m.id);
    const text = (m.text ?? "").trim();
    if (m.fromMe || team) { if (rel) console.log(`  ${t(m.ts)} ${side} ${m.fromMe ? "[us]" : `[team ${m.sender}]`}${quoteTag} "${short(text)}"`); continue; }

    if (side === "STORE") {
      if (names(m)) lastStoreNamedAt.set(m.senderJid ?? m.sender, m.ts);
      const recent = lastStoreNamedAt.get(m.senderJid ?? m.sender);
      const bareTime = !rel && !explicitOrderIds(text).length && !m.replyToWaId && TIME.test(text) && (slotThreadAt || simAskAt);
      const sameSender = !rel && !explicitOrderIds(text).length && recent && m.ts.getTime() - recent.getTime() <= 10 * MIN;
      if (!rel && !bareTime && !sameSender) continue;
      console.log(`  ${t(m.ts)} STORE ${m.sender}${quoteTag}${rel ? "" : bareTime ? " (no id — linked to the open slot request)" : " (no id — same sender named it <10 min ago)"} "${short(text)}"`);
      // The reader's own gates: a reply to a person's message, or a person on our side engaged with the order.
      if (quoteTag === " ↩team") { console.log("      · reply to a team member's message — left to that person"); continue; }
      const engaged = inWin.find((x) => x.groupId === m.groupId && x.ts < m.ts && m.ts.getTime() - x.ts.getTime() <= 2 * 3_600_000 && !x.fromMe && ctx.team(x.sender, x.senderJid) && about.has(x.id));
      if (engaged) { console.log(`      · team member ${engaged.sender} wrote about it at ${t(engaged.ts)} — the desk stays out for 2 h`); continue; }
      const quoted = q?.text ?? null;
      const reading = await readMessage({ side: "store", text, quotedText: quoted, scope: { storeId: order.storeId, groupId: m.groupId }, context: await ctxFor([orderId], m.ts) });
      const intent = reading.ack || reading.request.kind === "none" ? "noise" : reading.request.kind === "details" ? "other" : reading.request.kind;
      if (intent === "noise") { console.log("      · read as noise (no request)"); if (TIME.test(text) || SAMPLE_LEFT.test(text)) flag("a time or a sample left, read as noise"); continue; }
      if (intent === "slot") slotThreadAt ??= m.ts;
      const thread = !rel && slotThreadAt ? { kind: "slot", waitingOn: "LAB", openedAt: slotThreadAt.toISOString() } : null;
      const r = await run(m, [{ kind: "store_message", at: m.ts, actor: "STORE", payload: { intent, text, messageId: m.id, waMsgId: m.waMsgId, samples: reading.samples, requestTime: reading.request.time ?? null, ...(thread ? { thread } : {}) } }]);
      const toLab = r.actions.some((a) => a.desk === "LAB" && a.action === "ask");
      if ((SAMPLE_LEFT.test(text) || (TIME.test(text) && (slotThreadAt || simAskAt || realAsks.length))) && !toLab && !r.actions.some((a) => a.action === "store_handoff")) flag(`store ${SAMPLE_LEFT.test(text) ? "reports a sample left" : "gives a time"} (read as ${intent}) and the lab is not told`);
      continue;
    }

    // The lab: tied by the order's id or reference, a quote of our message, or a quote of a message about it.
    const recentAsk = [...realAsks.map((a) => a.createdAt), ...(simAskAt ? [simAskAt] : [])].filter((at) => at <= m.ts).at(-1);
    const candidate = !rel && recentAsk && m.ts.getTime() - recentAsk.getTime() <= 3 * 3_600_000 && (LAB_SIGNAL.test(text) || m.mediaType === "image");
    if (!rel && !candidate) continue;
    let reading = m.ocrText ?? "";
    if (m.mediaType === "image" && !/\b(Slots|Booked): /.test(reading)) {
      const v = await interpretImage(m.waMsgId, { fresh: true, save: false }).catch(() => null);
      if (v?.ok) reading = v.ocrText;
    }
    const full = m.mediaType === "image" && reading ? (text ? `${text}\n[screenshot] ${reading}` : reading) : text;
    console.log(`  ${t(m.ts)} LAB  ${m.sender}${quoteTag}${m.mediaType ? ` [${m.mediaType}]` : ""} "${short(text || "(no caption)")}"${m.mediaType === "image" ? `\n      · image read as: "${short(reading, 160)}"` : ""}`);
    if (!rel) { console.log("      · names no order and quotes nothing about it — may be tied to another order, or to none"); }
    const context = m.replyToWaId ? batchLine.get(m.replyToWaId) ?? "" : "";
    // As replies.ts reads it: the reader, with the order's context; a missed sample is a fact too.
    const lr = await readMessage({ side: "lab", text: full, quotedText: context || null, scope: { labId: order.labId }, context: await ctxFor([orderId], m.ts, { groupId: m.groupId, senderJid: m.senderJid }) });
    const outstanding = Object.values(lr.samples).some((x) => x === "missed" || x === "pending");
    const read = [...lr.events.map((e) => ({ kind: e.kind, value: e.value, confidence: e.confidence ?? 0.8 })), ...Object.entries(lr.samples).filter(([, x]) => x === "missed").map(([k]) => ({ kind: "sample_missed" as const, value: k, confidence: 0.85 }))]
      .filter((f) => f.kind !== "confirmed").filter((f) => !(f.kind === "sample_collected" && outstanding));
    console.log(`      · read as ${read.map((f) => `${f.kind}="${short(f.value, 50)}"`).join(", ") || "nothing"} (${lr.via})`);
    const facts = read.length ? read : [{ kind: "note" as const, value: full.slice(0, 200), confidence: 0.5 }];
    const r = await run(m, facts.map((f, i) => ({ kind: "fact", at: m.ts, actor: "LAB", payload: { fullText: full.slice(0, 600), kind: f.kind, value: f.value, confidence: f.confidence, source: "lab_reply", attributedBy: m.replyToWaId && context ? "REPLY_TO" : "ORDER_ID", factId: `${m.id}:${i}`, context } })));
    if (LAB_SIGNAL.test(full) && !r.actions.some((a) => a.desk === "STORE")) flag("the lab answered with a time, an ok or a refusal, and the store hears nothing");
  }
  return { stalls };
}

async function main() {
  const args = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const days = args.length && args[0] < 30 ? args.shift()! : 3;
  const ids = await cases(days, args);
  console.log(`${ids.length} order(s) with a sample left behind in the last ${days} day(s)`);
  const [team, sops, directory, guard] = await Promise.all([loadTeam(), loadLiveSops(), loadDirectory(), loadGuardState()]);
  const ctx = { team: makeTeamMatcher(team), sops, directory, desks: guard.desks };
  let stalls = 0;
  for (const id of ids) stalls += (await replay(id, ctx).catch((e) => { console.log(`\n#${id}: replay failed — ${e instanceof Error ? e.message : e}`); return { stalls: 0 }; })).stalls;
  console.log(`\n${stalls} stall(s) across ${ids.length} order(s)`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
