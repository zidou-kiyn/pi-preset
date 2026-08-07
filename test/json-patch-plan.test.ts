import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertModeOnPosix, withPlatform } from "./platform-test-utils.ts";
import { apply } from "../src/apply.ts";
import { jsonEquals } from "../src/json-merge.ts";
import { JSON_PATCHES, OPTIONAL_PACKAGES, REQUIRED_PACKAGES } from "../src/manifest.ts";
import { plan, type PlanOptions, type Step } from "../src/plan.ts";

function makeAgentDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-preset-json-patch-test-"));
}

function cleanup(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

/**
 * Run plan() against a sandbox agent dir.
 *
 * win32 is simulated because planFont() probes the real font stack on linux and
 * darwin; on win32 it only emits a note, which keeps these tests hermetic and
 * fast without touching the font code under test elsewhere.
 */
async function planIn(agentDir: string, options?: PlanOptions): Promise<Awaited<ReturnType<typeof plan>>> {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return await withPlatform("win32", () => plan(options));
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
}

function patchSteps(steps: Step[]): Extract<Step, { kind: "json.patch" }>[] {
	return steps.filter((step): step is Extract<Step, { kind: "json.patch" }> => step.kind === "json.patch");
}

function toolDisplayConfigPath(agentDir: string): string {
	return join(agentDir, "extensions", "pi-tool-display", "config.json");
}

test("jsonEquals compares arrays and objects structurally, not by reference", () => {
	assert.equal(jsonEquals(["left"], ["left"]), true);
	assert.equal(jsonEquals(["left"], ["left", "ctrl+b"]), false);
	assert.equal(jsonEquals({ a: { b: 1 } }, { a: { b: 1 } }), true);
	assert.equal(jsonEquals({ a: 1 }, { a: 1, b: 2 }), false);
	assert.equal(jsonEquals(undefined, false), false);
	assert.equal(jsonEquals(null, false), false);
});

test("the background-tasks package ships and every patch target has a distinct id", () => {
	assert.ok(REQUIRED_PACKAGES.includes("npm:pi-patty-bg-tasks"));
	assert.ok(REQUIRED_PACKAGES.includes("npm:pi-context-view"));
	assert.ok(REQUIRED_PACKAGES.includes("npm:pi-btw"));
	const ids = JSON_PATCHES.map((target) => target.id);
	assert.equal(new Set(ids).size, ids.length);
	assert.deepEqual(ids, ["web-search.json", "pi-tool-display/config.json", "keybindings.json"]);
});

test("optional packages stay out of the default plan and join only when checked", async () => {
	assert.deepEqual(
		OPTIONAL_PACKAGES.map((pkg) => pkg.source),
		["npm:@narumitw/pi-chrome-devtools", "npm:pi-playwright"],
	);
	for (const pkg of OPTIONAL_PACKAGES) {
		assert.ok(!REQUIRED_PACKAGES.includes(pkg.source), `${pkg.source} must not be required`);
	}

	const agentDir = makeAgentDir();
	try {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));

		const withoutExtras = await planIn(agentDir);
		const defaultAdd = withoutExtras.steps.find(
			(step): step is Extract<Step, { kind: "settings.packages.add" }> => step.kind === "settings.packages.add",
		);
		assert.ok(defaultAdd);
		for (const pkg of OPTIONAL_PACKAGES) {
			assert.ok(!defaultAdd.missing.includes(pkg.source), `${pkg.source} must not be planned by default`);
		}

		const extras = OPTIONAL_PACKAGES.map((pkg) => pkg.source);
		const withExtras = await planIn(agentDir, { extraPackages: extras });
		const extrasAdd = withExtras.steps.find(
			(step): step is Extract<Step, { kind: "settings.packages.add" }> => step.kind === "settings.packages.add",
		);
		assert.ok(extrasAdd);
		for (const source of extras) {
			assert.ok(extrasAdd.missing.includes(source), `${source} must be planned when checked`);
		}
		// A checked extra that duplicates a required package is not planned twice.
		const duplicated = await planIn(agentDir, { extraPackages: ["npm:pi-wtf", ...extras] });
		const dupAdd = duplicated.steps.find(
			(step): step is Extract<Step, { kind: "settings.packages.add" }> => step.kind === "settings.packages.add",
		);
		assert.ok(dupAdd);
		assert.equal(dupAdd.missing.filter((source) => source === "npm:pi-wtf").length, 1);
	} finally {
		cleanup(agentDir);
	}
});

