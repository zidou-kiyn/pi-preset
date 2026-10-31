import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmount, formatAmount } from "../../src/money.js";

test("parseAmount handles plain, decimal and grouped input", () => {
  assert.equal(parseAmount("12"), 1200);
  assert.equal(parseAmount("12.5"), 1250);
  assert.equal(parseAmount("1,234.50"), 123450);
  assert.equal(parseAmount("-3"), -300);
});

test("parseAmount does not lose cents to float error", () => {
  assert.equal(parseAmount("0.29"), 29);
  assert.equal(parseAmount("1.13"), 113);
  assert.equal(parseAmount("4.35"), 435);
});

test("parseAmount rejects garbage", () => {
  assert.throws(() => parseAmount("abc"));
  assert.throws(() => parseAmount("1.234"));
});

test("formatAmount groups thousands and keeps the sign on small values", () => {
  assert.equal(formatAmount(123450), "1,234.50");
  assert.equal(formatAmount(-50), "-0.50");
  assert.equal(formatAmount(0), "0.00");
  assert.equal(formatAmount(-123400), "-1,234.00");
});
