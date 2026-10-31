import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidDate, inRange, monthOf } from "../../src/dates.js";

test("isValidDate accepts real dates only", () => {
  assert.equal(isValidDate("2024-02-29"), true);
  assert.equal(isValidDate("2023-02-29"), false);
  assert.equal(isValidDate("2024-13-01"), false);
  assert.equal(isValidDate("24-01-01"), false);
});

test("inRange is inclusive on both ends", () => {
  assert.equal(inRange("2024-03-01", "2024-03-01", "2024-03-31"), true);
  assert.equal(inRange("2024-03-31", "2024-03-01", "2024-03-31"), true);
  assert.equal(inRange("2024-04-01", "2024-03-01", "2024-03-31"), false);
  assert.equal(inRange("2024-02-29", "2024-03-01", undefined), false);
  assert.equal(inRange("2024-02-29", undefined, undefined), true);
});

test("monthOf", () => {
  assert.equal(monthOf("2024-03-15"), "2024-03");
});
