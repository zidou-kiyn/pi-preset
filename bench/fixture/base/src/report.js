import { inRange, monthOf } from "./dates.js";

// Drops duplicate ids (the sync stub can deliver the same entry twice).
export function dedupe(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

export function filterRange(entries, from, to) {
  return entries.filter((e) => inRange(e.date, from, to));
}

// Returns { months: { "2024-03": { total, byCategory: { food: 1250 } } }, total }
export function summarize(entries) {
  const months = {};
  let total = 0;
  for (const e of entries) {
    const m = monthOf(e.date);
    months[m] ??= { total: 0, byCategory: {} };
    months[m].total += e.amount;
    months[m].byCategory[e.category] = (months[m].byCategory[e.category] ?? 0) + e.amount;
    total += e.amount;
  }
  return { months, total };
}
