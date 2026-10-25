/**
 * The reader: what a WhatsApp message from a store or a lab means, as a
 * filled-in form — which orders, what happened to each sample, what is being
 * asked, any time given, and whether it is only an acknowledgement.
 *
 * The model reads first (Haiku-class, every message), taught by anonymised
 * examples of how stores and labs write and by how our own team answered
 * similar messages recently. The pattern code is the fallback when there is
 * no key or the call fails, so nothing stops. The reader never decides what
 * to do: the step does, from the form (decision of 25 Oct 2026).
 */
import prisma from "@/lib/db/client";
import { askModel } from "../llm";
import { classifyStoreMessage, explicitOrderIds, type StoreIntent } from "../store/reader";
import { extractWithPatterns } from "@/lib/provider-rules/reply-extract";
import { labRefTokens } from "@/lib/provider-rules/replies";
import { FACT_KINDS, type FactKind } from "@/lib/provider-rules/types";
import { isAutomated, loadTeam, makeTeamMatcher } from "@/lib/wa/team";

export type Sample = "blood" | "urine" | "stool" | "swab" | "sputum";
export type SampleState = "collected" | "missed" | "pending";
export type RequestKind = StoreIntent | "details" | "none";
export type Reading = {
  side: "lab" | "store";
  orders: Array<{ orderId?: number; labRef?: string }>;
  samples: Partial<Record<Sample, SampleState>>;
  events: Array<{ kind: FactKind; value: string; confidence?: number }>;
  request: { kind: RequestKind; time?: string | null };
  ack: boolean;
  confidence: number;
  via: "model" | "patterns";
};

export type ReadInput = {
  side: "lab" | "store";
  text: string;
  /** The message this one replied to, when known (ours or a person's). */
  quotedText?: string | null;
  /** The store or lab, for "how our team answers here" examples. */
  scope?: { storeId?: number | null; labId?: number | null; groupId?: string | null };
  /** Our message asked the lab to confirm — a plain "ok" means confirmed. */
  confirmation?: boolean;
};

const SAMPLE_RE = /\b(blood|urine|stool|swab|sputum)\b/gi;
const MISSED_RE = /\b(not|pending|missed|left|skipped|didn'?t|did not|wasn'?t|was not)\b[^.\n]{0,25}\b(collect\w*|done|taken|pick\w*)|\bnot collected\b|\bcollection (is )?not done\b/i;
const COLLECTED_RE = /\b(is |has been |was |got )?(collected|done|taken|serviced)\b/i;

/** Sample words and whether each is said to be collected, missed or still to come. */
export function readSamples(text: string): Partial<Record<Sample, SampleState>> {
  const out: Partial<Record<Sample, SampleState>> = {};
  for (const clause of text.split(/[\n,;.]|\bbut\b|\band\b/i)) {
    const words = [...clause.matchAll(SAMPLE_RE)].map((m) => m[1].toLowerCase() as Sample);
    if (!words.length) continue;
    // "schedule urine collection at 10:45" — asking to collect it is saying it was missed.
    const state: SampleState | null = MISSED_RE.test(clause) ? "missed" : /\bwill be\b|\bby \d|\bpending\b|\bre-?collect/i.test(clause) ? "pending" : COLLECTED_RE.test(clause) ? "collected" : /\b(schedule|book|arrange|allot|slot)\w*\b/i.test(clause) ? "missed" : null;
    if (state) for (const w of words) out[w] = state;
  }
  // "samples are not collected" / "samples were collected", no sample named: the blood draw itself.
  if (!Object.keys(out).length && !/\b(blood|urine|stool|swab|sputum)\b/i.test(text)) {
    if (/\bsamples?\b[^.\n]{0,20}\bnot collected\b|\bnot collected\b/i.test(text)) out.blood = "missed";
    else if (/\bsamples?\b[^.\n]{0,15}\b(were|was|are|is|got|been)?\s*collected\b/i.test(text)) out.blood = "collected";
  }
  return out;
}

const TIME_RE = /\b(today|tomorrow|tmrw|tmr|day after)?\s*(?:at|by|for|@)?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}(?::\d{2})\s*(?:hrs|hours)?)\b/i;

