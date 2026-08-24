import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

export const dynamic = "force-dynamic";

// Server-Sent Events: pushes a "changed" ping whenever new WhatsApp activity
// lands, so the console updates instantly instead of polling. The client
// refetches on each ping.
export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT))
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      let sig = "";
      const tick = async () => {
        if (closed) return;
        try {
          const [msg, tk] = await Promise.all([
            prisma.waMessage.aggregate({ _max: { ts: true }, _count: true }),
            prisma.waTicket.aggregate({ _max: { lastActivityAt: true }, _count: true }),
          ]);
          const next = `${msg._max.ts?.toISOString() || ""}:${msg._count}:${tk._max.lastActivityAt?.toISOString() || ""}:${tk._count}`;
          if (next !== sig) { sig = next; send({ changed: true, at: Date.now() }); }
        } catch { /* transient — retry next tick */ }
      };

      send({ hello: true });
      await tick();
      const iv = setInterval(tick, 1500);
      const ka = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(`: ping\n\n`)); }, 25000);
      request.signal.addEventListener("abort", () => {
        closed = true; clearInterval(iv); clearInterval(ka);
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // disable proxy buffering (nginx)
    },
  });
}
