import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupe, filterRange, summarize } from "../../src/report.js";

const entries = [
  { id: "a", date: "2024-03-01", category: "food", amount: 1250 },
  { id: "b", date: "2024-03-31", category: "food", amount: 800 },
  { id: "c", date: "2024-04-01", category: "rent", amount: 90000 },
  { id: "a", date: "2024-03-01", category: "food", amount: 1250 },
];

test("dedupe keeps the first occurrence of an id", () => {
  assert.deepEqual(dedupe(entries).map((e) => e.id), ["a", "b", "c"]);
});

test("filterRange includes entries on the end date", () => {
  const out = filterRange(dedupe(entries), "2024-03-01", "2024-03-31");
  assert.deepEqual(out.map((e) => e.id), ["a", "b"]);
});

test("summarize totals per month and category", () => {
  const { months, total } = summarize(dedupe(entries));
  assert.equal(total, 92050);
  assert.equal(months["2024-03"].total, 2050);
  assert.equal(months["2024-03"].byCategory.food, 2050);
  assert.equal(months["2024-04"].byCategory.rent, 90000);
});