/** The deterministic reading — what the patterns can see. Always available. */
export async function readWithPatterns(input: ReadInput): Promise<Reading> {
  const text = input.text.trim();
  const ids = explicitOrderIds(text);
  const refs = labRefTokens(text).map((t) => t.ref);
  const orders = [...ids.map((orderId) => ({ orderId })), ...refs.filter((r) => !/^\d{5,6}$/.test(r)).map((labRef) => ({ labRef }))];
  const samples = readSamples(text);
  const timeMatch = text.match(TIME_RE);
  const time = timeMatch ? timeMatch[0].trim() : null;
  if (input.side === "store") {
    const { intent } = classifyStoreMessage(text);
    const ack = intent === "noise";
    const request: Reading["request"] = { kind: ack ? "none" : intent, time };
    // A missed sample with a time or "slots" is a re-collection ask, whatever else it looks like.
    const missed = Object.values(samples).includes("missed");
    if (missed && request.kind !== "reschedule" && request.kind !== "cancel" && request.kind !== "complaint") request.kind = /\bslot|schedule|book|arrange/i.test(text) ? "slot" : "status";
    return { side: "store", orders, samples, events: [], request, ack, confidence: 0.6, via: "patterns" };
  }
  const facts = extractWithPatterns(text, { confirmation: input.confirmation === true });
  const details = /\b(share|send|give|provide|need)\b[^\n]{0,40}\b(details?|contact|number|mobile|phone|address|location)\b|\b(cx|customer|patient) (details?|contact|number)\b|\bregistered (contact|number|mobile)\b/i.test(text);
  return { side: "lab", orders, samples, events: facts.map((f) => ({ kind: f.kind, value: f.value, confidence: f.confidence })), request: { kind: details ? "details" : "none", time }, ack: /^\s*(ok|okay|noted|sure|checking|will check)[\s.!]*$/i.test(text), confidence: 0.6, via: "patterns" };
}

/** Recent pairs in this group: what someone wrote and what our team answered within 30 minutes. */
export async function teamExamples(groupId: string | null | undefined, limit = 6): Promise<Array<{ message: string; reply: string }>> {
  if (!groupId) return [];
  const since = new Date(Date.now() - 14 * 86_400_000);
  const rows = await prisma.waMessage.findMany({ where: { groupId, ts: { gte: since } }, orderBy: { ts: "asc" }, select: { sender: true, senderJid: true, text: true, ts: true, fromMe: true, intent: true, mediaType: true } }).catch(() => []);
  if (!rows.length) return [];
  const isTeam = makeTeamMatcher(await loadTeam());
  const out: Array<{ message: string; reply: string }> = [];
  for (let i = 0; i < rows.length && out.length < limit * 4; i += 1) {
    const m = rows[i];
    if (m.fromMe || isTeam(m.sender, m.senderJid) || isAutomated(m) || !m.text?.trim() || m.text.length < 12) continue;
    const reply = rows.slice(i + 1, i + 12).find((r) => (r.fromMe || isTeam(r.sender, r.senderJid)) && !isAutomated(r) && r.text?.trim() && r.ts.getTime() - m.ts.getTime() < 30 * 60_000);
    if (reply) out.push({ message: m.text.slice(0, 240), reply: reply.text.slice(0, 240) });
  }
  return out.slice(-limit);
}

const SCHEMA = `{"orders":[{"orderId":number|null,"labRef":string|null}],"samples":{"blood"?: "collected"|"missed"|"pending","urine"?: ...,"stool"?: ...,"swab"?: ...,"sputum"?: ...},"events":[{"kind":"${FACT_KINDS.join('"|"')}","value":string,"confidence":0..1}],"request":{"kind":"status"|"report"|"slot"|"reschedule"|"cancel"|"change_tests"|"new_booking"|"serviceability"|"complaint"|"details"|"other"|"none","time":string|null},"ack":boolean,"confidence":0..1}`;

