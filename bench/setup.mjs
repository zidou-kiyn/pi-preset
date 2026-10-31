// One-time setup for the benchmark: isolated pi agent directories built from the
// user's own ~/.pi/agent (credentials and models only), and the pinned Jinja
// checkout. Everything lands under bench/agents and bench/.cache (gitignored).
//
//   node bench/setup.mjs            # all configs
//   node bench/setup.mjs --no-jinja # skip the Jinja clone
//
// Configs (see run.mjs CONFIGS):
//   pure  plain pi, no packages
//   old   the preset as installed in ~/.pi/agent (git:github.com/... package)
//   new   this checkout, loaded as a local package
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BENCH = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(BENCH, "..");
const AGENT = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const PRESET_SOURCE = "git:github.com/zidou-kiyn/pi-preset";
const JINJA_REPO = "https://github.com/pallets/jinja.git";
export const JINJA_COMMIT = "5ef70112a1ff19c05324ff889dd30405b1002044"; // main, 2026-10-31

const base = {
  defaultProvider: "anthropic-proxy",
  defaultModel: "claude-opus-5-5",
  defaultThinkingLevel: "high",
  enableInstallTelemetry: false,
  quietStartup: true,
};

function agentDir(name, settings, { preset = false } = {}) {
  const dir = path.join(BENCH, "agents", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["models.json", "auth.json"]) {
    const src = path.join(AGENT, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
  }
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ ...base, ...settings }, null, 2) + "\n");
  if (preset) {
    // The installed package tree (git/) and the preset's own state: skills store state so
    // git-conventions is on by default, mcp.json so the system prompt has its mcp_servers block.
    const git = path.join(AGENT, "git");
    if (fs.existsSync(git)) fs.symlinkSync(git, path.join(dir, "git"));
    for (const f of ["mcp.json"]) if (fs.existsSync(path.join(AGENT, f))) fs.copyFileSync(path.join(AGENT, f), path.join(dir, f));
    const state = path.join(AGENT, "pi-preset");
    if (fs.existsSync(state)) {
      fs.mkdirSync(path.join(dir, "pi-preset"));
      for (const f of ["settings.json", "skills-state.json"]) {
        if (fs.existsSync(path.join(state, f))) fs.copyFileSync(path.join(state, f), path.join(dir, "pi-preset", f));
      }
    }
  }
  console.log(`agents/${name}: ${settings.packages?.join(", ") ?? "no packages"}`);
}

agentDir("pure", {});
agentDir("old", { packages: [PRESET_SOURCE] }, { preset: true });
agentDir("new", { packages: [REPO] }, { preset: true });

if (!process.argv.includes("--no-jinja")) {
  const dir = path.join(BENCH, ".cache", "jinja");
  if (fs.existsSync(path.join(dir, "src", "jinja2"))) {
    console.log(`.cache/jinja: present`);
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "inherit" });
    git("init", "-q");
    git("remote", "add", "origin", JINJA_REPO);
    git("fetch", "-q", "--depth", "1", "origin", JINJA_COMMIT);
    git("checkout", "-q", "FETCH_HEAD");
    fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
    fs.rmSync(path.join(dir, ".github"), { recursive: true, force: true });
    console.log(`.cache/jinja: ${JINJA_COMMIT.slice(0, 7)}`);
  }
}
