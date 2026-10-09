import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { apply } from "../src/apply.ts";
import { OPTIONAL_PACKAGES, PRESET_SELF_SOURCE, REQUIRED_PACKAGES, SUPERSEDED_PACKAGES } from "../src/manifest.ts";
import { PackageChecklistComponent, type PackageSelection } from "../src/optional-packages-ui.ts";
import { plan, type PlanOptions, readInstalledPackages, renderPlan, type Step } from "../src/plan.ts";

type RemoveStep = Extract<Step, { kind: "settings.packages.remove" }>;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function inAgentDir<T>(agentDir: string, callback: () => T | Promise<T>): Promise<T> {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return await callback();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
}

function planIn(agentDir: string, options?: PlanOptions): Promise<Awaited<ReturnType<typeof plan>>> {
	return inAgentDir(agentDir, () => plan(options));
}

function removeStep(steps: Step[]): RemoveStep | undefined {
	return steps.find((step): step is RemoveStep => step.kind === "settings.packages.remove");
}

/**
 * A machine mid-migration: old packages the preset now bundles (one spelled
 * with a version, one as an object), the preset itself installed both ways,
 * and packages the preset never shipped.
 */
function writeMixedSettings(agentDir: string): string {
	const settingsPath = join(agentDir, "settings.json");
	writeFileSync(
		settingsPath,
		JSON.stringify({
			theme: "dark",
			packages: [
				"npm:pi-wtf@0.3.0",
				{ source: "npm:pi-patty-bg-tasks", extensions: [] },
				"git:github.com/code-yeongyu/pi-apply-patch",
				`${PRESET_SELF_SOURCE}@main`,
				REPO_ROOT,
				"./local-thing",
				"npm:pi-statusline",
			],
		}),
	);
	return settingsPath;
}

function packagesOf(settingsPath: string): unknown[] {
	return JSON.parse(readFileSync(settingsPath, "utf8")).packages;
}

test("manifest: everything is vendored, nothing is required or optional, the old sources are superseded", () => {
	assert.deepEqual(REQUIRED_PACKAGES, []);
	assert.deepEqual(OPTIONAL_PACKAGES, []);
	const superseded = SUPERSEDED_PACKAGES.map((pkg) => pkg.source);
	for (const source of [
		"npm:pi-patty-bg-tasks",
		"npm:pi-tool-display",
		"npm:@narumitw/pi-btw",
		"npm:@narumitw/pi-chrome-devtools",
		"git:github.com/code-yeongyu/pi-apply-patch",
	]) {
		assert.ok(superseded.includes(source), `${source} must be superseded`);
	}
	assert.ok(!superseded.includes(PRESET_SELF_SOURCE));
	assert.equal(new Set(superseded).size, superseded.length);
});

test("package manifest: every extension and skill path exists, every vendored package is loaded", () => {
	const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
	for (const path of [...pkg.pi.extensions, ...pkg.pi.skills]) {
		assert.ok(existsSync(join(REPO_ROOT, path)), `${path} is missing`);
	}
	const upstream = JSON.parse(readFileSync(join(REPO_ROOT, "vendor", "UPSTREAM.json"), "utf8"));
	for (const [name, entry] of Object.entries<{ dest: string; commit: string }>(upstream.packages)) {
		assert.ok(existsSync(join(REPO_ROOT, entry.dest)), `${name}: ${entry.dest} is missing`);
		assert.match(entry.commit, /^[0-9a-f]{40}$/, `${name}: commit must be a full sha`);
		// rpiv-config is a library; termius-mcp is a Python MCP server that
		// extensions/termius.ts installs and registers.
		if (name === "rpiv-config" || name === "termius-mcp") continue;
		assert.ok(
			pkg.pi.extensions.some((path: string) => path.startsWith(`./${entry.dest}/`)),
			`${name} is vendored but not loaded`,
		);
	}
	for (const superseded of SUPERSEDED_PACKAGES) {
		const dir = superseded.reason.match(/vendor\/([^)]+)/)?.[1];
		if (dir) assert.ok(existsSync(join(REPO_ROOT, "vendor", dir)), `${superseded.source}: vendor/${dir} is missing`);
	}
});

