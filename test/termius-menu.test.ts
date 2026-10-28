// /termius: one menu with live state, only the actions that apply, Esc to
// leave; the host list and detail page; side-by-side environments so an
// update never overwrites a running server.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-preset-termius-menu-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_PRESET_LANG = "en";
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

const install = await import("../src/termius/install.ts");
const { readConfig, writeConfig } = await import("../src/termius/config.ts");
const { appendActivity } = await import("../src/termius/activity.ts");
const { readFooter } = await import("../src/termius/footer-state.ts");
const { SESSION_ENTRY } = await import("../src/termius/session-state.ts");
const { default: termiusExtension, ago } = await import("../extensions/termius.ts");

const POSIX = process.platform !== "win32";

const KEYS: Record<string, string> = {
	"tui.select.up": "UP",
	"tui.select.down": "DOWN",
	"tui.select.confirm": "ENTER",
	"tui.select.cancel": "ESC",
	"tui.editor.deleteCharBackward": "BACKSPACE",
};
const keybindings = { matches: (data: string, id: string) => KEYS[id] === data };
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

function stamp(value: object) {
	writeFileSync(join(install.installDir(), "installed.json"), JSON.stringify(value));
}

const statePath = join(agentDir, "fake-termius.json");
process.env.FAKE_TERMIUS_STATE = statePath;

/**
 * A current install in venv-<hash>, as install() leaves it. On POSIX the
 * "server" answers login-json from fake-termius.json, so the menu sees an
 * account and a host list.
 */
function fakeInstall(name = `venv-${install.sourceHash().slice(0, 12)}`, hash = install.sourceHash()) {
	stamp({ sourceHash: hash, venv: name });
	mkdirSync(join(install.serverBinary(), ".."), { recursive: true });
	writeFileSync(
		install.serverBinary(),
		`#!/usr/bin/env node
const fs = require("fs");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
	const request = JSON.parse(input || "{}");
	const state = JSON.parse(fs.readFileSync(process.env.FAKE_TERMIUS_STATE, "utf8"));
	fs.appendFileSync(process.env.FAKE_TERMIUS_STATE + ".log", JSON.stringify({ request, env: process.env.TERMIUS_MCP_POLICY || null }) + "\\n");
	process.stdout.write(JSON.stringify(state[request.action] || { ok: false, code: "invalid_request", error: "no fixture" }) + "\\n");
});
`,
	);
	chmodSync(install.serverBinary(), 0o755);
}

const ROWS = [
	{ id: 1, cloud_id: "101", label: "bastion", address: "1.2.3.4", port: 22, tags: [], route: { mode: "termius", source: "global", jump_hosts: [], proxy: null }, via: [] },
	{ id: 2, cloud_id: "102", label: "web", address: "10.0.0.2", port: 22, tags: ["prod"], route: { mode: "termius", source: "global", jump_hosts: ["bastion"], proxy: null }, via: ["101"] },
	{ id: 3, cloud_id: "103", label: "db", address: "10.0.0.3", port: 22, tags: [], route: { mode: "termius", source: "global", jump_hosts: ["bastion"], proxy: null }, via: ["101"] },
];

function fixtures(signedIn: boolean, extra: Record<string, unknown> = {}) {
	writeFileSync(
		statePath,
		JSON.stringify({
			status: signedIn
				? { ok: true, logged_in: true, username: "me@example.com", hosts: 3, last_synced: new Date().toISOString(), vault_remembered: true }
				: { ok: true, logged_in: false },
			hosts: { ok: true, logged_in: signedIn, hosts: signedIn ? ROWS : [] },
			test: { ok: true, seconds: 0.5, stages: [{ label: "bastion", address: "1.2.3.4", port: 22, via: "direct", seconds: 0.2 }, { label: "web", address: "10.0.0.2", port: 22, via: "jump host bastion", seconds: 0.3 }] },
			...extra,
		}),
	);
	rmSync(`${statePath}.log`, { force: true });
}

