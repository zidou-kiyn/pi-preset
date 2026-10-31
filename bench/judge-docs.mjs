import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const doc = (n) => { for (const p of ["docs/ONBOARDING.md", "ONBOARDING.md"]) { const f = path.join(ROOT, "work", n, p); if (fs.existsSync(f)) return fs.readFileSync(f, "utf8"); } return "(没有生成文档)"; };
const RUBRIC = `你是一个严格的技术文档评审。两位 AI 助手（A、B）为同一个小仓库各写了一份"新人上手文档"。任务要求：介绍项目是做什么的、代码结构和各模块职责、一条命令从输入到落盘的数据流、配置方式（含 .env 项）、新人最容易踩的坑，且要"能直接读"。
按 1-10 分评：accuracy（陈述是否准确、没有编造）、coverage（要求的每一点是否覆盖）、readability（新人能否顺畅读懂，结构、层次、示例）、concision（无冗余，长度合适）、safety（密钥处理是否得当，不泄露）。给出 winner（A|B|tie）和一句话理由。只输出 JSON：{"A":{...},"B":{...},"winner":"...","reason":"..."}`;
function judge(prompt) { return new Promise((res, rej) => { const c = spawn("pi", ["-p", "--no-session", "--no-tools", "--model", "anthropic-proxy/claude-opus-5-5", "--thinking", "high", prompt], { env: { ...process.env, PI_CODING_AGENT_DIR: path.join(ROOT, "agents/pure") }, stdio: ["ignore", "pipe", "pipe"] }); let o = ""; c.stdout.on("data", (d) => (o += d)); c.on("close", () => res(o)); }); }
const out = [];
await Promise.all([0, 1].flatMap((rep) => ["pure-first", "preset-first"].map(async (order) => {
  const [a, b] = order === "pure-first" ? [`explore-pure-${rep}`, `explore-preset-${rep}`] : [`explore-preset-${rep}`, `explore-pure-${rep}`];
  const raw = await judge([RUBRIC, "", "## 文档 A", doc(a), "", "## 文档 B", doc(b)].join("\n"));
  const j = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
  const pure = order === "pure-first" ? j.A : j.B, preset = order === "pure-first" ? j.B : j.A;
  const winner = j.winner === "tie" ? "tie" : (j.winner === "A") === (order === "pure-first") ? "pure" : "preset";
  out.push({ rep, order, pure, preset, winner, reason: j.reason });
  console.log(`[doc-judge] rep${rep} ${order}: ${winner} — ${j.reason}`);
})));
fs.writeFileSync(path.join(ROOT, "results", "judge-docs.json"), JSON.stringify(out, null, 2));
for (const d of ["accuracy", "coverage", "readability", "concision", "safety"]) console.log(d, "pure", (out.reduce((s, o) => s + o.pure[d], 0) / out.length).toFixed(1), "preset", (out.reduce((s, o) => s + o.preset[d], 0) / out.length).toFixed(1));
for (const n of ["explore-pure-0","explore-pure-1","explore-preset-0","explore-preset-1"]) console.log(n, "doc chars", doc(n).length);
