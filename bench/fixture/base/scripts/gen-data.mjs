// node scripts/gen-data.mjs <out.json> <count>
import fs from "node:fs";
import path from "node:path";

const [out, countText] = process.argv.slice(2);
const count = Number(countText ?? 1000);
const cats = ["food", "rent", "transport", "fun", "salary", "misc"];
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const entries = [];
for (let i = 0; i < count; i++) {
  const month = 1 + Math.floor(rnd() * 12);
  const day = 1 + Math.floor(rnd() * 28);
  entries.push({
    id: `e${i}`,
    date: `2024-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    category: cats[Math.floor(rnd() * cats.length)],
    amount: Math.floor(rnd() * 20000) - 2000,
    note: "",
  });
}
// a few duplicates, like the sync stub produces
for (let i = 0; i < Math.min(50, count); i++) entries.push(entries[i * 7 % count]);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(entries));
console.log(`wrote ${entries.length} entries to ${out}`);
