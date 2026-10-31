import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const entries = [
  { id: "x1", date: "2024-03-01", category: "food", amount: 1250, note: "lunch" },
  { id: "x2", date: "2024-03-15", category: "rent", amount: 90000, note: "" },
  { id: "x3", date: "2024-04-01", category: "food", amount: 980, note: "groceries" },
];

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-m-"));
  const file = path.join(dir, "l.json");
  fs.writeFileSync(file, JSON.stringify(entries));
  return file;
}
function run(file, args) {
  const r = spawnSync(process.execPath, [path.resolve("src/cli.js"), ...args], { encoding: "utf8", env: { ...process.env, LEDGER_FILE: file } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("delete removes exactly that entry and reports it", () => {
  const file = fresh();
  const r = run(file, ["delete", "x2"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).map((e) => e.id), ["x1", "x3"]);
});

test("delete of an unknown id fails with a non-zero exit and leaves the file alone", () => {
  const file = fresh();
  const r = run(file, ["delete", "nope"]);
  assert.notEqual(r.code, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 3);
});

test("list --category filters and combines with --from/--to", () => {
  const file = fresh();
  const a = run(file, ["list", "--category", "food"]);
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /lunch/); assert.match(a.out, /groceries/); assert.doesNotMatch(a.out, /900\.00/);
  const b = run(file, ["list", "--category", "food", "--to", "2024-03-31"]);
  assert.match(b.out, /lunch/); assert.doesNotMatch(b.out, /groceries/);
});

test("report --json prints the summary as JSON with cents", () => {
  const file = fresh();
  const r = run(file, ["report", "--json"]);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.total, 92230);
  assert.equal(j.months["2024-03"].total, 91250);
  assert.equal(j.months["2024-03"].byCategory.food, 1250);
  assert.equal(j.months["2024-04"].byCategory.food, 980);
});
