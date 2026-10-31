import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Reads KEY=VALUE lines from .env in the cwd (if present) into a plain object.
// process.env wins over the file.
export function loadConfig(cwd = process.cwd()) {
  const fromFile = {};
  const envPath = path.join(cwd, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 0) continue;
      fromFile[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  }
  const get = (k, d) => process.env[k] ?? fromFile[k] ?? d;
  return {
    file: get("LEDGER_FILE", path.join(os.homedir(), ".ledger.json")),
    syncEndpoint: get("SYNC_ENDPOINT", ""),
    syncApiKey: get("SYNC_API_KEY", ""),
  };
}
