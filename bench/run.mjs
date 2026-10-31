// Usage: node bench/run.mjs [--tasks a,b] [--configs pure,old,new,nostyle] [--reps 1] [--rep-offset 0] [--parallel 2]
// Runs each task under each config in a fresh copy of the fixture and writes
// bench/results/<task>-<config>-<rep>.{jsonl,json,err}. Run bench/setup.mjs first.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tasks, writeFixtureEnv } from "./tasks.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MODEL = "anthropic-proxy/claude-opus-5-5";
const THINKING = "high";
const RUN_TIMEOUT_MS = 20 * 60_000;

const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : d; };
const wantTasks = opt("tasks", tasks.map((t) => t.id).join(",")).split(",");
const configs = opt("configs", "pure,old,new,nostyle").split(",");
// config -> agent dir + extra env. "old" is the installed pi-preset 0.3.0, "new" the repo checkout.
const CONFIGS = {
  pure: { dir: "agents/pure", env: {} },
  old: { dir: "agents/old", env: {} },
  new: { dir: "agents/new", env: {} },
  nostyle: { dir: "agents/new", env: { PI_PRESET_WORKING_STYLE: "off" } },
};
for (const c of configs) {
  if (!CONFIGS[c]) throw new Error(`unknown config ${c}`);
  if (!fs.existsSync(path.join(ROOT, CONFIGS[c].dir, "settings.json"))) throw new Error(`${CONFIGS[c].dir} missing: run node bench/setup.mjs`);
}
// Official Anthropic rates for claude-opus-5-5 (USD / MTok), platform.claude.com/docs/en/about-claude/pricing
const RATES = { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 };
function officialCost(u) {
  const w1h = u.cacheWrite1h ?? 0;
  return (u.input * RATES.input + u.output * RATES.output + u.cacheRead * RATES.cacheRead + (u.cacheWrite - w1h) * RATES.cacheWrite5m + w1h * RATES.cacheWrite1h) / 1e6;
}
const reps = Number(opt("reps", 1));
const repOffset = Number(opt("rep-offset", 0));
const parallel = Number(opt("parallel", 2));

