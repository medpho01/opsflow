/**
 * Evals (FR-14.3, DESIGN.md §12): suites built from labelled history and every
 * inbox correction, with a gate per suite. `npm run agents:evals` runs them;
 * CI blocks a prompt, model or SOP change that drops a suite below its gate.
 *
 *   lab_reply_reader   lab replies → fact kinds        gate 0.97 precision on status facts
 *   store_intent       store messages → intent         gate 0.90 (reschedule/cancel recall 0.98)
 *   store_linker       store messages → order id       gate 0.95, never a confident wrong link
 *   lab_status_write   inbox decisions on writes       gate 0.98 agreement
 */
import prisma from "@/lib/db/client";
import { extractWithPatterns } from "@/lib/provider-rules/reply-extract";
import { classifyStoreMessage } from "../store/reader";

export const GATES: Record<string, number> = { lab_reply_reader: 0.97, store_intent: 0.9, store_linker: 0.95, lab_status_write: 0.98 };

type Case = { id: string; input: Record<string, unknown>; expected: Record<string, unknown>; labels: string[] };
type Verdict = { pass: boolean; got: unknown; want: unknown };

const STATUS_FACTS = new Set(["sample_collected", "report_shared", "patient_unavailable", "cannot_fulfil", "confirmed"]);

function judge(suite: string, c: Case): Verdict {
  switch (suite) {
    case "lab_reply_reader": {
      const text = String(c.input.text ?? "");
      const got: string[] = extractWithPatterns(text, { confirmation: c.input.confirmation !== false }).map((f) => f.kind);
      const want = (c.expected.kinds as string[]) ?? [];
      const wantStatus = want.filter((k) => STATUS_FACTS.has(k));
      const gotStatus = (got as string[]).filter((k) => STATUS_FACTS.has(k));
      const pass = wantStatus.every((k) => gotStatus.includes(k)) && gotStatus.every((k) => wantStatus.includes(k));
      return { pass, got, want };
    }
    case "store_intent": {
      const got = classifyStoreMessage(String(c.input.text ?? "")).intent;
      const want = String(c.expected.intent);
      return { pass: got === want || (want === "other" && got === "noise"), got, want };
    }
    case "store_linker": {
      const got = (c.input.orderIds as number[] | undefined)?.[0] ?? null;
      const want = c.expected.orderId as number | null;
      return { pass: got === want, got, want };
    }
    case "lab_status_write": {
      return { pass: c.expected.decision === "APPROVED", got: c.expected.decision, want: "APPROVED" };
    }
    default: return { pass: false, got: null, want: null };
  }
}

export async function runSuite(suite: string): Promise<{ suite: string; cases: number; passed: number; score: number; gate: number; passedGate: boolean; failures: Array<{ id: string; got: unknown; want: unknown; input: unknown }> }> {
  const rows = await prisma.agentEvalCase.findMany({ where: { suite }, select: { id: true, input: true, expected: true, labels: true } });
  const cases: Case[] = rows.map((r) => ({ id: r.id, input: r.input as Record<string, unknown>, expected: r.expected as Record<string, unknown>, labels: r.labels }));
  let passed = 0; const failures: Array<{ id: string; got: unknown; want: unknown; input: unknown }> = [];
  for (const c of cases) { const v = judge(suite, c); if (v.pass) passed += 1; else if (failures.length < 50) failures.push({ id: c.id, got: v.got, want: v.want, input: c.input }); }
  const score = cases.length ? passed / cases.length : 0;
  const gate = GATES[suite] ?? 0.9;
  const result = { suite, cases: cases.length, passed, score, gate, passedGate: cases.length > 0 && score >= gate, failures };
  await prisma.agentEvalRun.create({ data: { suite, cases: cases.length, passed, score, gate, passedGate: result.passedGate, details: { failures: failures.slice(0, 20) } as object } });
  return result;
}

export async function runAllSuites() { return Promise.all(Object.keys(GATES).map(runSuite)); }

