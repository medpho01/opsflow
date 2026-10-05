import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { NonApiLabConfig } from "@prisma/client";
import { buildRows, queryCatalog, type GroupOption, type SourceLab } from "../lab-catalog";

const lab = (id: number, labName: string, fulfilledOrders: number, extra: Partial<SourceLab> = {}): SourceLab => ({
  id, labName, city: "Pune", isActive: true, openOrders: 0, fulfilledOrders, ...extra,
});
const config = (labId: number, extra: Partial<NonApiLabConfig> = {}) =>
  ({ labId, labName: `Lab ${labId}`, integrationType: "NON_API", waGroupJid: `g${labId}@g.us`, whatsappNumber: null, isActive: true, ...extra }) as NonApiLabConfig;
const group = (jid: string, extra: Partial<GroupOption> = {}): GroupOption =>
  ({ jid, subject: jid, sendEnabled: true, active: true, labId: null, isMember: true, ...extra });

const source = [
  lab(1, "Alpha Labs", 900),
  lab(2, "Beta Diagnostics", 50, { openOrders: 40 }),
  lab(3, "Gamma Path", 5000),
  lab(4, "Delta Care", 10, { isActive: false }),
  lab(5, "Epsilon", 300),
];
const rows = buildRows(
  source,
  [config(1), config(2, { isActive: false }), config(3), config(5, { waGroupJid: null })],
  [group("g1@g.us"), group("g2@g.us"), group("g3@g.us", { sendEnabled: false })],
);
const ids = (result: ReturnType<typeof queryCatalog>) => result.labs.map((row) => row.labId);

describe("lab catalogue", () => {
  it("sorts by lifetime orders fulfilled, busiest first, by default", () => {
    assert.deepEqual(ids(queryCatalog(rows, {})), [3, 1, 5, 2]);
  });

  it("hides labs inactive in LabStack unless asked, but never a configured one", () => {
    assert.ok(!ids(queryCatalog(rows, {})).includes(4));
    assert.ok(ids(queryCatalog(rows, { includeInactive: true })).includes(4));
  });

  it("derives one setup status per lab", () => {
    const status = Object.fromEntries(rows.map((row) => [row.labId, row.status]));
    assert.deepEqual(status, { 1: "LIVE", 2: "PAUSED", 3: "SENDING_OFF", 4: "NOT_CONFIGURED", 5: "NEEDS_GROUP" });
  });

  it("filters by status and counts every status before that filter", () => {
    const result = queryCatalog(rows, { status: "LIVE" });
    assert.deepEqual(ids(result), [1]);
    assert.equal(result.statusCounts.PAUSED, 1);
    assert.equal(result.statusCounts.NOT_CONFIGURED, 0);
  });

  it("searches by name, city or exact lab id", () => {
    assert.deepEqual(ids(queryCatalog(rows, { q: "beta" })), [2]);
    assert.deepEqual(ids(queryCatalog(rows, { q: "3" })), [3]);
  });

  it("sorts by open orders and by name", () => {
    assert.equal(ids(queryCatalog(rows, { sort: "open" }))[0], 2);
    assert.deepEqual(ids(queryCatalog(rows, { sort: "name" })), [1, 2, 5, 3]);
  });

  it("pages, and clamps a page past the end to the last page", () => {
    const many = buildRows(Array.from({ length: 60 }, (_, i) => lab(i + 1, `Lab ${i + 1}`, 60 - i)), [], []);
    const second = queryCatalog(many, { page: 2, pageSize: 25 });
    assert.equal(second.labs.length, 25);
    assert.equal(second.labs[0].labId, 26);
    assert.equal(second.pageCount, 3);
    assert.equal(queryCatalog(many, { page: 99, pageSize: 25 }).page, 3);
  });

  it("refuses an arbitrary page size", () => {
    assert.equal(queryCatalog(rows, { pageSize: 5000 }).pageSize, 25);
  });

  it("ignores stray whitespace in LabStack names when sorting", () => {
    const messy = buildRows([lab(1, "  Zeta", 1), lab(2, "Alpha", 1)], [], []);
    assert.deepEqual(ids(queryCatalog(messy, { sort: "name" })), [2, 1]);
  });

  it("keeps a config whose lab vanished from LabStack", () => {
    const orphanRows = buildRows([], [config(77)], []);
    assert.equal(orphanRows[0].orphaned, true);
  });
});
