import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { withPlatform } from "./platform-test-utils.ts";
import { apply } from "../src/apply.ts";
import { OPTIONAL_PACKAGES, PRESET_SELF_SOURCE, REQUIRED_PACKAGES } from "../src/manifest.ts";
import { PackageChecklistComponent, type PackageSelection } from "../src/optional-packages-ui.ts";
import { plan, type PlanOptions, readInstalledPackages, renderPlan, type Step } from "../src/plan.ts";

type RemoveStep = Extract<Step, { kind: "settings.packages.remove" }>;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "npm:@narumitw/pi-chrome-devtools";

async function inAgentDir<T>(agentDir: string, callback: () => T | Promise<T>): Promise<T> {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		// win32 keeps planFont() hermetic (note only, no font probe).
		return await withPlatform("win32", callback);
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
 * A machine mid-migration: every required package (one spelled with a
 * version), the optional Chrome package, the preset itself installed both ways,
 * and three packages the preset does not ship — one of them spelled twice.
 */
function writeMixedSettings(agentDir: string): string {
	const settingsPath = join(agentDir, "settings.json");
	writeFileSync(
		settingsPath,
		JSON.stringify({
			theme: "dark",
			packages: [
				...REQUIRED_PACKAGES.map((source) => (source === "npm:pi-wtf" ? "npm:pi-wtf@0.3.0" : source)),
				CHROME,
				`${PRESET_SELF_SOURCE}@main`,
				REPO_ROOT,
				"npm:pi-btw@0.6.1",
				{ source: "npm:pi-btw", extensions: [] },
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

test("manifest: the new btw is required, the old one and the preset itself are not", () => {
	assert.ok(REQUIRED_PACKAGES.includes("npm:@narumitw/pi-btw"));
	assert.ok(!REQUIRED_PACKAGES.includes("npm:pi-btw"));
	assert.ok(!REQUIRED_PACKAGES.includes(PRESET_SELF_SOURCE));
	assert.ok(OPTIONAL_PACKAGES.some((pkg) => pkg.source === CHROME));
});

test("installed packages are classified; the preset itself is never listed, however installed", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-preset-whitelist-test-"));
	try {
		writeMixedSettings(agentDir);
		const installed = await inAgentDir(agentDir, () => readInstalledPackages());
		assert.deepEqual([...installed.optional], [CHROME]);
		assert.deepEqual(
			installed.unlisted.map((pkg) => pkg.source),
			["npm:pi-btw@0.6.1", "./local-thing", "npm:pi-statusline"],
			"one row per identity, first spelling, required/optional/self excluded",
		);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("without a keep list (no checklist, e.g. RPC mode) nothing is removed", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-preset-whitelist-test-"));
	try {
		writeMixedSettings(agentDir);
		const result = await planIn(agentDir);
		assert.equal(removeStep(result.steps), undefined);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("everything outside required + checked + kept is removed once per identity, then converges", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-preset-whitelist-test-"));
	try {
		const settingsPath = writeMixedSettings(agentDir);
		// Chrome unchecked, only ./local-thing kept.
		const options: PlanOptions = { extraPackages: [], keep: ["./local-thing"] };

		const first = await planIn(agentDir, options);
		const remove = removeStep(first.steps);
		assert.ok(remove);
		assert.deepEqual(
			remove.remove.map((removal) => [removal.source, removal.reason]),
			[
				[CHROME, "optional, unchecked"],
				["npm:pi-btw@0.6.1", "not in preset, not kept"],
				["npm:pi-statusline", "not in preset, not kept"],
			],
		);
		assert.match(renderPlan(first), /- settings\.json packages\[\]: remove 3/);

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
		assert.deepEqual(uninstalled, [CHROME, "npm:pi-btw@0.6.1", "npm:pi-statusline"], "one pi remove per identity");
		assert.match(result.results[0]!.message, /installed files deleted/);

		const packages = packagesOf(settingsPath);
		const text = JSON.stringify(packages);
		assert.ok(!/"npm:pi-btw[@"]/.test(text), "every spelling of pi-btw is gone, including the object one");
		assert.ok(packages.includes("npm:@narumitw/pi-btw"));
		assert.ok(!text.includes("pi-statusline"));
		assert.ok(!text.includes("chrome-devtools"));
		for (const kept of ["npm:pi-wtf@0.3.0", `${PRESET_SELF_SOURCE}@main`, REPO_ROOT, "./local-thing"]) {
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
		writeFileSync(settingsPath, JSON.stringify({ packages: [...REQUIRED_PACKAGES, "npm:pi-btw"] }));

		const planned = await planIn(agentDir, { keep: [] });
		planned.steps = planned.steps.filter((step) => step.kind === "settings.packages.remove");
		const result = await apply(planned, {
			uninstall: async () => {
				throw new Error("pi: command not found");
			},
		});

		assert.ok(result.ok, "leftover files are a warning, not a failed step");
		assert.match(result.results[0]!.message, /installed files may remain.*pi: command not found/);
		assert.deepEqual(packagesOf(settingsPath), [...REQUIRED_PACKAGES]);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("checklist: installed optional starts checked, packages outside the preset start unchecked", () => {
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const keybindings = { matches: (data: string, action: string) => data === action } as never;
	let result: PackageSelection | undefined | null = null;
	const component = new PackageChecklistComponent(
		OPTIONAL_PACKAGES,
		new Set([CHROME]),
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

	assert.deepEqual(component.getSelection(), { extraPackages: [CHROME], keep: [] });
	const screen = component.render(200).join("\n");
	assert.match(screen, /\[ \] npm:pi-btw \(will be removed\)/);
	assert.ok(!screen.includes("\u001b[2J"), "settings.json text is sanitized before rendering");

	// Row order: Chrome, pi-btw, local-thing, Continue. Keep pi-btw, drop Chrome.
	component.handleInput("tui.select.confirm");
	component.handleInput("tui.select.down");
	component.handleInput("tui.select.confirm");
	assert.match(component.render(200).join("\n"), /\[ \] Chrome DevTools .*\(installed, will be removed\)/);
	component.handleInput("tui.select.down");
	component.handleInput("tui.select.down");
	component.handleInput("tui.select.confirm");
	assert.deepEqual(result, { extraPackages: [], keep: ["npm:pi-btw"] });
});