test("existing configs are patched per leaf, keep unrelated keys and modes, and converge", async () => {
	const agentDir = makeAgentDir();
	try {
		const toolDisplayPath = toolDisplayConfigPath(agentDir);
		const keybindingsPath = join(agentDir, "keybindings.json");
		const webSearchPath = join(agentDir, "web-search.json");
		mkdirSync(join(agentDir, "extensions", "pi-tool-display"), { recursive: true });
		writeFileSync(
			toolDisplayPath,
			JSON.stringify({
				enabled: true,
				registerToolOverrides: { read: true, bash: true, write: true },
				readOutputMode: "hidden",
				diffCollapsedLines: 24,
			}),
		);
		writeFileSync(
			keybindingsPath,
			JSON.stringify({ "tui.editor.cursorLeft": ["left", "ctrl+b"], "app.exit": ["ctrl+q"] }),
		);
		writeFileSync(webSearchPath, JSON.stringify({ webSearch: { enabled: false }, ssrf: { trustEnvProxy: true } }));
		chmodSync(toolDisplayPath, 0o640);
		chmodSync(keybindingsPath, 0o640);

		const first = await planIn(agentDir);
		const steps = patchSteps(first.steps);
		assert.deepEqual(
			steps.map((step) => step.targetId),
			["pi-tool-display/config.json", "keybindings.json"],
		);
		// web-search.json already matched, so it produced a note instead of a step.
		assert.ok(first.notes.some((note) => note.text.startsWith("web-search.json: 2 key(s) already match")));
		assert.deepEqual(steps[0]?.changes, [
			{ key: "registerToolOverrides.bash", path: ["registerToolOverrides", "bash"], from: true, to: false },
		]);
		assert.deepEqual(steps[1]?.changes, [
			{
				key: "tui.editor.cursorLeft",
				path: ["tui.editor.cursorLeft"],
				from: ["left", "ctrl+b"],
				to: ["left"],
			},
		]);

		const result = await apply({ steps, notes: [], blockers: [] });
		assert.equal(result.ok, true);
		assert.deepEqual(
			result.results.map((entry) => entry.targetId),
			["pi-tool-display/config.json", "keybindings.json"],
		);

		const toolDisplay = JSON.parse(readFileSync(toolDisplayPath, "utf8"));
		assert.deepEqual(toolDisplay.registerToolOverrides, { read: true, bash: false, write: true });
		assert.equal(toolDisplay.readOutputMode, "hidden");
		assert.equal(toolDisplay.diffCollapsedLines, 24);
		assert.equal(toolDisplay.enabled, true);
		const keybindings = JSON.parse(readFileSync(keybindingsPath, "utf8"));
		assert.deepEqual(keybindings["tui.editor.cursorLeft"], ["left"]);
		assert.deepEqual(keybindings["app.exit"], ["ctrl+q"]);
		assertModeOnPosix(toolDisplayPath, 0o640);
		assertModeOnPosix(keybindingsPath, 0o640);

		// The array-valued keybinding leaf is the idempotence risk: a reference
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
			["web-search.json", "pi-tool-display/config.json", "keybindings.json"],
		);
		assert.deepEqual(steps[1]?.changes, [
			{ key: "registerToolOverrides.bash", path: ["registerToolOverrides", "bash"], from: undefined, to: false },
		]);

		assert.equal((await apply({ steps, notes: [], blockers: [] })).ok, true);
		assert.deepEqual(JSON.parse(readFileSync(toolDisplayConfigPath(agentDir), "utf8")), {
			registerToolOverrides: { bash: false },
		});
		assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "keybindings.json"), "utf8")), {
			"tui.editor.cursorLeft": ["left"],
		});

		assert.deepEqual(patchSteps((await planIn(agentDir)).steps), []);
	} finally {
		cleanup(agentDir);
	}
});

test("an unreadable target blocks only its own step", async () => {
	const agentDir = makeAgentDir();
	try {
		writeFileSync(join(agentDir, "keybindings.json"), "{ not json");

		const result = await planIn(agentDir);
		assert.equal(result.blockers.length, 1);
		assert.match(result.blockers[0] ?? "", /^keybindings\.json: .*not valid JSON/);
		assert.deepEqual(
			patchSteps(result.steps).map((step) => step.targetId),
			["web-search.json", "pi-tool-display/config.json"],
		);
	} finally {
		cleanup(agentDir);
	}
});
