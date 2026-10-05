/**
 * The Lab Config roster: every LabStack lab, with OpsFlow's provider config
 * for it, searched, filtered, sorted and paged on the server.
 *
 * Thousands of labs is too many to ship to the browser and sort there, and the
 * page exists to configure labs in order of how much they matter — so the
 * default order is lifetime orders fulfilled, busiest first.
 *
 * LabStack's half (names, cities, order counts) is one aggregate over Order,
 * cached for a few minutes: paging and typing in the search box must not
 * re-run it. OpsFlow's half (config, groups) is read fresh on every request,
 * so an edit shows up immediately.
 */
import type { NonApiLabConfig } from "@prisma/client";
import prisma from "@/lib/db/client";
import { labstackWorkerQuery } from "@/lib/db/labstack";
import { suggestGroup } from "./group-match";

export type SourceLab = {
  id: number;
  labName: string;
  city: string | null;
  isActive: boolean;
  openOrders: number;
  fulfilledOrders: number;
};

/**
 * Where a lab stands, as one value a filter can match:
 *   NOT_CONFIGURED  no OpsFlow config yet
 *   NEEDS_GROUP     configured, but nowhere it can actually send
 *   PAUSED          configured and switched off
 *   SENDING_OFF     its group exists, but sending is off for it
 *   LIVE            messages will go out
 */
export type LabSetupStatus = "NOT_CONFIGURED" | "NEEDS_GROUP" | "PAUSED" | "SENDING_OFF" | "LIVE";
export const LAB_SETUP_STATUSES: LabSetupStatus[] = ["LIVE", "SENDING_OFF", "PAUSED", "NEEDS_GROUP", "NOT_CONFIGURED"];

export type GroupOption = {
  jid: string;
  subject: string;
  sendEnabled: boolean;
  active: boolean;
  labId: number | null;
  isMember: boolean;
};

export type CatalogRow = {
  labId: number;
  labName: string;
  city: string | null;
  sourceActive: boolean;
  openOrders: number;
  fulfilledOrders: number;
  configured: boolean;
  orphaned?: boolean;
  config: NonApiLabConfig | null;
  status: LabSetupStatus;
  suggestedGroup: { jid: string; subject: string; score: number } | null;
  unknownGroup: boolean;
  groupNotMember: boolean;
};

export type CatalogSort = "fulfilled" | "open" | "name" | "id";
export type CatalogQuery = {
  q?: string;
  status?: LabSetupStatus | "CONFIGURED" | "ALL";
  type?: "NON_API" | "API" | "ALL";
  /** Labs LabStack marks inactive are hidden unless asked for — or configured. */
  includeInactive?: boolean;
  sort?: CatalogSort;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
};

export const PAGE_SIZES = [25, 50, 100] as const;

const CACHE_MS = 5 * 60_000;
let cache: { at: number; labs: SourceLab[] } | null = null;

/** LabStack's lab roster with lifetime order counts, cached for a few minutes. */
export async function loadSourceLabs(fresh = false): Promise<SourceLab[]> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.labs;
  const labs = await labstackWorkerQuery<SourceLab>(`
    SELECT l.id,
           l."labName",
           l.city,
           l.active AS "isActive",
           COUNT(o.id) FILTER (
             WHERE o."orderStatus" NOT IN ('CANCELED', 'REPORT_DELIVERED', 'PATIENT_MISSED')
           )::int AS "openOrders",
           -- Lifetime, not a window: the point is which labs carry the
           -- business, and a quiet fortnight should not bury a big one.
           COUNT(o.id) FILTER (WHERE o."orderStatus" = 'REPORT_DELIVERED')::int AS "fulfilledOrders"
      FROM public."Lab" l
      LEFT JOIN public."Order" o ON o."labId" = l.id
     GROUP BY l.id, l."labName", l.city, l.active
  `);
  cache = { at: Date.now(), labs };
  return labs;
}

function statusOf(config: NonApiLabConfig | null, group: GroupOption | undefined, unknownGroup: boolean, groupNotMember: boolean): LabSetupStatus {
  if (!config) return "NOT_CONFIGURED";
  if ((!config.waGroupJid && !config.whatsappNumber) || unknownGroup || groupNotMember) return "NEEDS_GROUP";
  if (!config.isActive) return "PAUSED";
  if (config.waGroupJid && group && !group.sendEnabled) return "SENDING_OFF";
  return "LIVE";
}

