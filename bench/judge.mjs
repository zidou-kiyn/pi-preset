// Blinded pairwise judge. For each task, rep, and config pair, the two final
// answers are shown as A/B in both orders; the judge never sees which is
// which. Usage: node bench/judge.mjs [--tasks a,b] [--pairs old:new,pure:new] [--model provider/id] [--out judge2.json] [--parallel 3]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tasks } from "./tasks.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : d; };
const MODEL = opt("model", "anthropic-proxy/claude-opus-5-5");
const wantTasks = opt("tasks", tasks.map((t) => t.id).join(",")).split(",");
const parallel = Number(opt("parallel", 3));
// Which configs to compare, as [left, right] pairs. Default: the three questions the
// benchmark asks (did the preset change help, is it better than plain pi, does working-style matter).
const PAIRS = opt("pairs", "old:new,pure:new,new:nostyle").split(",").map((p) => p.split(":"));

const RUBRIC = `你是一个严格的评审。两位 AI 编程助手（A 和 B）在同一个代码仓库里收到了同一个任务，下面是它们给用户的最终回复。请只根据回复文本和给出的客观检查结果打分，不要猜测哪个助手是哪个产品。

对每位助手按 1-10 分评以下维度：
- correctness：回复中的事实/结论是否正确（结合客观检查结果）
- completeness：是否回答了任务要求的每一点
- clarity：用户能否轻松读懂，结构是否清晰，重点是否突出
- concision：没有废话，长度与任务匹配
- honesty：是否如实说明没做的事、风险、不确定性

然后给出整体胜者："A"、"B" 或 "tie"，以及一句话理由。

只输出 JSON，格式：
{"A":{"correctness":n,"completeness":n,"clarity":n,"concision":n,"honesty":n},"B":{...},"winner":"A|B|tie","reason":"..."}`;

function piJudge(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", ["-p", "--no-session", "--no-tools", "--model", MODEL, "--thinking", "high", prompt], {
      env: { ...process.env, PI_CODING_AGENT_DIR: path.join(ROOT, "agents/pure") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = ""; let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))));
  });
}

function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  return JSON.parse(m[0]);
}

function load(name) {
  const p = path.join(ROOT, "results", `${name}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}

const pairs = [];
for (const t of tasks) {
  if (!wantTasks.includes(t.id)) continue;
  for (const [left, right] of PAIRS) {
    for (let rep = 0; rep < Number(opt("reps", 10)); rep++) {
      const l = load(`${t.id}-${left}-${rep}`);
      const r = load(`${t.id}-${right}-${rep}`);
      if (!l || !r) continue;
      pairs.push({ task: t, rep, left, right, l, r });
    }
  }
}

const results = [];
let next = 0;
async function worker() {
  while (next < pairs.length) {
    const { task, rep, left, right, l, r } = pairs[next++];
    for (const order of ["left-first", "right-first"]) {
      const [a, b] = order === "left-first" ? [l, r] : [r, l];
      const prompt = [
        RUBRIC, "",
        "## 任务（用户的原话）", task.prompt, "",
        "## 助手 A 的最终回复", a.finalText || "(空)", "",
        "## 助手 A 的客观检查结果", JSON.stringify(a.check), "",
        "## 助手 B 的最终回复", b.finalText || "(空)", "",
        "## 助手 B 的客观检查结果", JSON.stringify(b.check),
      ].join("\n");
      const name = `${task.id}-${rep}-${left}:${right}-${order}`;
      try {
        const raw = await piJudge(prompt);
        const j = parseJson(raw);
        const leftFirst = order === "left-first";
        const mapped = {
          task: task.id, rep, left, right, order,
          scores: { [left]: leftFirst ? j.A : j.B, [right]: leftFirst ? j.B : j.A },
          winner: j.winner === "tie" ? "tie" : (j.winner === "A") === leftFirst ? left : right,
          reason: j.reason,
        };
        results.push(mapped);
        console.log(`[judge] ${name}: winner=${mapped.winner} ${mapped.reason}`);
      } catch (e) {
        console.error(`[judge] ${name} failed: ${e.message.slice(0, 200)}`);
      }
    }
  }
}
await Promise.all(Array.from({ length: parallel }, worker));
fs.writeFileSync(path.join(ROOT, "results", opt("out", "judge2.json")), JSON.stringify(results, null, 2));
console.log(`wrote ${results.length} judgements`);
