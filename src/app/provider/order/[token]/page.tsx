/**
 * The lab and phlebo action page (FR-8.8, DESIGN.md §7.6): a durable link per
 * order (the encrypted order id, as the confirmation link uses) where the lab
 * or its phlebo taps Accept · Phlebo started · Collected (with a photo) ·
 * Handed to lab · Report shared. Each tap is evidence for a status write.
 */
import prisma from "@/lib/db/client";
import { decryptOrderToken } from "@/lib/non-api-labs/confirmation-link";
import { fetchOrderSnapshot } from "@/lib/agents/journey/window";

export const dynamic = "force-dynamic";

const STEPS = [
  { key: "ACCEPT", label: "Accept the order", cls: "bg-emerald-600 hover:bg-emerald-500" },
  { key: "PHLEBO_STARTED", label: "Phlebo started", cls: "bg-blue-600 hover:bg-blue-500" },
  { key: "COLLECTED", label: "Sample collected (add a photo)", cls: "bg-blue-600 hover:bg-blue-500", photo: true },
  { key: "HANDED_TO_LAB", label: "Handed to the lab", cls: "bg-blue-600 hover:bg-blue-500" },
  { key: "REPORT_SHARED", label: "Report shared", cls: "bg-blue-600 hover:bg-blue-500" },
  { key: "PATIENT_UNREACHABLE", label: "Patient not reachable", cls: "bg-amber-600 hover:bg-amber-500", reason: true },
] as const;

export default async function OrderActionPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ result?: string; did?: string }> }) {
  const { token } = await params;
  const { result, did } = await searchParams;
  let orderId: number | null = null;
  try { orderId = Number(await decryptOrderToken(token)); } catch { orderId = null; }
  const order = orderId && Number.isInteger(orderId) ? await fetchOrderSnapshot(orderId).catch(() => null) : null;
  const journey = order ? await prisma.agentJourney.findUnique({ where: { orderId: order.id }, select: { closedAt: true, checkpoints: { select: { name: true, status: true } } } }) : null;
  const tz = process.env.TIMEZONE || "Asia/Kolkata";
  const slot = order?.appointmentTime ? order.appointmentTime.toLocaleString("en-IN", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";
  const done = new Set((journey?.checkpoints ?? []).filter((c) => c.status === "MET").map((c) => c.name));
  const closed = !order || !!journey?.closedAt || ["CANCELED", "REPORT_DELIVERED"].includes(order.orderStatus);

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-6 text-zinc-100">
      <div className="mx-auto max-w-md">
        <div className="text-xs text-zinc-500">LabStack · OpsFlow</div>
        {!order ? <h1 className="mt-2 text-xl font-semibold">This link is not valid</h1> : (
          <>
            <h1 className="mt-2 text-xl font-semibold">#{order.id} · {(order.patientName ?? "Patient").split(" ")[0]}</h1>
            <div className="mt-1 text-sm text-zinc-400">{slot} · {order.orderType.replace("_", " ").toLowerCase()} · {order.labName ?? ""}</div>
            {result === "ok" && <div className="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">Recorded: {did?.replace(/_/g, " ").toLowerCase()}. Thank you.</div>}
            {result === "error" && <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">Could not record that. Please try again or reply in the group.</div>}
            {closed ? <div className="mt-4 text-sm text-zinc-400">This order is closed.</div> : (
              <div className="mt-4 space-y-3">
                {STEPS.map((s) => {
                  const already = (s.key === "ACCEPT" && done.has("confirmed")) || (s.key === "COLLECTED" && done.has("sample_collected")) || (s.key === "HANDED_TO_LAB" && done.has("sample_at_lab")) || (s.key === "REPORT_SHARED" && done.has("report_delivered"));
                  return (
                    <form key={s.key} action={`/api/provider/order/${token}`} method="post" encType="multipart/form-data" className="space-y-2">
                      <input type="hidden" name="action" value={s.key} />
                      {"photo" in s && s.photo && <input type="file" name="photo" accept="image/*" capture="environment" className="block w-full text-xs text-zinc-300" />}
                      {"reason" in s && s.reason && <input name="reason" placeholder="What happened (optional)" maxLength={200} className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm" />}
                      <button disabled={already} className={`w-full rounded-lg px-4 py-3 text-base font-semibold text-white disabled:opacity-40 ${s.cls}`}>{already ? `${s.label} ✓` : s.label}</button>
                    </form>
                  );
                })}
              </div>
            )}
            <div className="mt-6 text-xs text-zinc-500">One tap updates LabStack's record for this order. For anything else, reply in the WhatsApp group.</div>
          </>
        )}
      </div>
    </main>
  );
}