/** Join LabStack's roster with OpsFlow's config and groups. Pure. */
export function buildRows(sourceLabs: SourceLab[], configs: NonApiLabConfig[], groups: GroupOption[]): CatalogRow[] {
  const configByLabId = new Map(configs.map((config) => [config.labId, config]));
  const groupByJid = new Map(groups.map((group) => [group.jid, group]));
  const memberGroups = groups.filter((group) => group.isMember);

  type RowSource = { labId: number; labName: string; city: string | null; sourceActive: boolean; openOrders: number; fulfilledOrders: number };
  const row = (lab: RowSource, config: NonApiLabConfig | null, orphaned = false): CatalogRow => {
    const group = config?.waGroupJid ? groupByJid.get(config.waGroupJid) : undefined;
    const unknownGroup = !!config?.waGroupJid && !group;
    const groupNotMember = !!config?.waGroupJid && group?.isMember === false;
    // Only worth computing where it will be shown: labs with no group yet.
    const suggestion = !config?.waGroupJid && !orphaned ? suggestGroup(lab.labName, memberGroups) : null;
    return {
      ...lab,
      configured: !!config,
      ...(orphaned ? { orphaned: true } : {}),
      config,
      status: statusOf(config, group, unknownGroup, groupNotMember),
      suggestedGroup: suggestion
        ? { jid: suggestion.group.jid, subject: suggestion.group.subject, score: Number(suggestion.score.toFixed(2)) }
        : null,
      unknownGroup,
      groupNotMember,
    };
  };

  // LabStack names carry stray whitespace ("  Ishan Pathology"), which would
  // sort them ahead of "A…" and break search-by-prefix.
  const rows = sourceLabs.map((lab) => row({
    labId: lab.id, labName: (lab.labName ?? "").trim(), city: lab.city?.trim() || null, sourceActive: lab.isActive,
    openOrders: lab.openOrders, fulfilledOrders: lab.fulfilledOrders,
  }, configByLabId.get(lab.id) ?? null));

  // A config whose lab vanished from LabStack still drives messages, so it
  // must stay visible here.
  const sourceIds = new Set(sourceLabs.map((lab) => lab.id));
  for (const config of configs) {
    if (sourceIds.has(config.labId)) continue;
    rows.push(row({
      labId: config.labId, labName: config.labName, city: null, sourceActive: false, openOrders: 0, fulfilledOrders: 0,
    }, config, true));
  }
  return rows;
}

function matchesQuery(row: CatalogRow, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return row.labName.toLowerCase().includes(q)
    || String(row.labId) === q
    || (row.city ?? "").toLowerCase().includes(q);
}

/**
 * Search, filter, sort and page. Pure.
 *
 * `statusCounts` is taken after search/type/inactive but BEFORE the status
 * filter, so the status dropdown can say how many labs each choice would show.
 */
export function queryCatalog(rows: CatalogRow[], query: CatalogQuery) {
  const pageSize = PAGE_SIZES.includes(query.pageSize as (typeof PAGE_SIZES)[number]) ? query.pageSize! : 25;
  const sort = query.sort ?? "fulfilled";
  const dir = query.dir ?? (sort === "name" || sort === "id" ? "asc" : "desc");

  const scoped = rows.filter((row) =>
    matchesQuery(row, query.q ?? "")
    && (query.includeInactive || row.sourceActive || row.configured)
    && (!query.type || query.type === "ALL" || row.config?.integrationType === query.type));

  const statusCounts = Object.fromEntries(LAB_SETUP_STATUSES.map((status) => [status, 0])) as Record<LabSetupStatus, number>;
  for (const row of scoped) statusCounts[row.status] += 1;

  const status = query.status ?? "ALL";
  const filtered = scoped.filter((row) =>
    status === "ALL" ? true : status === "CONFIGURED" ? row.configured : row.status === status);

  const sign = dir === "asc" ? 1 : -1;
  const key = (row: CatalogRow): number | string =>
    sort === "fulfilled" ? row.fulfilledOrders
      : sort === "open" ? row.openOrders
        : sort === "id" ? row.labId
          : row.labName.toLowerCase();
  filtered.sort((a, b) => {
    const ka = key(a), kb = key(b);
    const primary = typeof ka === "number" ? (ka - (kb as number)) : String(ka).localeCompare(String(kb));
    // Ties broken by name so a page never reshuffles between requests.
    return primary * sign || a.labName.localeCompare(b.labName) || a.labId - b.labId;
  });

  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(query.page ?? 1)), pageCount);
  return {
    labs: filtered.slice((page - 1) * pageSize, page * pageSize),
    total,
    page,
    pageSize,
    pageCount,
    sort,
    dir,
    statusCounts,
    configuredCount: scoped.filter((row) => row.configured).length,
  };
}

/** The OpsFlow half: configs and the linked number's groups. Never cached. */
export async function loadOpsflowSide() {
  const [configs, groups] = await Promise.all([
    prisma.nonApiLabConfig.findMany(),
    // Archived rows belong to a previously linked number; their jids are
    // suffixed, so they can never match a config anyway.
    prisma.waGroup.findMany({
      where: { archivedAt: null },
      select: { jid: true, subject: true, sendEnabled: true, active: true, labId: true, isMember: true },
      orderBy: { subject: "asc" },
    }),
  ]);
  return { configs, groups: groups as GroupOption[] };
}
