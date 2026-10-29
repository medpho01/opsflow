/**
 * Model calls for the agents (DESIGN.md §11): one door, with redaction
 * before anything leaves, an audit row per call, and a null result when no
 * key is set so every caller has a deterministic fallback.
 *
 * Roles: reader (Haiku-class), caseworker and drafter (Sonnet-class), brain
 * (strongest). Model ids come from env so a change is config, gated by evals.
 */
import prisma from "@/lib/db/client";

export type Purpose = "reader" | "store_reader" | "caseworker" | "drafter" | "brain" | "audit" | "auditor";

const MODELS: Record<Purpose, () => string> = {
  reader: () => process.env.AGENT_MODEL_READER || process.env.PROVIDER_REPLY_MODEL || "claude-haiku-4-5-20251001",
  store_reader: () => process.env.AGENT_MODEL_READER || "claude-haiku-4-5-20251001",
  caseworker: () => process.env.AGENT_MODEL_CASEWORKER || "claude-sonnet-4-5-20250929",
  drafter: () => process.env.AGENT_MODEL_CASEWORKER || "claude-sonnet-4-5-20250929",
  brain: () => process.env.AGENT_MODEL_BRAIN || "claude-opus-5-5",
  audit: () => process.env.AGENT_MODEL_READER || "claude-haiku-4-5-20251001",
  // The outcome auditor reads the groups as they are and judges whether the jobs got done — the
  // strongest model the account runs (29 Oct 2026). AGENT_MODEL_AUDITOR=claude-fable-5-1 for the most capable.
  auditor: () => process.env.AGENT_MODEL_AUDITOR || "claude-opus-5-5",
};

/** Models that always think before answering: they need room for it, and a little patience. */
const THINKS = /claude-(opus-5|fable-5|mythos-5|sonnet-5|haiku-5)/;
/** Models that take the server-side refusal fallback (another model answers a declined request). */
const FALLBACK = /claude-(opus-5-5|opus-5$|fable-5-1|sonnet-5-5)/;

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
export async function askModel(input: { purpose: Purpose; system: string; user: string; maxTokens?: number; journeyId?: string | null; redactUser?: boolean; effort?: "low" | "medium" | "high" | "xhigh" | "max"; timeoutMs?: number }): Promise<ModelResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || process.env.AGENT_LLM === "off") return null;
  const model = MODELS[input.purpose]();
  const user = input.redactUser === false ? input.user : redact(input.user).text;
  const thinks = THINKS.test(model);
  const fallback = FALLBACK.test(model);
  try {
    // A thinking model spends tokens before it writes: a 300-token cap would leave nothing for the
    // answer, so it gets room, an explicit effort, and minutes rather than seconds.
    const body: Record<string, unknown> = {
      model, max_tokens: thinks ? Math.max(input.maxTokens ?? 600, 8000) : input.maxTokens ?? 600,
      system: input.system, messages: [{ role: "user", content: user }],
      ...(thinks ? { output_config: { effort: input.effort ?? "medium" } } : {}),
      // A request the model declines is answered by the fallback model in the same call.
      ...(fallback ? { fallbacks: "default" } : {}),
    };
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", ...(fallback ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(input.timeoutMs ?? (thinks ? 300_000 : 30_000)),
    });
    if (!response.ok) throw new Error(`model ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
    const data = await response.json() as { model?: string; stop_reason?: string; content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
    if (data.stop_reason === "refusal") throw new Error("model declined the request");
    const text = (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
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
  // Rupees per million tokens (₹85 ≈ $1). Opus 5.5 $4/$20, Fable 5.1 $10/$50.
  const tier = model.includes("haiku-5") ? [9, 43] : model.includes("haiku") ? [85, 425] : model.includes("sonnet") ? [170, 850] : model.includes("fable") || model.includes("mythos") ? [850, 4250] : model.includes("opus-5") ? [340, 1700] : [1250, 6250];
  const perMIn = Number(process.env.AGENT_COST_IN_PER_M ?? tier[0]);
  const perMOut = Number(process.env.AGENT_COST_OUT_PER_M ?? tier[1]);
  return Math.round((inTok / 1e6) * perMIn * 100 + (outTok / 1e6) * perMOut * 100);
}
