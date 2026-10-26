/**
 * Which of a lab's orders a message is about when it names no reference — the
 * patient's name or phone, or a report file named after the patient (27 Oct
 * 2026: Redcliffe answers report chases as "Magnesium tat 48 hrs · Rishi ·
 * 93xxxxxx41", Star shares "2026_10_26_Mr._SULLGH_SARVALIA.pdf").
 *
 * A match needs one of: the patient's 10-digit mobile; the full name; two of
 * the name's words; or one word of 5+ letters that no other candidate shares.
 * Candidates are the lab's orders of the last 30 days that are not cancelled.
 */
import { labstackWorkerQuery } from "@/lib/db/labstack";

export type PatientCandidate = { id: number; name: string | null; mobile: string | null };

const STOP = new Set(["mr", "mrs", "ms", "miss", "dr", "master", "baby", "kumar", "kumari", "devi", "singh", "bai", "lal", "ben", "bhai", "report", "reports", "pdf", "the", "and", "for", "sample", "test"]);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words = (s: string) => norm(s).split(" ").filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
const phones = (s: string) => [...new Set((s.replace(/[\s-]/g, "").match(/\d{10,13}/g) ?? []).map((d) => d.slice(-10)))];

/** Order ids the text names by patient, with the line of the text that names each. Pure. */
export function matchPatients(text: string, candidates: PatientCandidate[]): Map<number, string> {
  const out = new Map<number, string>();
  if (!text.trim() || !candidates.length) return out;
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const textPhones = phones(text);
  const textWords = new Set(words(text));
  const wordOwners = new Map<string, number>();
  for (const c of candidates) for (const w of new Set(words(c.name ?? ""))) wordOwners.set(w, (wordOwners.get(w) ?? 0) + 1);

  for (const c of candidates) {
    const mobile = c.mobile ? c.mobile.replace(/\D/g, "").slice(-10) : null;
    const nameWords = [...new Set(words(c.name ?? ""))];
    let hit = false;
    if (mobile && mobile.length === 10 && textPhones.includes(mobile)) hit = true;
    else if (nameWords.length) {
      const present = nameWords.filter((w) => textWords.has(w));
      const full = nameWords.length >= 2 && present.length === nameWords.length;
      const two = present.length >= 2;
      const unique = present.length === 1 && present[0].length >= 5 && wordOwners.get(present[0]) === 1;
      hit = full || two || unique;
    }
    if (!hit) continue;
    const line = lines.find((l) => (mobile && l.replace(/[\s-]/g, "").includes(mobile)) || nameWords.some((w) => norm(l).split(" ").includes(w))) ?? text;
    out.set(c.id, line);
  }
  return out;
}

export async function patientCandidates(labId: number, days = 30): Promise<PatientCandidate[]> {
  return labstackWorkerQuery<PatientCandidate>(
    `SELECT o.id, u.name, u.mobile FROM public."Order" o LEFT JOIN public."User" u ON u.id = o."userId"
      WHERE o."labId" = $1 AND o."orderStatus"::text NOT IN ('CANCELED','CANCELLED')
        AND (o."appointmentTime" >= NOW() - ($2 || ' days')::interval OR (o."appointmentTime" IS NULL AND o."createdAt" >= NOW() - ($2 || ' days')::interval))
      ORDER BY o."appointmentTime" DESC NULLS LAST LIMIT 400`,
    [labId, String(days)],
  ).catch(() => []);
}

/** Each of this lab's orders the text names by patient → what it says about it. */
export async function matchOrdersByPatient(text: string, labId: number): Promise<Map<number, string>> {
  return matchPatients(text, await patientCandidates(labId));
}
