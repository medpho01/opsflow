import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expandItemNumbers, splitBatchReply } from "../batching";

const items = [1, 2, 3, 4, 5].map((n) => ({ n, orderId: 88700 + n }));
const read = (text: string) => Object.fromEntries(splitBatchReply(text, items));
const ok = (...ns: number[]) => Object.fromEntries(ns.map((n) => [n, "ok"]));

describe("reading a reply to a combined message", () => {
  it("ranges: '1-4', '1–4', '1 to 4', '1 se 4 (tak)'", () => {
    assert.deepEqual(read("1-4 ok"), ok(1, 2, 3, 4));
    assert.deepEqual(read("1–4 ok"), ok(1, 2, 3, 4));
    assert.deepEqual(read("1—4 ok"), ok(1, 2, 3, 4));
    assert.deepEqual(read("1 - 4 ok"), ok(1, 2, 3, 4));
    assert.deepEqual(read("1 to 4 ok"), ok(1, 2, 3, 4));
    assert.deepEqual(read("1 se 4 ok"), ok(1, 2, 3, 4));
    assert.deepEqual(read("1 se 4 tak ho jayega"), { 1: "ho jayega", 2: "ho jayega", 3: "ho jayega", 4: "ho jayega" });
  });
  it("'1 to 4 ok' is no longer item 1 saying 'to 4 ok'", () => {
    assert.notDeepEqual(read("1 to 4 ok"), { 1: "to 4 ok" });
    assert.equal(read("1 to 4 ok")[1], "ok");
  });
  it("mixed forms: '1-3, 5 ok', '1-2 & 4 done'", () => {
    assert.deepEqual(read("1-3, 5 ok"), ok(1, 2, 3, 5));
    assert.deepEqual(read("1-2 & 4 done"), { 1: "done", 2: "done", 4: "done" });
    assert.deepEqual(read("1-2 done, 3 not home"), { 1: "done", 2: "done", 3: "not home" });
  });
  it("existing forms: '1 & 2', '1 and 2', '1/2', whitespace lists, bare numbers then text", () => {
    assert.deepEqual(read("1 & 2 collected"), { 1: "collected", 2: "collected" });
    assert.deepEqual(read("1 and 2 collected"), { 1: "collected", 2: "collected" });
    assert.deepEqual(read("1/2 collected"), { 1: "collected", 2: "collected" });
    assert.deepEqual(read("1 2 collected"), { 1: "collected", 2: "collected" });
    assert.deepEqual(read("1, 2 collected"), { 1: "collected", 2: "collected" });
    assert.deepEqual(read("1 done, 2 not home, 3 at 5 pm"), { 1: "done", 2: "not home", 3: "at 5 pm" });
    assert.deepEqual(read("1) collected\n2) stuck in traffic"), { 1: "collected", 2: "stuck in traffic" });
    assert.deepEqual(read("#3: at 5 pm"), { 3: "at 5 pm" });
  });
  it("'all', 'sab', 'sabhi'", () => {
    assert.deepEqual(read("all done"), { 1: "done", 2: "done", 3: "done", 4: "done", 5: "done" });
    assert.deepEqual(read("sab ho jayega"), Object.fromEntries(items.map((i) => [i.n, "ho jayega"])));
    assert.deepEqual(read("sabhi collected"), Object.fromEntries(items.map((i) => [i.n, "collected"])));
  });
  it("order ids, one-item messages, and never guessing", () => {
    assert.deepEqual(read("88702 patient not available"), { 2: "patient not available" });
    assert.deepEqual(Object.fromEntries(splitBatchReply("collected", [{ n: 1, orderId: 5 }])), { 1: "collected" });
    assert.deepEqual(read("ok"), {});
    assert.deepEqual(read("6 done"), {});
    assert.deepEqual(read("6-9 done"), {});
  });
  it("a time after a number is not a second item", () => {
    assert.deepEqual(read("2-3 pm reaching"), { 2: "3 pm reaching" });
    assert.deepEqual(read("1 by 4 pm"), { 1: "by 4 pm" });
  });
  it("expands and clips ranges to the items in the message", () => {
    const numbers = new Set([1, 2, 3, 4, 5]);
    assert.deepEqual(expandItemNumbers("1-3", numbers), [1, 2, 3]);
    assert.deepEqual(expandItemNumbers("2 to 9", numbers), [2, 3, 4, 5]);
    assert.deepEqual(expandItemNumbers("4-1", numbers), [4, 1]);
    assert.deepEqual(expandItemNumbers("1 & 1", numbers), [1]);
  });
});
