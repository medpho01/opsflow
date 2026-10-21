/**
 * POST /api/provider/order/[token] — a tap on the lab/phlebo action page.
 * Form fields: action (ACCEPT | PHLEBO_STARTED | COLLECTED | HANDED_TO_LAB | REPORT_SHARED | PATIENT_UNREACHABLE),
 * photo (optional image, kept as proof), reason (optional).
 * Each tap becomes a fact on the order's journey with source "action_page" at confidence 1, which
 * the evidence bar accepts for a status write (FR-8.8, FR-3.2). The page redirects back with the result.
 */
import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import prisma from "@/lib/db/client";
import { decryptOrderToken } from "@/lib/non-api-labs/confirmation-link";
import { recordJourneyEvent, wakeJourney } from "@/lib/agents/journey/run";

const FACT: Record<string, { kind: string; value: string }> = {
  ACCEPT: { kind: "confirmed", value: "accepted on the action page" },
  PHLEBO_STARTED: { kind: "phlebo_started", value: "phlebo started (action page)" },
  COLLECTED: { kind: "sample_collected", value: "collected (action page)" },
  HANDED_TO_LAB: { kind: "sample_delivered", value: "handed to the lab (action page)" },
  REPORT_SHARED: { kind: "report_shared", value: "report shared (action page)" },
  PATIENT_UNREACHABLE: { kind: "patient_unavailable", value: "patient not reachable (action page)" },
};
const PROOF_DIR = process.env.AGENT_PROOF_DIR || path.join(process.cwd(), ".agent-proof");
const MAX_PHOTO = 8 * 1024 * 1024;

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const back = (result: string, did = "") => NextResponse.redirect(new URL(`/provider/order/${token}?result=${result}${did ? `&did=${did}` : ""}`, request.url), 303);
  let orderId: number;
  try { orderId = Number(await decryptOrderToken(token)); if (!Number.isInteger(orderId)) throw new Error("bad"); } catch { return back("error"); }
  const form = await request.formData().catch(() => null);
  const action = String(form?.get("action") ?? "");
  const fact = FACT[action];
  if (!form || !fact) return back("error");
  const reason = String(form.get("reason") ?? "").slice(0, 200);
  let photoPath: string | null = null;
  const photo = form.get("photo");
  if (photo && typeof photo === "object" && "arrayBuffer" in photo && (photo as File).size > 0 && (photo as File).size <= MAX_PHOTO) {
    await mkdir(PROOF_DIR, { recursive: true });
    const ext = ((photo as File).type.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "");
    photoPath = path.join(PROOF_DIR, `${orderId}-${action}-${Date.now()}.${ext}`);
    await writeFile(photoPath, Buffer.from(await (photo as File).arrayBuffer()));
  }
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const at = new Date();
  const recorded = await recordJourneyEvent(orderId, {
    kind: "fact", at, actor: "LAB",
    payload: { kind: fact.kind, value: reason ? `${fact.value}: ${reason}` : fact.value, confidence: 1, source: "action_page", attributedBy: "ORDER_ID", factId: `tap:${orderId}:${action}:${at.getTime()}`, photoPath, ip },
  }, false);
  if (!recorded) {
    // No journey yet (order outside the window): still keep the evidence on the provider timeline.
    const wf = await prisma.labCommunicationWorkflow.findUnique({ where: { orderId }, select: { id: true } });
    if (wf) await prisma.labCommunicationOrderEvent.create({ data: { workflowId: wf.id, type: "PROVIDER_NOTE", actorType: "LAB", payload: { source: "ACTION_PAGE", action, reason, photoPath }, occurredAt: at } });
  } else {
    await wakeJourney(orderId, "inbound").catch(() => undefined);
  }
  return back("ok", action);
}
