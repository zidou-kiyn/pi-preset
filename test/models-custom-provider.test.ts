import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { runPresetModelsAdd } from "../src/models-add-run.ts";
import {
	COMPAT_FLAG_OPTIONS,
	compatFlagsForApi,
	CUSTOM_API_OPTIONS,
	THINKING_LEVELS,
	THINKING_PRESETS,
	type ThinkingLevelMap,
} from "../src/model-templates.ts";
import {
	buildCustomProviderCandidate,
	CUSTOM_PROVIDER_LABEL,
	type CustomProviderSpec,
	parseCostList,
	parseTokenCount,
	validateCustomModelId,
	validateCustomProviderSpec,
	wizardFamilyFromLabel,
	wizardFamilyOptions,
} from "../src/models-config.ts";
import { applyProviderPlan } from "../src/models-config-apply.ts";
import { CompatFlagsComponent, DescribedSelectComponent, type WizardTheme } from "../src/models-wizard-ui.ts";

const theme: WizardTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function keybindings(): KeybindingsManager {
	return new KeybindingsManager(TUI_KEYBINDINGS);
}

function runtimeKey(): string {
	return `runtime-${randomBytes(18).toString("hex")}`;
}

function baseSpec(): CustomProviderSpec {
	return {
		api: "openai-completions",
		compat: { supportsDeveloperRole: false, requiresToolResultName: true },
		models: [
			{
				id: "my/custom-model",
				name: "My Custom Model",
				input: ["text"],
				reasoning: true,
				contextWindow: 128_000,
				maxTokens: 8_192,
				cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
				thinkingLevelMap: THINKING_PRESETS.find((preset) => preset.id === "openai")!.map!,
			},
		],
	};
}

test("wizard family options append the custom entry and map back to the custom choice", () => {
	const options = wizardFamilyOptions();
	assert.equal(options.at(-1), CUSTOM_PROVIDER_LABEL);
	assert.equal(wizardFamilyFromLabel(CUSTOM_PROVIDER_LABEL), "custom");
	assert.equal(wizardFamilyFromLabel("OpenAI"), "openai");
	assert.equal(wizardFamilyFromLabel("nope"), undefined);
});

test("every custom API option and compat flag carries a non-empty description", () => {
	for (const option of CUSTOM_API_OPTIONS) {
		assert.equal(option.description.length > 20, true, option.id);
	}
	for (const flag of COMPAT_FLAG_OPTIONS) {
		assert.equal(flag.description.length > 20, true, flag.key);
		assert.equal(flag.apis.length > 0, true, flag.key);
	}
	for (const preset of THINKING_PRESETS) {
		assert.equal(preset.description.length > 20, true, preset.id);
		assert.equal(preset.reasoning, preset.map !== null, preset.id);
	}
	for (const api of CUSTOM_API_OPTIONS) {
		assert.equal(compatFlagsForApi(api.id).length > 0, true, api.id);
	}
});

test("the custom thinking level catalog covers all seven Pi levels in selector order", () => {
	assert.deepEqual(
		THINKING_LEVELS.map((info) => info.level),
		["off", "minimal", "low", "medium", "high", "xhigh", "max"],
	);
	for (const info of THINKING_LEVELS) {
		assert.equal(info.description.length > 20, true, info.level);
	}
	const presetKeys = Object.keys(THINKING_PRESETS.find((preset) => preset.id === "openai")!.map!).sort();
	assert.deepEqual(
		THINKING_LEVELS.map((info) => info.level).slice().sort(),
		presetKeys,
	);
});

