// Interactive-mode benchmark over pi's RPC protocol: a scripted user answers
// ask_user_question dialogs and plain-text questions, and can send slash
// commands. Usage:
//   node bench/interactive.mjs --task ambiguous --configs pure,new --reps 2
//   node bench/interactive.mjs --task undo --configs new
// Results: bench/results/i-<task>-<config>-<rep>.json
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFixtureEnv } from "./tasks.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MODEL = "anthropic-proxy/claude-opus-5-5";
const CONFIGS = { pure: "agents/pure", old: "agents/old", new: "agents/new" };
const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : d; };
const taskId = opt("task", "ambiguous");
const configs = opt("configs", "pure,new").split(",");
const reps = Number(opt("reps", 1));

const sh = (cwd, cmd) => { const r = spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8" }); return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") }; };

// The scripted user. answer() picks an option for a select dialog, text() is what
// the user types when the agent asks in plain chat or via an input dialog.
const TASKS = {
  ambiguous: {
    prompt: "金额显示太难看了，改一下。",
    text: "在数字前面加人民币符号 ¥，放在负号后面；千分位保留；就改这一处。",
    answer(options) {
      return options.find((o) => /¥|人民币|货币|currency|symbol|符号/i.test(o)) ?? options[0];
    },
    maxTextRounds: 2,
    check(cwd) {
      const list = sh(cwd, "LEDGER_FILE=data/ledger.json node src/cli.js list").out;
      return { shows_yen: /¥/.test(list), sign_before_symbol: /-¥/.test(list), ...tests(cwd), files_changed: sh(cwd, "git status --porcelain").out.trim().split("\n").filter(Boolean) };
    },
  },
  undo: {
    prompt: "把 src/money.js 的 formatAmount 改成用 Intl.NumberFormat 实现，行为不变，跑测试。",
    text: "",
    answer: (options) => options[0],
    maxTextRounds: 0,
    after: ["/undo"],
    check(cwd) {
      return { tree_clean_after_undo: sh(cwd, "git status --porcelain").out.trim() === "", ...tests(cwd) };
    },
  },
};
function tests(cwd) {
  const { out } = sh(cwd, "npm test");
  const n = (k) => Number((out.match(new RegExp(`^ℹ ${k} (\\d+)`, "m")) ?? [])[1] ?? -1);
  return { tests: n("tests"), pass: n("pass"), fail: n("fail") };
}

function prepare(name) {
  const dir = path.join(ROOT, "work", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "fixture", "base"), dir, { recursive: true });
  writeFixtureEnv(dir);
  sh(dir, "git init -q -b main && git config user.email bench@example.com && git config user.name bench && git add -A && git commit -q -m 'initial import'");
  return dir;
}

function runSession(task, config, dir) {
  return new Promise((resolve) => {
    const child = spawn("pi", ["--mode", "rpc", "--no-session", "--model", MODEL, "--thinking", "high"], {
      cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: path.join(ROOT, CONFIGS[config]), PI_PRESET_KEEPWARM: "off" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    const log = { dialogs: [], textRounds: 0, turns: 0, toolCalls: [], texts: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } };
    const t0 = Date.now();
    let buf = "", reqId = 0, phase = "main", textRounds = 0, after = [...(task.after ?? [])], editedSinceAnswer = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
    const finish = () => { clearTimeout(timer); child.kill(); resolve({ ...log, wallMs: Date.now() - t0 }); };

    const onSettled = () => {
      const last = log.texts.at(-1) ?? "";
      const asksInText = /[?？]\s*$/m.test(last) || /(要|想|需要|希望)(怎么|哪种|什么|哪个)|which|what would you/i.test(last);
      if (phase === "main" && !editedSinceAnswer && asksInText && textRounds < task.maxTextRounds) {
        textRounds++; log.textRounds = textRounds; log.dialogs.push({ kind: "text", question: last.slice(0, 300), answer: task.text });
        send({ id: `t${++reqId}`, type: "prompt", message: task.text });
        return;
      }
      if (after.length) { phase = "after"; const cmd = after.shift(); log.dialogs.push({ kind: "command", command: cmd }); send({ id: `a${++reqId}`, type: "prompt", message: cmd }); setTimeout(() => { if (!after.length) finish(); }, 8000); return; }
      finish();
    };

    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === "extension_ui_request") {
          if (e.method === "select") {
            const options = e.options ?? [];
            const value = task.answer(options);
            log.dialogs.push({ kind: "select", title: e.title, options, answer: value });
            send({ type: "extension_ui_response", id: e.id, value });
          } else if (e.method === "confirm") {
            log.dialogs.push({ kind: "confirm", title: e.title, answer: true });
            send({ type: "extension_ui_response", id: e.id, confirmed: true });
          } else if (e.method === "input" || e.method === "editor") {
            log.dialogs.push({ kind: e.method, title: e.title, answer: task.text });
            send({ type: "extension_ui_response", id: e.id, value: task.text });
          }
        } else if (e.type === "message_end" && e.message.role === "assistant") {
          log.turns++;
          const u = e.message.usage ?? {};
          for (const k of Object.keys(log.usage)) log.usage[k] += u[k] ?? 0;
          for (const c of e.message.content ?? []) {
            if (c.type === "text" && c.text.trim()) log.texts.push(c.text);
            if (c.type === "toolCall") { log.toolCalls.push({ name: c.name, args: JSON.stringify(c.arguments).slice(0, 200) }); if (c.name === "edit" || c.name === "write") editedSinceAnswer = true; }
          }
        } else if (e.type === "agent_settled") {
          onSettled();
        } else if (e.type === "response" && e.command === "prompt" && e.data?.disposition === "handled" && phase === "after") {
          // an extension command ran synchronously (e.g. /undo); give it a moment, then finish
          setTimeout(finish, 3000);
        }
      }
    });
    child.stderr.on("data", () => {});
    child.on("close", () => finish());
    send({ id: `p${++reqId}`, type: "prompt", message: task.prompt });
  });
}

const RATES = { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 };
const task = TASKS[taskId];
fs.mkdirSync(path.join(ROOT, "results"), { recursive: true });
for (let rep = 0; rep < reps; rep++) for (const config of configs) {
  const name = `i-${taskId}-${config}-${rep}`;
  const dir = prepare(name);
  console.log(`[start] ${name}`);
  const r = await runSession(task, config, dir);
  const u = r.usage;
  const cost = (u.input * RATES.input + u.output * RATES.output + u.cacheRead * RATES.cacheRead + (u.cacheWrite - u.cacheWrite1h) * RATES.cacheWrite5m + u.cacheWrite1h * RATES.cacheWrite1h) / 1e6;
  const check = task.check(dir);
  const result = { name, task: taskId, config, rep, wallMs: r.wallMs, turns: r.turns, cost, askedViaTool: r.toolCalls.filter((c) => c.name === "ask_user_question").length, dialogs: r.dialogs, textRounds: r.textRounds, toolCalls: r.toolCalls, check, finalText: r.texts.at(-1) ?? "" };
  fs.writeFileSync(path.join(ROOT, "results", `${name}.json`), JSON.stringify(result, null, 2));
  console.log(`[done ] ${name} ${(r.wallMs / 1000).toFixed(0)}s turns=${r.turns} askTool=${result.askedViaTool} textRounds=${r.textRounds} dialogs=${r.dialogs.length} $${cost.toFixed(3)} check=${JSON.stringify(check).slice(0, 160)}`);
}
