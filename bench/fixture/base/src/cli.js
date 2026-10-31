#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { parseAmount, formatAmount } from "./money.js";
import { isValidDate, today } from "./dates.js";
import { load, save, makeEntry } from "./store.js";
import { dedupe, filterRange, summarize } from "./report.js";
import { push } from "./sync.js";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[k] = next; i++; }
      else flags[k] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function usage() {
  return [
    "usage:",
    "  ledger add <amount> <category> [note] [--date YYYY-MM-DD]",
    "  ledger list [--from YYYY-MM-DD] [--to YYYY-MM-DD]",
    "  ledger report [--from YYYY-MM-DD] [--to YYYY-MM-DD]",
    "  ledger sync",
  ].join("\n");
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const cfg = loadConfig();
  const { positional, flags } = parseArgs(argv);
  const [cmd, ...rest] = positional;
  for (const k of ["from", "to", "date"]) {
    if (flags[k] !== undefined && !isValidDate(flags[k])) {
      stderr.write(`--${k} must be YYYY-MM-DD\n`);
      return 2;
    }
  }

  switch (cmd) {
    case "add": {
      const [amountText, category, note] = rest;
      if (!amountText || !category) { stderr.write(usage() + "\n"); return 2; }
      const entries = load(cfg.file);
      const entry = makeEntry({
        amount: parseAmount(amountText),
        category,
        note,
        date: flags.date ?? today(),
      });
      entries.push(entry);
      save(cfg.file, entries);
      stdout.write(`added ${entry.id}\n`);
      return 0;
    }
    case "list": {
      const entries = filterRange(dedupe(load(cfg.file)), flags.from, flags.to);
      for (const e of entries) {
        stdout.write(`${e.date}  ${formatAmount(e.amount).padStart(12)}  ${e.category.padEnd(12)} ${e.note ?? ""}\n`);
      }
      return 0;
    }
    case "report": {
      const entries = filterRange(dedupe(load(cfg.file)), flags.from, flags.to);
      const { months, total } = summarize(entries);
      for (const m of Object.keys(months).sort()) {
        stdout.write(`${m}  ${formatAmount(months[m].total).padStart(12)}\n`);
        for (const [cat, amt] of Object.entries(months[m].byCategory).sort()) {
          stdout.write(`         ${formatAmount(amt).padStart(12)}  ${cat}\n`);
        }
      }
      stdout.write(`total    ${formatAmount(total).padStart(12)}\n`);
      return 0;
    }
    case "sync": {
      const entries = dedupe(load(cfg.file));
      const res = await push(entries, { endpoint: cfg.syncEndpoint, apiKey: cfg.syncApiKey });
      save(cfg.file, dedupe([...entries, ...res.echoed]));
      stdout.write(`synced ${res.accepted} entries\n`);
      return 0;
    }
    default:
      stderr.write(usage() + "\n");
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  });
}