test("token count and cost parsing accept human-friendly forms and reject junk", () => {
	assert.equal(parseTokenCount("128000"), 128_000);
	assert.equal(parseTokenCount(" 128k "), 128_000);
	assert.equal(parseTokenCount("1m"), 1_000_000);
	assert.equal(parseTokenCount("200,000"), 200_000);
	assert.equal(parseTokenCount("0"), undefined);
	assert.equal(parseTokenCount("-5"), undefined);
	assert.equal(parseTokenCount("1.5"), undefined);
	assert.equal(parseTokenCount("lots"), undefined);

	assert.deepEqual(parseCostList(""), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(parseCostList("2,10"), { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(parseCostList("2, 10, 0.2, 2.5"), { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
	assert.equal(parseCostList("2,10,0.2,2.5,9"), undefined);
	assert.equal(parseCostList("-1"), undefined);
	assert.equal(parseCostList("free"), undefined);
});

test("custom model IDs allow slashes and dots but reject empty and control characters", () => {
	assert.equal(validateCustomModelId("openrouter/anthropic/claude-3.5"), undefined);
	assert.equal(validateCustomModelId("   ") !== undefined, true);
	assert.equal(validateCustomModelId("bad\u0000id") !== undefined, true);
});

test("custom provider spec validation rejects broken schemas before any candidate exists", () => {
	assert.equal(validateCustomProviderSpec(baseSpec()), undefined);

	const wrongApi = { ...baseSpec(), api: "smoke-signals" };
	assert.match(validateCustomProviderSpec(wrongApi) ?? "", /unsupported API/);

	const empty = { ...baseSpec(), models: [] };
	assert.match(validateCustomProviderSpec(empty) ?? "", /at least one model/);

	const spec = baseSpec();
	const duplicate = { ...spec, models: [spec.models[0]!, { ...spec.models[0]! }] };
	assert.match(validateCustomProviderSpec(duplicate) ?? "", /duplicate model ID/);

	const overflow = { ...spec, models: [{ ...spec.models[0]!, maxTokens: 999_999_999 }] };
	assert.match(validateCustomProviderSpec(overflow) ?? "", /larger than its context window/);

	const reasoningWithoutMap = {
		...spec,
		models: [{ ...spec.models[0]!, thinkingLevelMap: undefined }],
	};
	assert.match(validateCustomProviderSpec(reasoningWithoutMap) ?? "", /no thinking level map/);

	const allUnavailable: ThinkingLevelMap = {
		off: null,
		minimal: null,
		low: null,
		medium: null,
		high: null,
		xhigh: null,
		max: null,
	};
	const uselessMap = { ...spec, models: [{ ...spec.models[0]!, thinkingLevelMap: allUnavailable }] };
	assert.match(validateCustomProviderSpec(uselessMap) ?? "", /every level unavailable/);
});

test("a fully custom thinking level map round-trips into the written provider", () => {
	const spec = baseSpec();
	const customMap: ThinkingLevelMap = {
		off: "none",
		minimal: null,
		low: "think-a-bit",
		medium: null,
		high: "think-hard",
		xhigh: null,
		max: "ultrathink",
	};
	const withCustomMap = { ...spec, models: [{ ...spec.models[0]!, thinkingLevelMap: customMap }] };
	const candidate = buildCustomProviderCandidate(withCustomMap, "https://relay.example.invalid/v1", runtimeKey());
	const model = (candidate.models as Record<string, unknown>[])[0]!;
	assert.deepEqual(model.thinkingLevelMap, customMap);
	assert.notEqual(model.thinkingLevelMap, customMap);
});

test("buildCustomProviderCandidate clones the spec and normalizes the base URL", () => {
	const key = runtimeKey();
	const spec = baseSpec();
	const candidate = buildCustomProviderCandidate(spec, " https://relay.example.invalid/v1 ", key);
	assert.equal(candidate.api, "openai-completions");
	assert.equal(candidate.baseUrl, "https://relay.example.invalid/v1");
	assert.equal(candidate.apiKey, key);
	assert.deepEqual(candidate.compat, { supportsDeveloperRole: false, requiresToolResultName: true });
	const model = (candidate.models as Record<string, unknown>[])[0]!;
	assert.equal(model.id, "my/custom-model");
	assert.deepEqual(model.thinkingLevelMap, THINKING_PRESETS.find((preset) => preset.id === "openai")!.map);
	assert.notEqual(model, spec.models[0]);

	const noReasoning = {
		...spec,
		models: [{ ...spec.models[0]!, reasoning: false, thinkingLevelMap: undefined }],
	};
	const plain = buildCustomProviderCandidate(noReasoning, "https://relay.example.invalid/v1", key);
	assert.equal("thinkingLevelMap" in (plain.models as Record<string, unknown>[])[0]!, false);

	assert.throws(
		() => buildCustomProviderCandidate({ ...spec, models: [] }, "https://relay.example.invalid/v1", key),
		/at least one model/,
	);
});

test("custom workflow writes the user-defined provider and cancellation writes nothing", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-preset-custom-test-"));
	try {
		const path = join(home, "models.json");
		const key = runtimeKey();
		const notifications: string[] = [];
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: { notify: (message: string) => notifications.push(message) },
		} as unknown as ExtensionCommandContext;

		let preview = "";
		await runPresetModelsAdd(ctx, {
			getModelsPath: () => path,
			selectFamily: async () => "custom",
			collectCustomProvider: async () => baseSpec(),
			input: async (_ctx, title) =>
				title === "Provider identifier" ? "my-relay" : "https://relay.example.invalid/v1",
			promptApiKey: async () => key,
			confirmDiff: async (_ctx, _title, diff) => {
				preview = diff.join("\n");
				return true;
			},
			apply: async (plan, targetPath) => applyProviderPlan(plan, targetPath),
			withMutationQueue: async (_targetPath, fn) => fn(),
		});

		const parsed = JSON.parse(readFileSync(path, "utf8"));
		const provider = parsed.providers["my-relay"];
		assert.equal(provider.api, "openai-completions");
		assert.equal(provider.apiKey, key);
		assert.deepEqual(provider.compat, { supportsDeveloperRole: false, requiresToolResultName: true });
		assert.deepEqual(
			provider.models.map((model: { id: string }) => model.id),
			["my/custom-model"],
		);
		assert.equal(preview.includes(key), false);
		assert.equal(notifications.join("\n").includes("no restart is required"), true);

		let applies = 0;
		await runPresetModelsAdd(ctx, {
			getModelsPath: () => path,
			selectFamily: async () => "custom",
			collectCustomProvider: async () => undefined,
			apply: async () => {
				applies++;
				throw new Error("must not apply");
			},
		});
		assert.equal(applies, 0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("described select shows the highlighted description and resolves the option id", () => {
	const manager = keybindings();
	let result: string | undefined;
	const component = new DescribedSelectComponent(
		"Select the API protocol",
		CUSTOM_API_OPTIONS.map((option) => ({ id: option.id, label: option.label, description: option.description })),
		theme,
		manager,
		() => {},
		(value) => {
			result = value;
		},
	);
	assert.equal(component.render(120).join("\n").includes("chat/completions"), true);
	component.handleInput("\x1b[B");
	assert.equal(component.render(120).join("\n").includes("/responses"), true);
	component.handleInput("\n");
	assert.equal(result, "openai-responses");

	let cancelled: string | undefined = "sentinel";
	const cancelTarget = new DescribedSelectComponent(
		"Select",
		[{ id: "a", label: "A", description: "first option description" }],
		theme,
		manager,
		() => {},
		(value) => {
			cancelled = value;
		},
	);
	cancelTarget.handleInput("\x1b");
	assert.equal(cancelled, undefined);
});

test("compat flags cycle default → true → false and only explicit states are emitted", () => {
	const manager = keybindings();
	const flags = compatFlagsForApi("openai-responses");
	let result: Record<string, boolean> | undefined;
	const component = new CompatFlagsComponent(flags, theme, manager, () => {}, (value) => {
		result = value;
	});
	assert.deepEqual(component.getResult(), {});
	component.handleInput("\n"); // first flag -> true
	component.handleInput("\x1b[B");
	component.handleInput("\n"); // second flag -> true
	component.handleInput("\n"); // second flag -> false
	assert.deepEqual(component.getResult(), { [flags[0]!.key]: true, [flags[1]!.key]: false });
	for (let index = 1; index < flags.length; index++) component.handleInput("\x1b[B"); // move to Continue
	component.handleInput("\n");
	assert.deepEqual(result, { [flags[0]!.key]: true, [flags[1]!.key]: false });
});

test("custom wizard components never render beyond the supplied terminal width", () => {
	const manager = keybindings();
	const select = new DescribedSelectComponent(
		"Select the API protocol with a deliberately long title",
		CUSTOM_API_OPTIONS.map((option) => ({ id: option.id, label: option.label, description: option.description })),
		theme,
		manager,
		() => {},
		() => {},
	);
	const compat = new CompatFlagsComponent(compatFlagsForApi("openai-completions"), theme, manager, () => {}, () => {});
	for (const width of [0, 1, 8, 20, 80]) {
		for (const component of [select, compat]) {
			for (const line of component.render(width)) assert.equal(visibleWidth(line) <= width, true, `${width}`);
		}
	}
});