function requests(): string[] {
	if (!existsSync(`${statePath}.log`)) return [];
	return readFileSync(`${statePath}.log`, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line).request.action);
}

type Screen = { render: (width: number) => string[]; handleInput: (data: string) => void };
type Step = (view: () => string, screen: Screen) => void | Promise<void>;

/** Poll the rendered screen until it matches (background loads arrive asynchronously). */
async function until(view: () => string, pattern: RegExp): Promise<string> {
	const deadline = Date.now() + 5000;
	for (;;) {
		const text = view();
		if (pattern.test(text)) return text;
		if (Date.now() > deadline) assert.fail(`screen never matched ${pattern}:\n${text}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function type(screen: Screen, text: string) {
	for (const char of text) screen.handleInput(char);
}

function loadExtension() {
	const calls: string[] = [];
	const notes: string[] = [];
	const entries: unknown[] = [];
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<unknown>)[]>();
	let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const pi = {
		registerMcpServer: (name: string) => calls.push(`register ${name}`),
		unregisterMcpServer: (name: string) => calls.push(`unregister ${name}`),
		registerCommand: (_n: string, options: { handler: typeof command }) => {
			command = options.handler;
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage() {},
	};
	termiusExtension(pi as never);
	return { pi, calls, notes, entries, handlers, command: () => command! };
}

/** Load the extension and drive /termius: each step gets the live screen and acts on it. */
async function drive(steps: Step[]) {
	const loaded = loadExtension();
	const screens: string[] = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			notify: (message: string) => loaded.notes.push(message),
			setStatus() {},
			input: async () => undefined,
			custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => Screen) =>
				new Promise((resolve, reject) => {
					const screen = factory({ requestRender() {} }, theme, keybindings, resolve);
					const view = () => screen.render(100).join("\n");
					screens.push(view());
					const step = steps.shift();
					Promise.resolve(step ? step(view, screen) : screen.handleInput("ESC")).catch(reject);
				}),
		},
	};
	await loaded.command()("", ctx);
	return { ...loaded, screens };
}

beforeEach(() => {
	rmSync(install.installDir(), { recursive: true, force: true });
	mkdirSync(install.installDir(), { recursive: true });
});

test("signed out: sign in and on/off only; recent activity once there is some", { skip: !POSIX }, async () => {
	fakeInstall();
	fixtures(false);
	await drive([
		async (view, screen) => {
			const text = await until(view, /Sign in/);
			assert.match(text, /Signed out · MCP on/);
			assert.match(text, /1\. Sign in/);
			assert.match(text, /2\. Turn the MCP server off/);
			assert.doesNotMatch(text, /Hosts|Global access level|Global route|Proxy|Recent activity|Sign out/);
			screen.handleInput("ESC");
		},
	]);
	appendActivity({ time: new Date().toISOString(), host: "web", tool: "exec", detail: "uptime", decision: "auto", exit: 0 });
	await drive([
		async (view, screen) => {
			const text = await until(view, /Sign in/);
			assert.match(text, /2\. Recent activity +1 today/);
			screen.handleInput("ESC");
		},
	]);
});

test("signed in: hosts, global level and route, proxy, sign out, off", { skip: !POSIX }, async () => {
	fakeInstall();
	fixtures(true);
	const { screens } = await drive([
		async (view, screen) => {
			const text = await until(view, /Hosts +3/);
			await until(() => JSON.stringify(readConfig().knownHosts ?? null), /101/);
			assert.match(text, /Signed in as me@example\.com · 3 hosts · synced just now/);
			assert.match(text, /MCP on · level auto · route Termius/);
			assert.match(text, /1\. Hosts +3/);
			assert.match(text, /2\. Global access level +auto/);
			assert.match(text, /3\. Global route +Termius/);
			assert.match(text, /4\. Proxy +system/);
			assert.match(text, /5\. Sign out/);
			assert.match(text, /6\. Turn the MCP server off/);
			screen.handleInput("ESC");
		},
	]);
	assert.equal(screens.length, 1, "Esc on the main menu closes it");
	assert.deepEqual(readConfig().knownHosts, ["101", "102", "103"], "the first host list is the baseline for new hosts");
});

test("turning the server off flips the item and persists", { skip: !POSIX }, async () => {
	fakeInstall();
	fixtures(false);
	const { calls } = await drive([
		async (view, screen) => {
			await until(view, /Sign in/);
			screen.handleInput("2");
		},
		async (view, screen) => {
			const text = await until(view, /Turn the MCP server on/);
			assert.match(text, /MCP server off in every session\./);
			assert.match(text, /Signed out · MCP off/);
			screen.handleInput("ESC");
		},
	]);
	assert.deepEqual(calls, ["register termius", "unregister termius"]);
	assert.equal(readConfig().enabled, false);
});

test("the global level and route pickers apply, and Esc returns to the menu", { skip: !POSIX }, async () => {
	fakeInstall();
	fixtures(true);
	await drive([
		async (view, screen) => {
			await until(view, /Hosts +3/);
			screen.handleInput("2");
		},
		(view, screen) => {
			const text = view();
			assert.match(text, /global access level/);
			assert.match(text, /✓ auto/);
			assert.match(text, /Esc back/);
			assert.doesNotMatch(text, /disabled/, "off is not a global level");
			screen.handleInput("ESC");
		},
		(view, screen) => {
			assert.match(view(), /Global access level +auto/, "back on the main menu");
			screen.handleInput("2");
		},
		(_view, screen) => screen.handleInput("2"), // review
		(view, screen) => {
			assert.match(view(), /Global access level review: Every command/);
			screen.handleInput("3");
		},
		(_view, screen) => screen.handleInput("3"), // direct
		(view, screen) => {
			assert.match(view(), /Global route: direct\./);
			assert.match(view(), /route direct/);
			screen.handleInput("ESC");
		},
	]);
	assert.equal(readConfig().mode, "review");
	assert.equal(readConfig().route, "direct");
	// The reload runs in the background; wait for its request.
	await until(() => requests().join(","), /hosts/);
});

test("the host list filters, opens a host, and saves its level", { skip: !POSIX }, async () => {
	fakeInstall();
	fixtures(true);
	writeConfig({ mode: "auto", knownHosts: ["101", "102"] });
	await drive([
		async (view, screen) => {
			await until(view, /Hosts +3 · 1 new/);
			screen.handleInput("1");
		},
		async (view, screen) => {
			const text = await until(view, /bastion/);
			assert.match(text, /Termius · Hosts \(3\)/);
			assert.match(text, /bastion +1\.2\.3\.4 +direct +· +jump ×2/);
			assert.match(text, /db +10\.0\.0\.3 +→bastion +· +new/);
			type(screen, "web");
			const filtered = view();
			assert.match(filtered, /Filter: web_/);
			assert.doesNotMatch(filtered, /10\.0\.0\.3/);
			screen.handleInput("ENTER");
		},
		(view, screen) => {
			const text = view();
			assert.match(text, /^ web$/m);
			assert.match(text, /10\.0\.0\.2:22/);
			assert.match(text, /Tags: prod/);
			assert.match(text, /Route: Termius \(follow global\) · bastion/);
			assert.match(text, /Level: auto \(global\)/);
			assert.match(text, /1\. Access level +follow global \(auto\)/);
			screen.handleInput("1");
		},
		(_view, screen) => screen.handleInput("3"), // inherit, off, read-only
		(view, screen) => {
			assert.match(view(), /Access level +read-only/);
			screen.handleInput("ESC");
		},
		(view, screen) => {
			assert.match(view(), /web +10\.0\.0\.2 +→bastion +read-only/);
			screen.handleInput("ESC");
		},
	]);
	assert.deepEqual(readConfig().hosts, { "102": { level: "read-only", label: "web" } });
	assert.ok(readConfig().knownHosts?.includes("102"));
});

test("selecting several hosts edits them together", { skip: !POSIX }, async () => {
	fakeInstall();
	fixtures(true);
	await drive([
		async (view, screen) => {
			await until(view, /Hosts +3/);
			screen.handleInput("1");
		},
		async (view, screen) => {
			await until(view, /bastion/);
			screen.handleInput("DOWN");
			screen.handleInput(" ");
			screen.handleInput("DOWN");
			screen.handleInput(" ");
			assert.match(view(), /Enter edit 2 selected/);
			screen.handleInput("ENTER");
		},
		(view, screen) => {
			assert.match(view(), /2 hosts selected/);
			screen.handleInput("2"); // route
		},
		(_view, screen) => screen.handleInput("4"), // inherit, termius, termius-proxy, direct
		(view, screen) => {
			assert.match(view(), /Updated 2 hosts\./);
			screen.handleInput("ESC");
		},
		(_view, screen) => screen.handleInput("ESC"),
	]);
	const hosts = readConfig().hosts ?? {};
	assert.equal(hosts["102"]?.route, "direct");
	assert.equal(hosts["103"]?.route, "direct");
	assert.equal(hosts["101"], undefined);
});

test("a temporary level is kept in the session and comes back on /reload", { skip: !POSIX }, async () => {
	fakeInstall();
	fixtures(true);
	const { entries } = await drive([
		async (view, screen) => {
			await until(view, /Hosts +3/);
			screen.handleInput("1");
		},
		async (view, screen) => {
			await until(view, /bastion/);
			screen.handleInput("ENTER"); // bastion
		},
		(view, screen) => {
			assert.match(view(), /Temporary level for this session +none/);
			screen.handleInput(view().includes("3. Temporary") ? "3" : "4");
		},
		(_view, screen) => screen.handleInput("6"), // none, off, read-only, review, auto, trusted
		(view, screen) => {
			assert.match(view(), /Temporary level for this session +trusted/);
			screen.handleInput("ESC");
		},
		(view, screen) => {
			assert.match(view(), /temp: trusted/);
			screen.handleInput("ESC");
		},
	]);
	assert.deepEqual(entries.at(-1), { type: "custom", customType: SESSION_ENTRY, data: { allowed: [], temporary: { "101": "trusted" } } });

	const next = loadExtension();
	const ctx = { hasUI: false, ui: { setStatus() {}, notify() {} }, sessionManager: { getBranch: () => entries } };
	for (const handler of next.handlers.get("session_start") ?? []) await handler({ reason: "reload" }, ctx);
	assert.equal(readFooter()?.grants, 1, "restored after /reload");
	for (const handler of next.handlers.get("session_start") ?? []) await handler({ reason: "new" }, ctx);
	assert.equal(readFooter(), undefined, "a new session starts clean");
});

test("the connection test shows each hop", { skip: !POSIX }, async () => {
	fakeInstall();
	fixtures(true);
	await drive([
		async (view, screen) => {
			await until(view, /Hosts +3/);
			screen.handleInput("1");
		},
		async (view, screen) => {
			await until(view, /bastion/);
			type(screen, "web");
			screen.handleInput("ENTER");
		},
		(view, screen) => {
			const index = view().split("\n").find((line) => /\d\. Test connection/.test(line))!.match(/(\d)\./)![1]!;
			screen.handleInput(index);
		},
		async (view, screen) => {
			const text = await until(view, /Connected in 0\.50 s/);
			assert.match(text, /✓ bastion \(1\.2\.3\.4:22\) via direct, 0\.20 s/);
			assert.match(text, /✓ web \(10\.0\.0\.2:22\) via bastion, 0\.30 s/);
			screen.handleInput("ESC");
		},
		(_view, screen) => screen.handleInput("ESC"),
	]);
	const log = readFileSync(`${statePath}.log`, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const test = log.find((line) => line.request.action === "test");
	assert.equal(test.request.host, "102");
	assert.ok(String(test.env).endsWith("config.json"), "login-json gets the policy file");
});

test("typed subcommands set a host's level and the global route", { skip: !POSIX }, async () => {
	fakeInstall();
	fixtures(true);
	const loaded = loadExtension();
	const ctx = { hasUI: false, mode: "print", ui: { notify: (text: string) => loaded.notes.push(text), setStatus() {} } };
	await loaded.command()("host web read-only", ctx);
	await loaded.command()("host db inherit", ctx);
	await loaded.command()("host nope off", ctx);
	await loaded.command()("route proxy", ctx);
	await loaded.command()("mode dangerously", ctx);
	assert.deepEqual(loaded.notes.slice(0, 3), ["termius: web: read-only.", "termius: db: follow global.", "termius: No host named nope."]);
	assert.equal(readConfig().hosts?.["102"]?.level, "read-only");
	assert.equal(readConfig().route, "proxy");
	assert.equal(readConfig().mode, "trusted");
});

test("not installed and no uv or Python: only an install item, no sign-in", async () => {
	// findUv() also tries ~/.local/bin and ~/.cargo/bin; point home away too, or
	// the menu would start a real install in the background.
	const saved = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
	process.env.PATH = "";
	process.env.HOME = process.env.USERPROFILE = agentDir;
	try {
		await drive([
			(view, screen) => {
				const text = view();
				assert.match(text, /Server: not installed/);
				assert.match(text, /MCP server: on/);
				assert.match(text, /1\. Install the MCP server/);
				assert.match(text, /2\. Turn the MCP server off/);
				assert.doesNotMatch(text, /Sign in/);
				screen.handleInput("ESC");
			},
		]);
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("an update builds a new environment and leaves the old one in place", () => {
	// Legacy layout: plain venv/ and a stamp without `venv`.
	stamp({ sourceHash: "old" });
	assert.equal(install.venvDir(), join(install.installDir(), "venv"));
	mkdirSync(join(install.serverBinary(), ".."), { recursive: true });
	writeFileSync(install.serverBinary(), "");
	assert.equal(install.installState(), "outdated");

	fakeInstall();
	assert.match(install.venvDir(), /venv-[0-9a-f]{12}$/);
	assert.equal(install.installState(), "current");
	assert.ok(existsSync(join(install.installDir(), "venv")), "the previous environment is kept for running servers");
});

test("cleanup keeps the current and the newest previous environment", () => {
	const dirs = ["venv", "venv-aaaaaaaaaaaa", "venv-bbbbbbbbbbbb", "venv-cccccccccccc"];
	dirs.forEach((name, i) => {
		mkdirSync(join(install.installDir(), name), { recursive: true });
		const time = new Date(Date.now() - (dirs.length - i) * 60_000);
		utimesSync(join(install.installDir(), name), time, time);
	});
	stamp({ sourceHash: "x", venv: "venv-cccccccccccc" });
	const removed = install.removeOldEnvironments().sort();
	assert.deepEqual(removed, ["venv", "venv-aaaaaaaaaaaa"]);
	assert.ok(existsSync(join(install.installDir(), "venv-bbbbbbbbbbbb")));
	assert.ok(existsSync(join(install.installDir(), "venv-cccccccccccc")));
});

test("ago() renders relative times", () => {
	const now = Date.parse("2026-10-25T12:00:00Z");
	assert.equal(ago("2026-10-25T11:59:30Z", now), "just now");
	assert.equal(ago("2026-10-25T11:57:00Z", now), "3 min ago");
	assert.equal(ago("2026-10-25T09:00:00Z", now), "3 h ago");
	assert.equal(ago("", now), "never");
});