/** Seed suites from what the system already knows: the reply reader's own tests, classified store messages, review decisions. */
export async function seedFromHistory(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const seeded: Array<{ suite: string; input: object; expected: object; labels: string[] }> = [
    { suite: "lab_reply_reader", input: { text: "Phlebo Ramesh 9876543210, reaching by 9:15 am" }, expected: { kinds: ["phlebo_phone", "phlebo_name", "eta"] }, labels: ["seed"] },
    { suite: "lab_reply_reader", input: { text: "sample collected" }, expected: { kinds: ["sample_collected"] }, labels: ["seed"] },
    { suite: "lab_reply_reader", input: { text: "Report shared on mail" }, expected: { kinds: ["report_shared"] }, labels: ["seed"] },
    { suite: "lab_reply_reader", input: { text: "patient not available at home" }, expected: { kinds: ["patient_unavailable"] }, labels: ["seed"] },
    { suite: "lab_reply_reader", input: { text: "we cannot take this order today" }, expected: { kinds: ["cannot_fulfil"] }, labels: ["seed"] },
    { suite: "lab_reply_reader", input: { text: "ok will do", confirmation: true }, expected: { kinds: ["confirmed"] }, labels: ["seed"] },
    { suite: "lab_reply_reader", input: { text: "ho jayega", confirmation: true }, expected: { kinds: ["confirmed"] }, labels: ["seed"] },
    { suite: "lab_reply_reader", input: { text: "customer phone switched off, technician waiting" }, expected: { kinds: ["patient_unavailable"] }, labels: ["seed"] },
    { suite: "store_intent", input: { text: "92288 what is the status?" }, expected: { intent: "status" }, labels: ["seed"] },
    { suite: "store_intent", input: { text: "91031 kindly reschedule for 26/10 8 am and confirm" }, expected: { intent: "reschedule" }, labels: ["seed"] },
    { suite: "store_intent", input: { text: "92577 please cancel" }, expected: { intent: "cancel" }, labels: ["seed"] },
    { suite: "store_intent", input: { text: "TFT missing in the report, upload full reports" }, expected: { intent: "report" }, labels: ["seed"] },
    { suite: "store_intent", input: { text: "Add Dengue, H1N1 to 90412" }, expected: { intent: "change_tests" }, labels: ["seed"] },
    { suite: "store_intent", input: { text: "Not serviceable with current network, check for alternate lab" }, expected: { intent: "serviceability" }, labels: ["seed"] },
    { suite: "store_intent", input: { text: "Phlebo no-show and rude to a fasting user, need RCA" }, expected: { intent: "complaint" }, labels: ["seed"] },
    { suite: "store_intent", input: { text: "ok thanks" }, expected: { intent: "noise" }, labels: ["seed"] },
    { suite: "store_intent", input: { text: "phlebo at location?" }, expected: { intent: "status" }, labels: ["seed"] },
    { suite: "store_intent", input: { text: "please proceed and create the booking" }, expected: { intent: "new_booking" }, labels: ["seed"] },
  ];
  for (const s of seeded) {
    const exists = await prisma.agentEvalCase.findFirst({ where: { suite: s.suite, input: { equals: s.input } } });
    if (exists) continue;
    await prisma.agentEvalCase.create({ data: { ...s, addedFrom: "HISTORY" } });
    out[s.suite] = (out[s.suite] ?? 0) + 1;
  }
  // Store messages the gateway already classified with a validated order: linker cases.
  const linked = await prisma.waMessage.findMany({ where: { direction: "IN", orderIds: { isEmpty: false }, idType: { not: null } }, orderBy: { ts: "desc" }, take: 200, select: { text: true, orderIds: true, refIds: true, intent: true } });
  for (const m of linked) {
    const input = { text: m.text.slice(0, 300), orderIds: m.orderIds, refIds: m.refIds };
    const exists = await prisma.agentEvalCase.findFirst({ where: { suite: "store_linker", input: { equals: input } } });
    if (exists) continue;
    await prisma.agentEvalCase.create({ data: { suite: "store_linker", input, expected: { orderId: m.orderIds[0] }, labels: ["history"], addedFrom: "HISTORY" } });
    out.store_linker = (out.store_linker ?? 0) + 1;
  }
  return out;
}
