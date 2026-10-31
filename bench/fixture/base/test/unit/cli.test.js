import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../../src/cli.js";

function capture() {
  let out = ""; let err = "";
  return {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    out: () => out, err: () => err,
  };
}

test("add then list and report round-trip", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  process.env.LEDGER_FILE = path.join(dir, "l.json");
  const c = capture();
  assert.equal(await main(["add", "12.50", "food", "lunch", "--date", "2024-03-02"], c), 0);
  assert.equal(await main(["add", "-2000", "salary", "--date", "2024-03-25"], c), 0);
  assert.equal(await main(["list", "--from", "2024-03-01", "--to", "2024-03-31"], c), 0);
  assert.match(c.out(), /2024-03-02\s+12\.50\s+food\s+lunch/);
  assert.match(c.out(), /-2,000\.00/);
  assert.equal(await main(["report"], c), 0);
  assert.match(c.out(), /total\s+-1,987\.50/);
});

test("rejects a malformed --date", async () => {
  const c = capture();
  assert.equal(await main(["list", "--from", "03/01/2024"], c), 2);
  assert.match(c.err(), /--from must be YYYY-MM-DD/);
});
