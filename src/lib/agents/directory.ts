/**
 * The directory the agents read (DESIGN.md §3 step 2): labs with their tier
 * and group, stores with their group and weight, loaded once per sweep.
 *
 * Tier A: orders go through an API (LabStack's integration flag). Tier B:
 * a partner portal but no API (named here until the console carries it).
 * Tier C: manual, WhatsApp only.
 */
import prisma from "@/lib/db/client";
import { labstackWorkerQuery } from "@/lib/db/labstack";

export type LabTier = "A" | "B" | "C";

/** The pilot (DESIGN.md §16), matched by name so ids never have to be typed. */
/**
 * The pilot, as chosen on 23 Oct 2026: Orange Health (every city), Thyrocare
 * India, Advaitha and Star Pathology; the store is Plum. Matched on the name
 * as LabStack spells it — anchored so "… and Thyrocare Services" (another lab)
 * and Redcliffe's unit Celara stay out.
 */
export const PILOT_LABS = [/^orange health/i, /^thyrocare india$/i, /advaitha/i, /star patho/i];
export const PILOT_STORES = [/plum/i];
export type LabEntry = { labId: number; labName: string; tier: LabTier; groupJid: string | null; groupId: string | null; managerWhatsapp: string | null; hasPortal: boolean };
export type StoreEntry = { storeId: number; storeName: string | null; groupJid: string | null; groupId: string | null; weight: number };
export type Directory = { labs: Map<number, LabEntry>; stores: Map<number, StoreEntry> };

/** Portal-only labs (Tier B) until the console carries a flag for it. */
const PORTAL_ONLY_LAB_NAMES = [/bugspeaks/i, /gene box/i, /apollo.*drop/i];
/** Store weight for inbox sorting (FR-10.4): key accounts first. */
const STORE_WEIGHT_BY_NAME: Array<[RegExp, number]> = [[/plum/i, 3], [/star health/i, 2], [/elevate/i, 2]];

let cache: { at: number; value: Directory } | null = null;
const TTL_MS = 60_000;

export async function loadDirectory(force = false): Promise<Directory> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const [configs, groups, apiLabs] = await Promise.all([
    prisma.nonApiLabConfig.findMany({ select: { labId: true, labName: true, integrationType: true, waGroupJid: true, managerWhatsapp: true } }),
    prisma.waGroup.findMany({ where: { archivedAt: null }, select: { id: true, jid: true, role: true, labId: true, storeId: true, subject: true } }),
    labstackWorkerQuery<{ id: number; labName: string; isApi: boolean }>(
      `SELECT id, "labName", (COALESCE("isApiHomeSample", false) OR COALESCE("isApiCenterVisit", false) OR COALESCE("isApiPpmc", false)) AS "isApi" FROM public."Lab"`,
    ).catch(() => [] as Array<{ id: number; labName: string; isApi: boolean }>),
  ]);
  const groupByJid = new Map(groups.map((g) => [g.jid, g]));
  const labGroupByLab = new Map(groups.filter((g) => g.role === "PROVIDER" && g.labId != null).map((g) => [g.labId!, g]));
  const storeGroupByStore = new Map(groups.filter((g) => g.role === "SUPPORT" && g.storeId != null).map((g) => [g.storeId!, g]));
  const apiById = new Map(apiLabs.map((l) => [l.id, l]));

  const labs = new Map<number, LabEntry>();
  for (const c of configs) {
    const api = apiById.get(c.labId);
    const isApi = api ? api.isApi : c.integrationType === "API";
    const portalOnly = PORTAL_ONLY_LAB_NAMES.some((re) => re.test(c.labName));
    const tier: LabTier = isApi ? "A" : portalOnly ? "B" : "C";
    const group = c.waGroupJid ? groupByJid.get(c.waGroupJid) ?? labGroupByLab.get(c.labId) : labGroupByLab.get(c.labId);
    labs.set(c.labId, { labId: c.labId, labName: c.labName, tier, groupJid: group?.jid ?? c.waGroupJid ?? null, groupId: group?.id ?? null, managerWhatsapp: c.managerWhatsapp ?? null, hasPortal: tier !== "C" });
  }
  for (const l of apiLabs) {
    if (labs.has(l.id)) continue;
    const group = labGroupByLab.get(l.id);
    labs.set(l.id, { labId: l.id, labName: l.labName, tier: l.isApi ? "A" : "C", groupJid: group?.jid ?? null, groupId: group?.id ?? null, managerWhatsapp: null, hasPortal: l.isApi });
  }
  const stores = new Map<number, StoreEntry>();
  for (const [storeId, g] of storeGroupByStore) {
    const weight = STORE_WEIGHT_BY_NAME.find(([re]) => re.test(g.subject))?.[1] ?? 1;
    stores.set(storeId, { storeId, storeName: g.subject, groupJid: g.jid, groupId: g.id, weight });
  }
  const value = { labs, stores };
  cache = { at: Date.now(), value };
  return value;
}

export const tierOf = (dir: Directory, labId: number | null): LabTier | null => (labId == null ? null : dir.labs.get(labId)?.tier ?? "C");
