/**
 * Reading a lab's free-text reply as facts about an order.
 *
 *   "Phlebo Ramesh 9876543210, reaching by 9:15"
 *     → phlebo_name=Ramesh, phlebo_phone=9876543210, eta=9:15
 *
 * Claude does the reading (ANTHROPIC_API_KEY; model PROVIDER_REPLY_MODEL,
 * default Haiku). Without a key — local runs, tests — or when Claude fails, a
 * small pattern reader stands in, so a reply is never lost, only read less
 * cleverly. PROVIDER_REPLY_EXTRACTOR=stub forces the pattern reader.
 */
import { FACT_KINDS, type FactKind } from "./types";

export type ExtractedFact = { kind: FactKind; value: string; confidence: number };
export type Extraction = { facts: ExtractedFact[]; extractor: "claude" | "patterns" };

const MODEL = () => process.env.PROVIDER_REPLY_MODEL || "claude-haiku-4-5-20251001";

const KIND_HELP: Record<FactKind, string> = {
  eta: "when the phlebo/collection will reach (a time like '9:15 am' or a duration like '20 min')",
  phlebo_name: "the phlebotomist's name",
  phlebo_phone: "the phlebotomist's phone number, digits only",
  delay_reason: "why it is late",
  sample_collected: "the sample has been collected ('yes')",
  patient_unavailable: "the patient could not be reached / was not home (short reason)",
  new_appointment_time: "a new date/time the visit was moved to",
  report_shared: "the report has been sent/shared/uploaded ('yes')",
  cannot_fulfil: "the lab cannot do this order (short reason)",
  note: "anything else useful the lab said, in a few words",
};

/** Pattern reader — deterministic, offline, used for tests and as the fallback. */
export function extractWithPatterns(text: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const add = (kind: FactKind, value: string, confidence = 0.6) => {
    if (value && !facts.some((f) => f.kind === kind)) facts.push({ kind, value: value.trim(), confidence });
  };
  const phone = text.match(/(?:\+?91[\s-]?)?\b([6-9]\d{9})\b/);
  if (phone) add("phlebo_phone", phone[1]);
  // Keyword in any case; the name itself must be capitalised, so "phlebo is on the way" is not read as a name.
  const name = text.match(/\b(?:[Pp]hlebo(?:tomist)?|[Tt]echnician|[Tt]ech|[Nn]ame)\s*(?:[Nn]ame\s*)?(?:is|:|-)?\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/);
  if (name) add("phlebo_name", name[1]);
  const eta = text.match(/\b(?:eta|reach(?:ing|es)?|arriv\w*|by|in)\s*(?:is\s*|by\s*|in\s*)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,3}\s*(?:min|mins|minutes|hr|hrs|hours))\b/i);
  if (eta) add("eta", eta[1]);
  if (/\breport\b[^.]*\b(shared|sent|uploaded|mailed|delivered|done)\b/i.test(text)) add("report_shared", "yes", 0.7);
  else if (/\b(sample\s+(?:collected|taken|done)|collected)\b/i.test(text)) add("sample_collected", "yes", 0.7);
  const unavailable = text.match(/\b(not available|not at home|no response|not reachable|not picking|door (?:is )?locked|patient (?:not|didn't|did not) \w+)\b/i);
  if (unavailable) add("patient_unavailable", unavailable[1]);
  const cannot = text.match(/\b(?:cannot|can't|cant|unable to|won't be able to)\b[^.]*/i);
  if (cannot) add("cannot_fulfil", cannot[0]);
  const delay = text.match(/\b(?:late|delay(?:ed)?|traffic|stuck)\b[^.]*/i);
  if (delay) add("delay_reason", delay[0]);
  if (/\breschedul\w*\b/i.test(text)) add("new_appointment_time", text);
  if (facts.length === 0 && text.trim()) add("note", text.trim().slice(0, 200), 0.5);
  return facts;
}

async function extractWithClaude(text: string, context: string | null): Promise<ExtractedFact[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const system = [
    "You read a short WhatsApp message a diagnostic lab sent about one home sample-collection order, and pull out facts.",
    "Messages may mix English and Hindi/Hinglish. Return ONLY JSON: {\"facts\":[{\"kind\":..., \"value\":..., \"confidence\":0..1}]}.",
    "Allowed kinds:",
    ...FACT_KINDS.map((kind) => `- ${kind}: ${KIND_HELP[kind]}`),
    "Only include facts the message actually states. No facts → {\"facts\":[]}.",
  ].join("\n");
  const user = `${context ? `Our message they replied to:\n"""${context.slice(0, 800)}"""\n\n` : ""}The lab's message:\n"""${text.slice(0, 1500)}"""`;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL(), max_tokens: 400, system, messages: [{ role: "user", content: user }] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Claude ${response.status}`);
  const data = await response.json() as { content?: Array<{ type: string; text?: string }> };
  const raw = data.content?.find((c) => c.type === "text")?.text ?? "";
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  const parsed = JSON.parse(json) as { facts?: Array<{ kind?: string; value?: unknown; confidence?: unknown }> };
  return (parsed.facts ?? [])
    .filter((f): f is { kind: FactKind; value: unknown; confidence?: unknown } => FACT_KINDS.includes(f.kind as FactKind))
    .map((f) => ({ kind: f.kind, value: String(f.value ?? "").slice(0, 300), confidence: Number(f.confidence ?? 0.8) }))
    .filter((f) => f.value.trim().length > 0);
}

export async function extractFacts(text: string, context: string | null = null): Promise<Extraction> {
  const forced = process.env.PROVIDER_REPLY_EXTRACTOR;
  if (forced !== "stub" && process.env.ANTHROPIC_API_KEY) {
    try {
      return { facts: await extractWithClaude(text, context), extractor: "claude" };
    } catch (error) {
      console.warn("[Replies] Claude extraction failed, using patterns:", error instanceof Error ? error.message : error);
    }
  }
  return { facts: extractWithPatterns(text), extractor: "patterns" };
}
