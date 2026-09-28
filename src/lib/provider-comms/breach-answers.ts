/**
 * Applying a lab's answer to an SLA-breach poll.
 *
 * A breach poll asks "this order missed its deadline — what is happening?".
 * Until now the answer was acknowledged and then ignored: the breach kept
 * chasing on its normal cadence, "Cannot fulfil" reached nobody, and the lab's
 * follow-up text was stored on the poll row where nothing reads it.
 *
 * The answer is recorded on the breach and changes WHEN it chases next — it
 * never marks the milestone done. LabStack stays the source of truth for that:
 * "Already done" pauses chasing long enough for LabStack to catch up, and if it
 * hasn't by then, the breach resumes (and Ops can see the lab's claim).
 *
 * The breach is found through the send that carried the poll
 * (SlaBreachSend.waOutboundId = wa_polls.outboundId), so this needs no new
 * column on wa_polls and no change to how the gateway records polls.
 */
import type { Prisma } from "@prisma/client";
import prisma from "@/lib/db/client";
import type { BreachOutcome } from "@/lib/non-api-labs/poll-definitions";

/** How long each answer holds off the next chase. Only ever pushes LATER. */
const PAUSE_MINUTES: Record<Exclude<BreachOutcome, "CANNOT_FULFIL">, number> = {
  // Long enough for someone to update LabStack; if they haven't, chase again.
  DONE: parseInt(process.env.BREACH_PAUSE_DONE_MINUTES ?? "240", 10),
  ON_THE_WAY: parseInt(process.env.BREACH_PAUSE_ON_THE_WAY_MINUTES ?? "60", 10),
  DELAYED: parseInt(process.env.BREACH_PAUSE_DELAYED_MINUTES ?? "120", 10),
};

export type BreachAnswerResult = "applied" | "recorded" | "no-breach" | "no-outcome";

async function findBreachForOutbound(outboundId: string | null) {
  if (!outboundId) return null;
  const send = await prisma.slaBreachSend.findFirst({
    where: { waOutboundId: outboundId },
    select: { breachEventId: true },
  });
  if (!send) return null;
  return prisma.slaBreachEvent.findUnique({ where: { id: send.breachEventId } });
}

async function raiseCannotFulfilAlert(event: { id: string; orderId: number; labId: number; milestone: string }, voterJid: string | null) {
  await prisma.alert
    .create({
      data: {
        alertType: "ESCALATION",
        severity: "URGENT",
        channel: "IN_APP",
        status: "PENDING",
        entityType: "order",
        entityId: event.orderId,
        message: `Lab ${event.labId} says it cannot fulfil order #${event.orderId} (${event.milestone.replace(/_/g, " ").toLowerCase()} is overdue) — reassign or follow up.`,
        metadata: { source: "SLA_BREACH_POLL", breachEventId: event.id, labId: event.labId, milestone: event.milestone, voterJid } as Prisma.InputJsonValue,
      },
    })
    .catch((error) => console.error("[BreachAnswers] Could not raise Ops alert:", error));
}

/**
 * Record a breach-poll answer and act on it. Idempotent enough to re-run: a
 * pause only moves nextAttemptAt later, and closing is guarded on ACTIVE.
 */
export async function applyBreachAnswer(input: {
  outboundId: string | null;
  outcome: BreachOutcome | null;
  voterJid: string | null;
  now?: Date;
}): Promise<BreachAnswerResult> {
  const now = input.now ?? new Date();
  const event = await findBreachForOutbound(input.outboundId);
  if (!event) return "no-breach";
  if (!input.outcome) return "no-outcome";

  const recorded = { providerOutcome: input.outcome, providerReportedAt: now };

  // A breach that is already closed (resolved, capped, cancelled) just keeps
  // the lab's answer for the record — there is no chasing left to change.
  if (event.status !== "ACTIVE") {
    await prisma.slaBreachEvent.update({ where: { id: event.id }, data: recorded });
    return "recorded";
  }

  if (input.outcome === "CANNOT_FULFIL") {
    const closed = await prisma.slaBreachEvent.updateMany({
      where: { id: event.id, status: "ACTIVE" },
      data: {
        ...recorded,
        status: "CANCELLED",
        resolutionReason: "PROVIDER_CANNOT_FULFIL",
        resolvedAt: now,
        nextAttemptAt: null,
      },
    });
    if (closed.count > 0) await raiseCannotFulfilAlert(event, input.voterJid);
    return "applied";
  }

  const pauseUntil = new Date(now.getTime() + PAUSE_MINUTES[input.outcome] * 60_000);
  const nextAttemptAt =
    event.nextAttemptAt && event.nextAttemptAt.getTime() > pauseUntil.getTime() ? event.nextAttemptAt : pauseUntil;
  await prisma.slaBreachEvent.update({
    where: { id: event.id },
    data: { ...recorded, nextAttemptAt },
  });
  return "applied";
}

/** Attach the lab's follow-up text (sent after tapping) to the breach. */
export async function attachBreachReason(input: { outboundId: string | null; reason: string }): Promise<boolean> {
  const event = await findBreachForOutbound(input.outboundId);
  if (!event) return false;
  await prisma.slaBreachEvent.update({
    where: { id: event.id },
    data: { providerReason: input.reason.slice(0, 500) },
  });
  return true;
}
