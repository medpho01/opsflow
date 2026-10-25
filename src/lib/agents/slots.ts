/**
 * When a lab usually collects — from its last 30 days of appointments in
 * LabStack, since slot configuration is not kept there for home collection.
 * Answers "slots please" with something true: "6:00–11:00 am, most at 7–8 am".
 * Cached an hour per lab. Read-only.
 */
import { labstackWorkerQuery } from "@/lib/db/labstack";

const cache = new Map<number, { at: number; text: string | null }>();
const label = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? " am" : " pm"}`;

export async function typicalSlotsFor(labId: number, labName?: string | null): Promise<string | null> {
  const hit = cache.get(labId);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.text;
  const rows = await labstackWorkerQuery<{ h: number; n: number }>(
    `SELECT extract(hour from "appointmentTime" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::int AS h, count(*)::int AS n
       FROM public."Order" WHERE "labId" = $1 AND "appointmentTime" > now() - interval '30 days' AND "orderStatus" NOT IN ('CANCELED','CANCELLED')
      GROUP BY 1 ORDER BY 1`, [labId],
  ).catch(() => []);
  const total = rows.reduce((a, r) => a + r.n, 0);
  let text: string | null = null;
  if (total >= 10) {
    // The hours that hold 90% of bookings, and the single busiest hour.
    const sorted = [...rows].sort((a, b) => b.n - a.n);
    let acc = 0; const keep = new Set<number>();
    for (const r of sorted) { if (acc >= total * 0.9) break; keep.add(r.h); acc += r.n; }
    const hours = [...keep].sort((a, b) => a - b);
    const peak = sorted[0].h;
    text = `${labName?.trim() || "The lab"} usually collects between ${label(hours[0])} and ${label(hours[hours.length - 1] + 1)} (most bookings ${label(peak)}–${label(peak + 1)})`;
  }
  cache.set(labId, { at: Date.now(), text });
  return text;
}