function sh(cwd, cmd) {
  const r = spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stdout}${r.stderr}`);
  return r.stdout;
}

function prepareWorkspace(task, name) {
  const dir = path.join(ROOT, "work", name);
  fs.rmSync(dir, { recursive: true, force: true });
  const fixture = task.fixture === "jinja" ? path.join(ROOT, ".cache", "jinja") : path.join(ROOT, "fixture", "base");
  if (!fs.existsSync(fixture)) throw new Error(`${fixture} missing: run node bench/setup.mjs`);
  fs.cpSync(fixture, dir, { recursive: true });
  if (task.fixture !== "jinja") writeFixtureEnv(dir);
  if (task.fixture === "jinja") sh(dir, "uv venv -q .venv && uv pip install -q --python .venv/bin/python -e . pytest markupsafe trio && printf '.venv/\n' >> .gitignore");
  sh(dir, "git init -q -b main && git config user.email bench@example.com && git config user.name bench && git add -A && git commit -q -m 'initial import'");
  if (task.overlay) fs.cpSync(path.join(ROOT, "fixture", "overlays", task.overlay), dir, { recursive: true });
  if (task.mutate) task.mutate(dir);
  if (task.commitOverlay) sh(dir, "git add -A && git commit -q -m 'wip'");
  return dir;
}

function parseEvents(jsonl) {
  const events = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: 0, reasoning: 0 };
  const assistantTexts = [];
  const toolCalls = [];
  const toolResults = [];
  let turns = 0;
  let errors = 0;
  let lastAssistant = null;
  for (const e of events) {
    if (e.type === "message_end" && e.message.role === "assistant") {
      turns++;
      const m = e.message;
      lastAssistant = m;
      const u = m.usage ?? {};
      usage.input += u.input ?? 0; usage.output += u.output ?? 0;
      usage.cacheRead += u.cacheRead ?? 0; usage.cacheWrite += u.cacheWrite ?? 0; usage.cacheWrite1h += u.cacheWrite1h ?? 0;
      usage.cost += officialCost({ input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, cacheWrite1h: u.cacheWrite1h ?? 0 });
      usage.reasoning += u.reasoning ?? 0;
      if (m.stopReason === "error") errors++;
      for (const c of m.content ?? []) {
        if (c.type === "text" && c.text.trim()) assistantTexts.push(c.text);
        if (c.type === "toolCall") toolCalls.push({ name: c.name, args: c.arguments });
      }
    }
    if (e.type === "tool_execution_end") {
      const text = (e.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      toolResults.push({ name: e.toolName, isError: e.isError, text, durationMs: e.durationMs });
    }
  }
  const finalText = (lastAssistant?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
  const byTool = {};
  for (const c of toolCalls) byTool[c.name] = (byTool[c.name] ?? 0) + 1;
  return {
    turns, errors, usage, toolCalls, byTool,
    toolErrors: toolResults.filter((r) => r.isError).length,
    toolResultsText: toolResults.map((r) => r.text).join("\n"),
    assistantTexts, finalText,
    firstTurnPromptTokens: (events.find((e) => e.type === "message_end" && e.message.role === "assistant")?.message.usage ?? {}),
  };
}

function runPi(task, config, dir, name) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(path.join(ROOT, "results", `${name}.jsonl`));
    const err = fs.createWriteStream(path.join(ROOT, "results", `${name}.err`));
    const t0 = Date.now();
    const child = spawn("pi", ["--mode", "json", "--no-session", "--model", MODEL, "--thinking", THINKING, "-p", task.prompt], {
      cwd: dir,
      env: { ...process.env, PI_CODING_AGENT_DIR: path.join(ROOT, CONFIGS[config].dir), PI_PRESET_KEEPWARM: "off", ...CONFIGS[config].env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; out.write(d); });
    child.stderr.on("data", (d) => err.write(d));
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, RUN_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      out.end(); err.end();
      resolve({ exitCode: code, wallMs: Date.now() - t0, jsonl: buf });
    });
  });
}

async function runOne(task, config, rep) {
  const name = `${task.id}-${config}-${rep}`;
  const dir = prepareWorkspace(task, name);
  console.log(`[start] ${name}`);
  const r = await runPi(task, config, dir, name);
  const parsed = parseEvents(r.jsonl);
  let check = {};
  try { check = task.check(dir, parsed) ?? {}; } catch (e) { check = { check_error: String(e) }; }
  const result = {
    name, task: task.id, config, rep, model: MODEL, thinking: THINKING,
    exitCode: r.exitCode, wallMs: r.wallMs,
    turns: parsed.turns, errors: parsed.errors, toolErrors: parsed.toolErrors,
    toolCallCount: parsed.toolCalls.length, byTool: parsed.byTool,
    usage: parsed.usage, firstTurnUsage: parsed.firstTurnPromptTokens,
    check, finalText: parsed.finalText, assistantTexts: parsed.assistantTexts,
    toolCalls: parsed.toolCalls.map((c) => ({ name: c.name, args: JSON.stringify(c.args).slice(0, 300) })),
  };
  fs.writeFileSync(path.join(ROOT, "results", `${name}.json`), JSON.stringify(result, null, 2));
  console.log(`[done ] ${name}  ${(r.wallMs / 1000).toFixed(0)}s  turns=${parsed.turns} tools=${parsed.toolCalls.length} cost=$${parsed.usage.cost.toFixed(3)} check=${JSON.stringify(check).slice(0, 200)}`);
  return result;
}

const jobs = [];
for (const t of tasks) {
  if (!wantTasks.includes(t.id)) continue;
  for (let rep = repOffset; rep < repOffset + reps; rep++) for (const c of configs) jobs.push([t, c, rep]);
}
fs.mkdirSync(path.join(ROOT, "results"), { recursive: true });
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const [t, c, rep] = jobs[next++];
    try { await runOne(t, c, rep); } catch (e) { console.error(`[fail ] ${t.id}-${c}-${rep}: ${e}`); }
  }
}
await Promise.all(Array.from({ length: parallel }, worker));
console.log("all done");