/** Read with the model; the patterns when it is not available. */
export async function readMessage(input: ReadInput): Promise<Reading> {
  const patterns = await readWithPatterns(input);
  if (!process.env.ANTHROPIC_API_KEY || process.env.AGENT_LLM === "off" || process.env.PROVIDER_REPLY_EXTRACTOR === "stub") return patterns;
  const { EXAMPLES } = await import("./examples");
  const shots = EXAMPLES.filter((e) => e.side === input.side).slice(0, 14).map((e) => `Message: ${JSON.stringify(e.text)}${e.quoted ? `\nReplying to: ${JSON.stringify(e.quoted)}` : ""}\nReading: ${JSON.stringify(e.expect)}`).join("\n\n");
  const team = await teamExamples(input.scope?.groupId);
  const system = [
    input.side === "store"
      ? "You read one WhatsApp message from a client store (a company that books diagnostic tests for its users) to the diagnostics ops team, and fill in a form."
      : "You read one WhatsApp message from a diagnostic lab's coordinator to the ops team, usually answering an ask about home sample collection, and fill in a form.",
    "Messages mix English and Hindi/Hinglish and are terse. Order ids are 5–6 digit numbers; a lab's own reference looks like BLR6362207, VL336FC5 or an 8-digit booking id.",
    "Samples: a visit can collect blood and also urine/stool. 'urine not collected' with blood collected is a MISSED urine sample, never 'sample collected'.",
    "request.kind is what the writer wants from us now: status (any update, 'make sure it happens', 'check with the lab', or a question why something happened — 'why was it cancelled' is status, we answer with the fact), report, slot (asks for available slots), reschedule (gives or wants a new time), cancel, change_tests, new_booking, serviceability, complaint (only with anger, escalation or a demand for an RCA), details (ONLY a lab asking for the patient's phone/address; a store asking about tests or packages is 'other'), other, none.",
    "ack=true only for a bare acknowledgement ('ok', 'checking', 'will check', 'thanks') with no request in it.",
    input.confirmation ? "Our message asked the lab to confirm the order: a plain yes/ok/done/haan/👍 is event kind 'confirmed' with value 'yes'." : "Never return event kind 'confirmed' unless the message plainly confirms an order we asked about.",
    "Only what the message states. Return ONLY JSON matching: " + SCHEMA,
    "",
    "Examples:",
    shots,
    team.length ? "\nHow our team recently answered in this group (for what messages here usually mean):\n" + team.map((t) => `Message: ${JSON.stringify(t.message)}\nTeam replied: ${JSON.stringify(t.reply)}`).join("\n\n") : "",
  ].join("\n");
  const user = `${input.quotedText ? `Replying to: ${JSON.stringify(input.quotedText.slice(0, 600))}\n` : ""}Message: ${JSON.stringify(input.text.slice(0, 1200))}\nReading:`;
  const result = await askModel({ purpose: "reader", system, user, maxTokens: 400 });
  if (!result) return patterns;
  try {
    const raw = result.text;
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Partial<Reading>;
    const orders = (parsed.orders ?? []).map((o) => ({ ...(typeof o.orderId === "number" ? { orderId: o.orderId } : {}), ...(o.labRef ? { labRef: String(o.labRef).toUpperCase() } : {}) })).filter((o) => o.orderId || o.labRef);
    const events = (parsed.events ?? []).filter((e) => FACT_KINDS.includes(e.kind as FactKind) && String(e.value ?? "").trim()).map((e) => ({ kind: e.kind as FactKind, value: String(e.value).slice(0, 300), confidence: typeof e.confidence === "number" ? e.confidence : 0.8 }));
    const kinds: RequestKind[] = ["status", "report", "slot", "reschedule", "cancel", "change_tests", "new_booking", "serviceability", "complaint", "details", "other", "none", "noise"];
    let kind = kinds.includes(parsed.request?.kind as RequestKind) ? (parsed.request!.kind as RequestKind) : patterns.request.kind;
    if (input.side === "store" && kind === "details") kind = "other"; // 'details' is a lab's ask for patient contact
    const reading: Reading = {
      side: input.side,
      orders: orders.length ? orders : patterns.orders, // ids the patterns saw in the text are never dropped
      samples: { ...patterns.samples, ...(parsed.samples ?? {}) },
      events: events.length || input.side === "store" ? events : patterns.events,
      request: { kind: kind === "noise" ? "none" : kind, time: parsed.request?.time ?? patterns.request.time ?? null },
      ack: parsed.ack === true && kind !== "reschedule" && kind !== "cancel",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
      via: "model",
    };
    // An id written in the text always wins over the model's guess.
    for (const o of patterns.orders) if (!reading.orders.some((x) => x.orderId === o.orderId && x.labRef === o.labRef)) reading.orders.unshift(o);
    return reading;
  } catch {
    return patterns;
  }
}
