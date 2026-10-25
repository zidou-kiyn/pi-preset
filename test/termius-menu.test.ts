// /termius: one menu with live state, only the actions that apply, Esc to
// leave; side-by-side environments so an update never overwrites a running server.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-preset-termius-menu-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

const install = await import("../src/termius/install.ts");
const { default: termiusExtension, ago } = await import("../extensions/termius.ts");

const KEYS: Record<string, string> = { "tui.select.up": "UP", "tui.select.down": "DOWN", "tui.select.confirm": "ENTER", "tui.select.cancel": "ESC" };
const keybindings = { matches: (data: string, id: string) => KEYS[id] === data };
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

function stamp(value: object) {
	writeFileSync(join(install.installDir(), "installed.json"), JSON.stringify(value));
}

/** A current install in venv-<hash>, as install() leaves it. */
function fakeInstall(name = `venv-${install.sourceHash().slice(0, 12)}`, hash = install.sourceHash()) {
	stamp({ sourceHash: hash, venv: name });
	mkdirSync(join(install.serverBinary(), ".."), { recursive: true });
	writeFileSync(install.serverBinary(), "");
}

type Screen = { render: (width: number) => string[]; handleInput: (data: string) => void };

/** Load the extension and drive /termius: each step gets the rendered screen and acts on it. */
async function drive(steps: ((text: string, screen: Screen) => void)[]) {
	const calls: string[] = [];
	const notes: string[] = [];
	let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const pi = {
		registerMcpServer: (name: string) => calls.push(`register ${name}`),
		unregisterMcpServer: (name: string) => calls.push(`unregister ${name}`),
		registerCommand: (_n: string, options: { handler: typeof command }) => {
			command = options.handler;
		},
		on: () => {},
	};
	termiusExtension(pi as never);
	const screens: string[] = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			notify: (message: string) => notes.push(message),
			setStatus() {},
			custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => Screen) =>
				new Promise((resolve) => {
					const screen = factory({ requestRender() {} }, theme, keybindings, resolve);
					const text = screen.render(100).join("\n");
					screens.push(text);
					const step = steps.shift();
					if (step) step(text, screen);
					else screen.handleInput("ESC");
				}),
		},
	};
	await command!("", ctx);
	return { calls, notes, screens };
}

beforeEach(() => {
	rmSync(install.installDir(), { recursive: true, force: true });
	mkdirSync(install.installDir(), { recursive: true });
});

test("installed and on: sign in, turn off, mode, proxy; no setup/sync/status items", async () => {
	fakeInstall();
	const { screens } = await drive([
		(text, screen) => {
			assert.match(text, /Termius/);
			assert.match(text, /MCP server: on/);
			assert.match(text, /Approval: auto/);
			assert.match(text, /1\. Sign in/);
			assert.match(text, /2\. Turn the MCP server off/);
			assert.match(text, /Approval mode +auto/);
			assert.match(text, /Proxy +system/);
			assert.doesNotMatch(text, /Install|Sync|Status|Sign out|Turn the MCP server on/);
			screen.handleInput("ESC");
		},
	]);
	assert.equal(screens.length, 1, "Esc on the main menu closes it");
});

test("an action returns to the menu with its result; the item flips", async () => {
	fakeInstall();
	const { calls, screens } = await drive([
		(_text, screen) => screen.handleInput("2"), // turn off
		(text, screen) => {
			assert.match(text, /MCP server off in every session\./);
			assert.match(text, /MCP server: off in every session/);
			assert.match(text, /Turn the MCP server on/);
			screen.handleInput("ESC");
		},
	]);
	assert.deepEqual(calls, ["register termius", "unregister termius"]);
	assert.equal(screens.length, 2);
	assert.equal(JSON.parse(readFileSync(join(install.installDir(), "config.json"), "utf8")).enabled, false);
});

test("Esc in a sub-menu returns to the main menu; a pick there applies", async () => {
	fakeInstall();
	const { screens } = await drive([
		(_text, screen) => screen.handleInput("3"), // approval mode
		(text, screen) => {
			assert.match(text, /approval mode/);
			assert.match(text, /✓ auto/);
			assert.match(text, /Esc back/);
			screen.handleInput("ESC");
		},
		(text, screen) => {
			assert.match(text, /Termius/, "back on the main menu");
			screen.handleInput("3");
		},
		(_text, screen) => screen.handleInput("1"), // review
		(text, screen) => {
			assert.match(text, /Approval mode review/);
			assert.match(text, /Approval mode +review/);
			screen.handleInput("ESC");
		},
	]);
	assert.equal(screens.length, 5);
});

test("not installed and no uv or Python: only an install item, no sign-in", async () => {
	// findUv() also tries ~/.local/bin and ~/.cargo/bin; point home away too, or
	// the menu would start a real install in the background.
	const saved = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
	process.env.PATH = "";
	process.env.HOME = process.env.USERPROFILE = agentDir;
	try {
		await drive([
			(text, screen) => {
				assert.match(text, /Server: not installed/);
				assert.match(text, /1\. Install the MCP server/);
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
