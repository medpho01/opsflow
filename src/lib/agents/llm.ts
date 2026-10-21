/**
 * Model calls for the agents (DESIGN.md §11): one door, with redaction
 * before anything leaves, an audit row per call, and a null result when no
 * key is set so every caller has a deterministic fallback.
 *
 * Roles: reader (Haiku-class), caseworker and drafter (Sonnet-class), brain
 * (strongest). Model ids come from env so a change is config, gated by evals.
 */
import prisma from "@/lib/db/client";

export type Purpose = "reader" | "store_reader" | "caseworker" | "drafter" | "brain" | "audit";

const MODELS: Record<Purpose, () => string> = {
  reader: () => process.env.AGENT_MODEL_READER || process.env.PROVIDER_REPLY_MODEL || "claude-haiku-4-5-20251001",
  store_reader: () => process.env.AGENT_MODEL_READER || "claude-haiku-4-5-20251001",
  caseworker: () => process.env.AGENT_MODEL_CASEWORKER || "claude-sonnet-4-5-20250929",
  drafter: () => process.env.AGENT_MODEL_CASEWORKER || "claude-sonnet-4-5-20250929",
  brain: () => process.env.AGENT_MODEL_BRAIN || "claude-opus-4-1-20250805",
  audit: () => process.env.AGENT_MODEL_READER || "claude-haiku-4-5-20251001",
};

/** Phone numbers become [PHONE_n]; long digit runs that are not order ids are masked (DPDP). */
export function redact(text: string): { text: string; map: Record<string, string> } {
  const map: Record<string, string> = {};
  let n = 0;
  const out = text.replace(/(?:\+?91[\s-]?)?\b([6-9]\d{9})\b/g, (_m, digits: string) => {
    n += 1; const key = `[PHONE_${n}]`; map[key] = digits; return key;
  });
  return { text: out, map };
}

export type ModelResult = { text: string; model: string; inputTokens: number; outputTokens: number };

/** Returns null when no key is configured or the call fails; callers fall back to patterns. */
export async function askModel(input: { purpose: Purpose; system: string; user: string; maxTokens?: number; journeyId?: string | null; redactUser?: boolean }): Promise<ModelResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || process.env.AGENT_LLM === "off") return null;
  const model = MODELS[input.purpose]();
  const user = input.redactUser === false ? input.user : redact(input.user).text;
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: input.maxTokens ?? 600, system: input.system, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`model ${response.status}`);
    const data = await response.json() as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
    const text = data.content?.find((c) => c.type === "text")?.text ?? "";
    const result = { text, model, inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 };
    await prisma.agentAction.create({
      data: { journeyId: input.journeyId ?? null, desk: "BRAIN", action: `llm:${input.purpose}`, params: { chars: user.length }, reason: "model call", level: "ACT", outcome: "EXECUTED", model, tokens: result.inputTokens + result.outputTokens, costPaise: estimateCostPaise(model, result.inputTokens, result.outputTokens) },
    }).catch(() => undefined);
    return result;
  } catch (error) {
    console.warn(`[Agents] model call (${input.purpose}) failed:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/** Rough cost per call, in paise, for the scorecards (not a cap). Rates are placeholders in env. */
export function estimateCostPaise(model: string, inTok: number, outTok: number): number {
  const perMIn = Number(process.env.AGENT_COST_IN_PER_M ?? (model.includes("haiku") ? 80 : model.includes("sonnet") ? 250 : 1250));
  const perMOut = Number(process.env.AGENT_COST_OUT_PER_M ?? (model.includes("haiku") ? 400 : model.includes("sonnet") ? 1250 : 6250));
  return Math.round((inTok / 1e6) * perMIn * 100 + (outTok / 1e6) * perMOut * 100);
}
