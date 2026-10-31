import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function load(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  return raw.trim() ? JSON.parse(raw) : [];
}

export function save(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function makeEntry({ amount, category, note = "", date }) {
  return { id: randomUUID(), date, category, amount, note };
}
