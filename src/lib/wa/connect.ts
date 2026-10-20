/**
 * Connecting a WhatsApp group to a lab or a store — the one place it happens.
 *
 * Before, the same link lived twice: WhatsApp Settings (group role, a lab/store
 * id typed in, "Active") and Lab Config (the lab's group). They could disagree.
 * Now both screens call connectGroup, which sets everything at once:
 *
 *   LAB    group: provider role, mapped to the lab, read by the console.
 *          lab:   provider-communication config created (or pointed at this
 *                 group) and switched on — name and order channel from
 *                 LabStack; standard messages, coordinator and timing need
 *                 nothing more (provider-rules/standard-set.ts).
 *   STORE  group: customer role, mapped to the store, read by the console.
 *   INTERNAL  LabStack's own team group: read by the console, no lab or store.
 *   NONE   group: ignored, not read; any lab using it lets go of it.
 *
 * One group belongs to one lab or store; one lab has one group. Connecting
 * moves the link, it never leaves two.
 */
import type { Prisma } from "@prisma/client";
import prisma from "@/lib/db/client";
import { labstackWorkerQuery } from "@/lib/db/labstack";
import { labstackIntegration } from "@/lib/non-api-labs/lab-catalog";

export type ConnectTarget = { kind: "LAB"; labId: number } | { kind: "STORE"; storeId: number } | { kind: "INTERNAL" } | { kind: "NONE" };

type LabRow = { labName: string; isApiHomeSample: boolean | null; isApiCenterVisit: boolean | null; isApiPpmc: boolean | null };

export async function connectGroup(groupId: string, target: ConnectTarget, userId: number | null) {
  const group = await prisma.waGroup.findUniqueOrThrow({ where: { id: groupId } });

  // LabStack's view of the lab, read before the transaction (it is another database).
  let lab: LabRow | null = null;
  if (target.kind === "LAB") {
    [lab] = await labstackWorkerQuery<LabRow>(
      `SELECT "labName", "isApiHomeSample", "isApiCenterVisit", "isApiPpmc" FROM public."Lab" WHERE id = $1`, [target.labId],
    ).catch(() => []);
  }

  return prisma.$transaction(async (tx) => {
    // Whatever this group was linked to before lets go of it.
    await tx.nonApiLabConfig.updateMany({
      where: { waGroupJid: group.jid, ...(target.kind === "LAB" ? { labId: { not: target.labId } } : {}) },
      data: { waGroupJid: null, updatedById: userId },
    });

    if (target.kind === "LAB") {
      const existing = await tx.nonApiLabConfig.findUnique({ where: { labId: target.labId } });
      // The lab's previous group (if any) is no longer its group.
      if (existing?.waGroupJid && existing.waGroupJid !== group.jid) {
        await tx.waGroup.updateMany({ where: { jid: existing.waGroupJid, labId: target.labId }, data: { labId: null } });
      }
      const labName = (lab?.labName ?? existing?.labName ?? group.subject).trim();
      const config = existing
        ? await tx.nonApiLabConfig.update({
            where: { labId: target.labId },
            data: { waGroupJid: group.jid, isActive: true, updatedById: userId },
          })
        : await tx.nonApiLabConfig.create({
            data: {
              labId: target.labId, labName, waGroupJid: group.jid, isActive: true,
              integrationType: lab ? labstackIntegration(lab) : "NON_API",
              createdById: userId, updatedById: userId,
            } as Prisma.NonApiLabConfigUncheckedCreateInput,
          });
      const updated = await tx.waGroup.update({
        where: { id: group.id },
        data: { role: "PROVIDER", labId: target.labId, storeId: null, active: true },
      });
      return { group: updated, labConfig: config };
    }

    if (target.kind === "STORE") {
      const updated = await tx.waGroup.update({
        where: { id: group.id },
        data: { role: "SUPPORT", storeId: target.storeId, labId: null, active: true },
      });
      return { group: updated, labConfig: null };
    }

    if (target.kind === "INTERNAL") {
      const updated = await tx.waGroup.update({
        where: { id: group.id },
        data: { role: "INTERNAL", storeId: null, labId: null, active: true },
      });
      return { group: updated, labConfig: null };
    }

    const updated = await tx.waGroup.update({
      where: { id: group.id },
      data: { role: "IGNORE", storeId: null, labId: null, active: false },
    });
    return { group: updated, labConfig: null };
  });
}

