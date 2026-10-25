// /termius enable | disable: a switch that holds in every session, which pi's
// /mcp cannot offer for a server an extension registers.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-preset-termius-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

const { installDir, readConfig, serverBinary, sourceHash, writeConfig } = await import("../src/termius/install.ts");
const { default: termiusExtension } = await import("../extensions/termius.ts");

const configFile = () => join(installDir(), "config.json");

/** A current install: the server binary exists and the stamp matches the vendored source. */
function fakeInstall(): void {
	mkdirSync(join(serverBinary(), ".."), { recursive: true });
	writeFileSync(serverBinary(), "");
	writeFileSync(join(installDir(), "installed.json"), JSON.stringify({ sourceHash: sourceHash() }));
}

type Handler = (args: string, ctx: unknown) => Promise<void>;

function load() {
	const calls: string[] = [];
	const notes: string[] = [];
	let command: Handler | undefined;
	const sessionStart: ((event: unknown, ctx: unknown) => Promise<void>)[] = [];
	const pi = {
		registerMcpServer: (name: string) => calls.push(`register ${name}`),
		unregisterMcpServer: (name: string) => calls.push(`unregister ${name}`),
		registerCommand: (_name: string, options: { handler: Handler }) => {
			command = options.handler;
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
			if (event === "session_start") sessionStart.push(handler);
		},
	};
	termiusExtension(pi as never);
	const ctx = {
		hasUI: false,
		mode: "print",
		ui: { notify: (message: string) => notes.push(message), setStatus() {} },
	};
	return {
		calls,
		notes,
		run: (args: string) => command!(args, ctx),
		startSession: () => Promise.all(sessionStart.map((handler) => handler({}, ctx))),
	};
}

beforeEach(() => {
	rmSync(installDir(), { recursive: true, force: true });
	fakeInstall();
});

test("enabled by default: the server is registered and the flag is not written", () => {
	assert.equal(readConfig().enabled, undefined);
	assert.deepEqual(load().calls, ["register termius"]);
});

test("disable unregisters now, persists, and later sessions do not register", async () => {
	const first = load();
	await first.run("disable");
	assert.deepEqual(first.calls, ["register termius", "unregister termius"]);
	assert.equal(JSON.parse(readFileSync(configFile(), "utf8")).enabled, false);
	assert.match(first.notes.at(-1)!, /off in every session/);

	const next = load();
	await next.startSession();
	assert.deepEqual(next.calls, [], "a new session (or /reload) leaves it off");
});

test("enable registers again and drops the flag; other settings survive", async () => {
	writeConfig({ mode: "review", proxy: "off", enabled: false });
	const session = load();
	assert.deepEqual(session.calls, []);
	await session.run("enable");
	assert.deepEqual(session.calls, ["register termius"]);
	const saved = JSON.parse(readFileSync(configFile(), "utf8"));
	assert.equal("enabled" in saved, false);
	assert.equal(saved.mode, "review");
	assert.equal(saved.proxy, "off");
});

test("a session that loaded enabled follows a disable from another session at its next start", async () => {
	const session = load();
	writeConfig({ ...readConfig(), enabled: false });
	await session.startSession();
	assert.deepEqual(session.calls, ["register termius", "unregister termius"]);
});

test("repeating enable or disable does not restart the server", async () => {
	const session = load();
	await session.run("enable");
	await session.run("disable");
	await session.run("disable");
	assert.deepEqual(session.calls, ["register termius", "unregister termius"]);
});