test("installed packages are classified; superseded entries and the preset itself are never listed", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-preset-whitelist-test-"));
	try {
		writeMixedSettings(agentDir);
		const installed = await inAgentDir(agentDir, () => readInstalledPackages());
		assert.deepEqual([...installed.optional], []);
		assert.deepEqual(
			installed.unlisted.map((pkg) => pkg.source),
			["./local-thing", "npm:pi-statusline"],
		);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("without a keep list (no checklist, e.g. RPC mode) only superseded packages are removed", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-preset-whitelist-test-"));
	try {
		writeMixedSettings(agentDir);
		const result = await planIn(agentDir);
		const remove = removeStep(result.steps);
		assert.ok(remove);
		assert.deepEqual(
			remove.remove.map((removal) => removal.source),
			["npm:pi-wtf@0.3.0", "npm:pi-patty-bg-tasks", "git:github.com/code-yeongyu/pi-apply-patch"],
		);
		assert.match(remove.remove[0]!.reason, /bundled in pi-preset/);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("superseded + everything not kept is removed once per identity, then converges", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-preset-whitelist-test-"));
	try {
		const settingsPath = writeMixedSettings(agentDir);
		const options: PlanOptions = { extraPackages: [], keep: ["./local-thing"] };

		const first = await planIn(agentDir, options);
		const remove = removeStep(first.steps);
		assert.ok(remove);
		assert.deepEqual(
			remove.remove.map((removal) => removal.source),
			["npm:pi-wtf@0.3.0", "npm:pi-patty-bg-tasks", "git:github.com/code-yeongyu/pi-apply-patch", "npm:pi-statusline"],
		);
		assert.equal(remove.remove[3]!.reason, "not in preset, not kept");
		assert.match(renderPlan(first), /- settings\.json packages\[\]: remove 4/);

		// Fake `pi remove`: record the call and drop the exact entry, as pi does.
		const uninstalled: string[] = [];
		const result = await apply(first, {
			uninstall: async (source, dir) => {
				assert.equal(dir, agentDir);
				uninstalled.push(source);
				const current = JSON.parse(readFileSync(settingsPath, "utf8"));
				current.packages = current.packages.filter((entry: unknown) => entry !== source);
				writeFileSync(settingsPath, JSON.stringify(current));
			},
		});
		assert.ok(result.ok, JSON.stringify(result.results));
		assert.equal(uninstalled.length, 4, "one pi remove per identity");

		const packages = packagesOf(settingsPath);
		const text = JSON.stringify(packages);
		assert.ok(!text.includes("pi-patty-bg-tasks"), "the object spelling is gone too");
		assert.ok(!text.includes("pi-statusline"));
		for (const kept of [`${PRESET_SELF_SOURCE}@main`, REPO_ROOT, "./local-thing"]) {
			assert.ok(packages.includes(kept), `${kept} must survive`);
		}
		assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).theme, "dark");

		const second = await planIn(agentDir, options);
		assert.equal(removeStep(second.steps), undefined, "a second run converges");
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("a failed uninstall still removes the settings entry and reports leftover files", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-preset-whitelist-test-"));
	try {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ packages: ["./keep-me", "npm:pi-statusline"] }));

		const planned = await planIn(agentDir, { keep: ["./keep-me"] });
		planned.steps = planned.steps.filter((step) => step.kind === "settings.packages.remove");
		const result = await apply(planned, {
			uninstall: async () => {
				throw new Error("pi: command not found");
			},
		});

		assert.ok(result.ok, "leftover files are a warning, not a failed step");
		assert.match(result.results[0]!.message, /installed files may remain.*pi: command not found/);
		assert.deepEqual(packagesOf(settingsPath), ["./keep-me"]);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const keybindings = { matches: (data: string, action: string) => data === action } as never;

test("checklist: installed optional starts checked, packages outside the preset start unchecked", () => {
	const optional = [{ source: "npm:some-browser", label: "Some browser", description: "d" }];
	let result: PackageSelection | undefined | null = null;
	const component = new PackageChecklistComponent(
		optional,
		new Set(["npm:some-browser"]),
		[
			{ source: "npm:pi-btw", identity: "npm:pi-btw" },
			{ source: "./local-thing\u001b[2J", identity: "local:/x" },
		],
		theme,
		keybindings,
		() => {},
		(value) => {
			result = value;
		},
	);

	assert.deepEqual(component.getSelection(), { extraPackages: ["npm:some-browser"], keep: [] });
	const screen = component.render(200).join("\n");
	assert.match(screen, /\[ \] npm:pi-btw \(will be removed\)/);
	assert.ok(!screen.includes("\u001b[2J"), "settings.json text is sanitized before rendering");

	// Row order: browser, pi-btw, local-thing, Continue. Keep pi-btw, drop the browser.
	component.handleInput("tui.select.confirm");
	component.handleInput("tui.select.down");
	component.handleInput("tui.select.confirm");
	assert.match(component.render(200).join("\n"), /\[ \] Some browser .*\(installed, will be removed\)/);
	component.handleInput("tui.select.down");
	component.handleInput("tui.select.down");
	component.handleInput("tui.select.confirm");
	assert.deepEqual(result, { extraPackages: [], keep: ["npm:pi-btw"] });
});

test("checklist without optional packages shows only the packages outside the preset", () => {
	const component = new PackageChecklistComponent(
		OPTIONAL_PACKAGES,
		new Set(),
		[{ source: "npm:pi-statusline", identity: "npm:pi-statusline" }],
		theme,
		keybindings,
		() => {},
		() => {},
	);
	const screen = component.render(200);
	assert.equal(screen[0], "Packages not in the preset");
	assert.ok(!screen.join("\n").includes("Optional extensions"));
});