/** After Lab Config saves a lab with a group: the group side follows (same rules as connectGroup). */
export async function syncLabGroup(labId: number, waGroupJid: string | null, isActive: boolean) {
  if (!waGroupJid) {
    await prisma.waGroup.updateMany({ where: { labId }, data: { labId: null } });
    return;
  }
  await prisma.$transaction([
    prisma.nonApiLabConfig.updateMany({ where: { waGroupJid, labId: { not: labId } }, data: { waGroupJid: null } }),
    prisma.waGroup.updateMany({ where: { labId, jid: { not: waGroupJid } }, data: { labId: null } }),
    prisma.waGroup.updateMany({
      where: { jid: waGroupJid },
      data: { role: "PROVIDER", labId, storeId: null, ...(isActive ? { active: true } : {}) },
    }),
  ]);
}

/**
 * One-time, on deploy: bring links made before Connect existed into one.
 * Conservative — it never starts messaging anyone:
 *   - a lab configured with a group (Lab Config): that group becomes the lab's
 *     provider group and is read; the lab's messages are unchanged;
 *   - a group mapped to a lab only in WhatsApp Settings: the lab gets a config
 *     pointing at it with messages OFF (switch on in Lab Config);
 *   - a lab pointing at a group mapped to a STORE: left as is, reported;
 *   - two labs on one group: the most recently edited keeps it, reported.
 */
export async function alignExistingConnections(now = new Date()) {
  const settings = await prisma.providerCommsSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
  if (settings.connectionsAlignedAt) return null;
  const report = { aligned: 0, createdPaused: 0, storeConflicts: [] as string[], duplicates: [] as string[] };

  const configs = await prisma.nonApiLabConfig.findMany({ where: { waGroupJid: { not: null } }, orderBy: { updatedAt: "desc" } });
  const claimed = new Set<string>();
  for (const config of configs) {
    const jid = config.waGroupJid!;
    if (claimed.has(jid)) {
      await prisma.nonApiLabConfig.update({ where: { labId: config.labId }, data: { waGroupJid: null } });
      report.duplicates.push(`${config.labName} (#${config.labId}) let go of a group another lab uses`);
      continue;
    }
    claimed.add(jid);
    const group = await prisma.waGroup.findUnique({ where: { jid } });
    if (!group) continue;
    if (group.role === "SUPPORT" && group.storeId != null) {
      report.storeConflicts.push(`${config.labName} (#${config.labId}) → "${group.subject}" is store #${group.storeId}'s group`);
      continue;
    }
    await prisma.waGroup.update({
      where: { id: group.id },
      data: { role: "PROVIDER", labId: config.labId, storeId: null, ...(config.isActive ? { active: true } : {}) },
    });
    report.aligned += 1;
  }

  // Mapped to a lab only in WhatsApp Settings: the lab gets a (paused) config.
  const configured = new Set((await prisma.nonApiLabConfig.findMany({ select: { labId: true } })).map((c) => c.labId));
  const providerGroups = await prisma.waGroup.findMany({
    where: { role: "PROVIDER", labId: { not: null }, archivedAt: null, jid: { notIn: [...claimed] } },
    orderBy: { updatedAt: "desc" },
  });
  for (const group of providerGroups) {
    if (configured.has(group.labId!)) continue;
    const [lab] = await labstackWorkerQuery<LabRow>(
      `SELECT "labName", "isApiHomeSample", "isApiCenterVisit", "isApiPpmc" FROM public."Lab" WHERE id = $1`, [group.labId],
    ).catch(() => []);
    await prisma.nonApiLabConfig.create({
      data: {
        labId: group.labId!, labName: (lab?.labName ?? group.subject).trim(), waGroupJid: group.jid, isActive: false,
        integrationType: lab ? labstackIntegration(lab) : "NON_API",
      } as Prisma.NonApiLabConfigUncheckedCreateInput,
    });
    configured.add(group.labId!);
    report.createdPaused += 1;
  }

  await prisma.providerCommsSettings.update({ where: { id: "default" }, data: { connectionsAlignedAt: now } });
  console.log(`[Connect] Existing group links aligned: ${JSON.stringify(report)}`);
  return report;
}
