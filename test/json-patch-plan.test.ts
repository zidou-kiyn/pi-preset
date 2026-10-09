import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertModeOnPosix } from "./platform-test-utils.ts";
import { apply } from "../src/apply.ts";
import { jsonEquals } from "../src/json-merge.ts";
import { CHROME_DEVTOOLS_MCP_VERSION, JSON_PATCHES } from "../src/manifest.ts";
import { plan, type PlanOptions, type Step } from "../src/plan.ts";

function makeAgentDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-preset-json-patch-test-"));
}

function cleanup(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

/** Run plan() against a sandbox agent dir. */
async function planIn(agentDir: string, options?: PlanOptions): Promise<Awaited<ReturnType<typeof plan>>> {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return await plan(options);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
}

function patchSteps(steps: Step[]): Extract<Step, { kind: "json.patch" }>[] {
	return steps.filter((step): step is Extract<Step, { kind: "json.patch" }> => step.kind === "json.patch");
}

const CHROME_ARGS = ["-y", `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`, "--no-usage-statistics", "--no-performance-crux"];

test("jsonEquals compares arrays and objects structurally, not by reference", () => {
	assert.equal(jsonEquals(["left"], ["left"]), true);
	assert.equal(jsonEquals(["left"], ["left", "ctrl+b"]), false);
	assert.equal(jsonEquals({ a: { b: 1 } }, { a: { b: 1 } }), true);
	assert.equal(jsonEquals({ a: 1 }, { a: 1, b: 2 }), false);
	assert.equal(jsonEquals(undefined, false), false);
	assert.equal(jsonEquals(null, false), false);
});

test("patch targets: settings.json and the chrome-devtools MCP server, distinct ids", () => {
	const ids = JSON_PATCHES.map((target) => target.id);
	assert.equal(new Set(ids).size, ids.length);
	assert.deepEqual(ids, ["settings.json", "mcp.json"]);
	const chrome = (JSON_PATCHES[1]?.patch.mcpServers as Record<string, Record<string, unknown>>)["chrome-devtools"];
	assert.equal(chrome?.exposure, "codemode", "browser tools are called from codemode scripts, never declared");
	assert.deepEqual(chrome?.args, CHROME_ARGS);
	assert.ok(!("enabled" in (chrome ?? {})), "enabled belongs to the user (/mcp toggles it)");
	assert.match(CHROME_DEVTOOLS_MCP_VERSION, /^\d+\.\d+\.\d+$/, "the MCP server is pinned, never @latest");
});

test("existing configs are patched per leaf, keep unrelated keys and modes, and converge", async () => {
	const agentDir = makeAgentDir();
	try {
		const mcpPath = join(agentDir, "mcp.json");
		writeFileSync(
			mcpPath,
			JSON.stringify({
				autoEnableCodemode: false,
				mcpServers: {
					github: { url: "https://api.githubcopilot.com/mcp/" },
					"chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"], enabled: false },
				},
			}),
		);
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ packages: [], theme: "dark", tuiMode: "regular", fullscreenCopyOnSelect: false }),
		);
		chmodSync(mcpPath, 0o640);

		const first = await planIn(agentDir);
		const steps = patchSteps(first.steps);
		assert.deepEqual(
			steps.map((step) => step.targetId),
			["settings.json", "mcp.json"],
		);
		// Leaves that already match are not rewritten.
		assert.deepEqual(steps[0]?.changes, [
			{ key: "tuiMode", path: ["tuiMode"], from: "regular", to: "fullscreen" },
			{ key: "fullscreenWheelScrollLines", path: ["fullscreenWheelScrollLines"], from: undefined, to: "auto" },
			{ key: "enableInstallTelemetry", path: ["enableInstallTelemetry"], from: undefined, to: false },
		]);
		assert.deepEqual(
			steps[1]?.changes.map((change) => change.key),
			[
				"mcpServers.chrome-devtools.args",
				"mcpServers.chrome-devtools.env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS",
				"mcpServers.chrome-devtools.exposure",
				"mcpServers.chrome-devtools.description",
			],
		);

		const result = await apply({ steps, notes: [], blockers: [] });
		assert.equal(result.ok, true);

		const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
		assert.equal(mcp.autoEnableCodemode, false);
		assert.deepEqual(mcp.mcpServers.github, { url: "https://api.githubcopilot.com/mcp/" });
		assert.equal(mcp.mcpServers["chrome-devtools"].enabled, false, "the user's /mcp toggle survives a sync");
		assert.deepEqual(mcp.mcpServers["chrome-devtools"].args, CHROME_ARGS);
		assert.equal(mcp.mcpServers["chrome-devtools"].exposure, "codemode");
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			packages: [],
			theme: "dark",
			tuiMode: "fullscreen",
			fullscreenCopyOnSelect: false,
			fullscreenWheelScrollLines: "auto",
			enableInstallTelemetry: false,
		});
		assertModeOnPosix(mcpPath, 0o640);

		// The array-valued args leaf is the idempotence risk: a reference
		// comparison would report it as different on every run.
		const second = await planIn(agentDir);
		assert.deepEqual(patchSteps(second.steps), []);
	} finally {
		cleanup(agentDir);
	}
});

test("absent targets are created holding only the preset's keys", async () => {
	const agentDir = makeAgentDir();
	try {
		const first = await planIn(agentDir);
		const steps = patchSteps(first.steps);
		assert.deepEqual(
			steps.map((step) => step.targetId),
			["settings.json", "mcp.json"],
		);

		assert.equal((await apply({ steps, notes: [], blockers: [] })).ok, true);
		assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")), {
			tuiMode: "fullscreen",
			fullscreenWheelScrollLines: "auto",
			fullscreenCopyOnSelect: false,
			enableInstallTelemetry: false,
		});
		const mcp = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
		assert.deepEqual(Object.keys(mcp), ["mcpServers"]);
		assert.deepEqual(Object.keys(mcp.mcpServers), ["chrome-devtools"]);

		assert.deepEqual(patchSteps((await planIn(agentDir)).steps), []);
	} finally {
		cleanup(agentDir);
	}
});

test("an unreadable target blocks only its own step", async () => {
	const agentDir = makeAgentDir();
	try {
		writeFileSync(join(agentDir, "mcp.json"), "{ not json");

		const result = await planIn(agentDir);
		assert.equal(result.blockers.length, 1);
		assert.match(result.blockers[0] ?? "", /^mcp\.json: .*not valid JSON/);
		assert.deepEqual(
			patchSteps(result.steps).map((step) => step.targetId),
			["settings.json"],
		);
	} finally {
		cleanup(agentDir);
	}
});
