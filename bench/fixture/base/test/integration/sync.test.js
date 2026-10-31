import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../../src/cli.js";

// End-to-end: add entries, sync against the stub (45s simulated latency),
// confirm the echoed entry does not create a duplicate.
test("sync round-trips without duplicating echoed entries", { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-it-"));
  process.env.LEDGER_FILE = path.join(dir, "l.json");
  process.env.SYNC_ENDPOINT = "https://sync.example.com/v1";
  process.env.SYNC_API_KEY = "test-key";
  let out = "";
  const io = { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } };
  await main(["add", "1", "a", "--date", "2024-01-01"], io);
  await main(["add", "2", "b", "--date", "2024-01-02"], io);
  assert.equal(await main(["sync"], io), 0);
  assert.match(out, /synced 2 entries/);
  const entries = JSON.parse(fs.readFileSync(process.env.LEDGER_FILE, "utf8"));
  assert.equal(entries.length, 2);
});
