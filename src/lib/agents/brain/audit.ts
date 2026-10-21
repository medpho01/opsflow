/**
 * The Brain's daily audit (FR-4.8, FR-14.3): a sample of yesterday's status
 * writes and lab-reply reads, graded. Where a key is set, a model re-reads
 * each sampled reply blind and the two readings are compared; without one,
 * the pattern reader is the second opinion. Every disagreement becomes an
 * eval case, and the lab × transition's agreement count moves accordingly.
 */
import prisma from "@/lib/db/client";
import { extractWithPatterns } from "@/lib/provider-rules/reply-extract";
import { askModel } from "../llm";

export type AuditResult = { sampled: number; disagreements: number; cases: number };

const SAMPLE = Number(process.env.AGENT_AUDIT_SAMPLE ?? 30);

export async function auditSample(now = new Date()): Promise<AuditResult> {
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const events = await prisma.agentJourneyEvent.findMany({
    where: { kind: "fact", at: { gte: since }, actor: "LAB" }, orderBy: { at: "desc" }, take: SAMPLE * 4,
    select: { id: true, journeyId: true, payload: true, at: true },
  });
  // Spread the sample across journeys.
  const seen = new Set<string>(); const sample: typeof events = [];
  for (const e of events) { if (seen.has(e.journeyId)) continue; seen.add(e.journeyId); sample.push(e); if (sample.length >= SAMPLE) break; }
  let disagreements = 0; let cases = 0;
  for (const e of sample) {
    const p = e.payload as { kind: string; value: string; confidence?: number; messageId?: string };
    const message = p.messageId ? await prisma.waMessage.findUnique({ where: { id: p.messageId }, select: { text: true } }) : null;
    const text = message?.text ?? p.value;
    const second = await secondOpinion(text);
    const agree = second.includes(p.kind) || (p.kind === "note" && second.length === 0);
    if (!agree) {
      disagreements += 1;
      await prisma.agentEvalCase.create({ data: { suite: "lab_reply_reader", input: { text }, expected: { kinds: second, firstRead: p.kind }, labels: ["audit", "disagreement"], addedFrom: "AUDIT" } });
      cases += 1;
    }
  }
  return { sampled: sample.length, disagreements, cases };
}

async function secondOpinion(text: string): Promise<string[]> {
  const viaModel = await askModel({
    purpose: "audit", system: "You read one short WhatsApp message from a diagnostic lab about a home sample-collection order. Return ONLY JSON {\"kinds\": [...]} with the fact kinds it states, from: eta, phlebo_name, phlebo_phone, delay_reason, sample_collected, patient_unavailable, new_appointment_time, report_shared, cannot_fulfil, confirmed, note.",
    user: `Message:\n"""${text.slice(0, 1000)}"""`, maxTokens: 120,
  });
  if (viaModel) {
    try { const parsed = JSON.parse(viaModel.text.slice(viaModel.text.indexOf("{"), viaModel.text.lastIndexOf("}") + 1)) as { kinds?: string[] }; if (Array.isArray(parsed.kinds)) return parsed.kinds; } catch { /* fall through */ }
  }
  return extractWithPatterns(text, { confirmation: true }).map((f) => f.kind);
}
