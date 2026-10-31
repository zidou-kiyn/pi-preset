import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const entries = [
  { id: "x1", date: "2024-03-01", category: "food", amount: 1250, note: "lunch" },
  { id: "x2", date: "2024-03-15", category: "misc", amount: -200000, note: 'said "hi", twice' },
  { id: "x3", date: "2024-03-31", category: "rent", amount: 90000, note: "" },
  { id: "x4", date: "2024-04-01", category: "food", amount: 5, note: "gum" },
  { id: "x2", date: "2024-03-15", category: "misc", amount: -200000, note: 'said "hi", twice' },
];

function run(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-h-"));
  const file = path.join(dir, "l.json");
  fs.writeFileSync(file, JSON.stringify(entries));
  const r = spawnSync(process.execPath, [path.resolve("src/cli.js"), ...args], {
    encoding: "utf8", env: { ...process.env, LEDGER_FILE: file },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("export defaults to json with deduped entries", () => {
  const r = run(["export"]);
  assert.equal(r.code, 0, r.err);
  const parsed = JSON.parse(r.out);
  assert.deepEqual(parsed.map((e) => e.id), ["x1", "x2", "x3", "x4"]);
  assert.deepEqual(parsed[0], entries[0]);
});

test("export json honours an inclusive --from/--to", () => {
  const r = run(["export", "--format", "json", "--from", "2024-03-15", "--to", "2024-03-31"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out).map((e) => e.id), ["x2", "x3"]);
});

test("export csv has the header, two-decimal amounts and RFC 4180 quoting", () => {
  const r = run(["export", "--format", "csv", "--to", "2024-03-31"]);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.replace(/\r\n/g, "\n").trimEnd().split("\n");
  assert.equal(lines[0], "id,date,category,amount,note");
  assert.equal(lines[1], "x1,2024-03-01,food,12.50,lunch");
  assert.equal(lines[2], 'x2,2024-03-15,misc,-2000.00,"said ""hi"", twice"');
  assert.equal(lines[3], "x3,2024-03-31,rent,900.00,");
  assert.equal(lines.length, 4);
});

test("export rejects an unknown format", () => {
  const r = run(["export", "--format", "xml"]);
  assert.notEqual(r.code, 0);
});
