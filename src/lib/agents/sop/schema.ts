/**
 * The SOP format (DESIGN.md §6): typed JSON, validated here, one per desk.
 * The step function reads a resolved `SopParams` for an order (defaults plus
 * every override whose `when` matches), so a change to the SOP is a change
 * to behaviour on the next wake, and replay can run an old or proposed
 * version against the same events.
 */
import { z } from "zod";

export const DESKS = ["LAB", "INTAKE", "STORE", "KIT", "ESCALATION"] as const;
export type Desk = (typeof DESKS)[number];

/** Rungs of the escalation ladder (FR-8.7). The order in a SOP is the order they run. */
export const RUNGS = ["portal_read", "ask", "reminder", "manager_whatsapp", "call", "task", "stuck"] as const;
export type Rung = (typeof RUNGS)[number];

export const ACTIONS = [
  "ask", "reminder", "manager_whatsapp", "call", "create_task", "stuck", "portal_read", "status_write",
  "store_reply", "store_alert", "store_warning", "ack", "wait",
] as const;
export type ActionName = (typeof ACTIONS)[number];

const evidenceBar = z.object({
  sources: z.array(z.string()).default(["lab_reply"]),
  minConfidence: z.number().min(0).max(1).default(0.85),
  needsOrderNamed: z.boolean().default(true),
  /** Start in suggest whatever the autonomy matrix says (the two risky transitions). */
  alwaysSuggest: z.boolean().default(false),
});

const askSpec = z.object({
  /** The combined-message intent this ask joins (BATCH_* template). */
  intent: z.string(),
  /** Minutes before the due time the ask may first go (the send window opens). */
  leadMin: z.number().int().min(0).default(0),
  /** Minutes after the due time the ask may still go; after that it is withdrawn. */
  graceMin: z.number().int().min(0).default(240),
  /** Visit within this many minutes: send alone, at once (FR-6.5). */
  urgentWithinMin: z.number().int().min(0).default(90),
  /** Medium and high risk orders are asked the evening before (FR-16.3). */
  nightBefore: z.boolean().default(false),
});

export const sopParamsSchema = z.object({
  /** Minutes between rungs. */
  rungGapMin: z.number().int().min(5).default(30),
  /** Two broken promises skip a rung. */
  brokenPromisesSkip: z.number().int().min(1).default(2),
  /** Minutes a lab's answer (without a time) holds the ladder before the next rung. */
  answerHoldMin: z.number().int().min(0).default(120),
  /** A promise without a time ("will check") becomes one due this many minutes out. */
  defaultPromiseMin: z.number().int().min(0).default(120),
  /** Grace after a promise's time before it counts as broken. */
  promiseGraceMin: z.number().int().min(0).default(15),
  /** Counterparty working hours (local), for asks not tied to a slot (DESIGN.md §4.15). */
  workingHours: z.object({ start: z.string().default("08:30"), end: z.string().default("20:00") }).prefault({}),
  /** Nothing goes out in this window unless the visit is within urgentWithinMin. */
  nightFloor: z.object({ start: z.string().default("22:00"), end: z.string().default("05:00") }).prefault({}),
  ladder: z.array(z.enum(RUNGS)).default(["ask", "reminder", "manager_whatsapp", "task", "stuck"]),
  /** Per checkpoint: how it is asked. Checkpoints not listed are not chased. */
  asks: z.record(z.string(), askSpec).default({}),
  evidenceBar: z.record(z.string(), evidenceBar).default({}),
  /** Lab-raised problems and what they start (FR-8.9, FR-11). */
  handoffs: z.array(z.object({
    onFact: z.string(),
    do: z.enum(["store_alert", "create_task", "status_write"]),
    template: z.string().optional(),
    taskType: z.string().optional(),
    transition: z.string().optional(),
  })).default([]),
  /** Actions this desk may ever propose; the guard rejects anything else. */
  menu: z.array(z.enum(ACTIONS)).default([]),
  /** Store desk: intents and what each does. */
  intents: z.record(z.string(), z.object({
    do: z.enum(["answer", "chase_lab", "task", "escalation", "network_task", "ignore"]),
    taskType: z.string().optional(),
    template: z.string().optional(),
  })).default({}),
  /** Risk signal weights (FR-16.2). */
  riskWeights: z.record(z.string(), z.number()).default({}),
  riskThresholds: z.object({ medium: z.number().default(3), high: z.number().default(5) }).prefault({}),
  /** Warn the store at least this many minutes before the checkpoint (FR-16.4). */
  warnStoreBeforeMin: z.number().int().default(120),
});
export type SopParams = z.infer<typeof sopParamsSchema>;

const override = z.object({
  when: z.object({
    labTier: z.enum(["A", "B", "C"]).optional(),
    labId: z.number().int().optional(),
    storeId: z.number().int().optional(),
    orderType: z.string().optional(),
  }),
  // A partial of the params; the merged result is validated by sopParamsSchema in resolveParams.
  set: z.record(z.string(), z.unknown()),
});

export const sopBodySchema = z.object({
  desk: z.enum(DESKS),
  title: z.string(),
  description: z.string().optional(),
  params: sopParamsSchema,
  overrides: z.array(override).default([]),
  /** What the Brain may change on its own at a review (FR-4.7). */
  bounds: z.record(z.string(), z.object({ min: z.number(), max: z.number() })).default({}),
  /** Where each rule came from, for the SOP library. */
  provenance: z.record(z.string(), z.string()).default({}),
});
export type SopBody = z.infer<typeof sopBodySchema>;

export type SopContext = { labTier?: "A" | "B" | "C" | null; labId?: number | null; storeId?: number | null; orderType?: string | null };

function merge<T>(base: T, patch: unknown): T {
  if (patch == null || typeof patch !== "object" || Array.isArray(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    const prev = out[k];
    out[k] = prev != null && typeof prev === "object" && !Array.isArray(prev) && v != null && typeof v === "object" && !Array.isArray(v) ? merge(prev, v) : v;
  }
  return out as T;
}

/** The parameters that apply to one order: defaults, then every matching override in order. */
export function resolveParams(body: SopBody, ctx: SopContext): SopParams {
  let params = body.params;
  for (const o of body.overrides) {
    const w = o.when;
    if (w.labTier && w.labTier !== ctx.labTier) continue;
    if (w.labId != null && w.labId !== ctx.labId) continue;
    if (w.storeId != null && w.storeId !== ctx.storeId) continue;
    if (w.orderType && w.orderType !== ctx.orderType) continue;
    params = merge(params, o.set);
  }
  return sopParamsSchema.parse(params);
}

export function parseSop(body: unknown): SopBody {
  return sopBodySchema.parse(body);
}

/** Which flat parameters a proposal touches, for the bounds check. */
export function changedPaths(a: unknown, b: unknown, prefix = ""): string[] {
  if (a === b) return [];
  if (a == null || b == null || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix || "(root)"];
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  const out: string[] = [];
  for (const k of keys) out.push(...changedPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k));
  return out;
}

/** A proposal is in bounds when every changed numeric path has a bound and the new value sits inside it. */
export function withinBounds(base: SopBody, next: SopBody): { inBounds: boolean; outside: string[] } {
  const paths = changedPaths(base, next);
  const outside: string[] = [];
  for (const p of paths) {
    const bound = next.bounds[p] ?? base.bounds[p];
    const value = p.split(".").reduce<unknown>((o, k) => (o != null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), next);
    if (!bound || typeof value !== "number" || value < bound.min || value > bound.max) outside.push(p);
  }
  return { inBounds: outside.length === 0, outside };
}
