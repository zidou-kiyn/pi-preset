import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import {
	isEnvReference,
	isPlaceholderBaseUrl,
	loadModelsTemplate,
	normalizeBaseUrl,
	validateBaseUrl,
} from "../src/models-template.ts";
import { type ModelsTemplateIO, runPresetModelsTemplate } from "../src/models-template-run.ts";
import { MaskedInputComponent, type PresetTheme } from "../src/preset-ui.ts";
import { assertModeOnPosix } from "./platform-test-utils.ts";

const theme: PresetTheme = { fg: (_color, text) => text, bold: (text) => text };

function makeDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-preset-models-template-test-"));
}

function runtimeKey(): string {
	return `runtime-${randomBytes(18).toString("hex")}`;
}

function makeContext(mode: "tui" | "rpc" | "print", notifications: string[]) {
	return {
		mode,
		hasUI: mode !== "print",
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			custom: async () => undefined,
			notify: (message: string) => notifications.push(message),
		},
	} as unknown as ExtensionCommandContext;
}

interface Script {
	/** Answers for io.select, in call order. */
	selects: (string | undefined)[];
	/** Answers for io.input keyed by title. */
	inputs?: Record<string, string | undefined>;
	/** Answers for io.secret keyed by title. */
	secrets?: Record<string, string | undefined>;
	confirm?: boolean;
}

interface Recorded {
	confirmLines: string[][];
	selectTitles: string[];
	selectOptions: string[][];
}

function scriptedIo(script: Script, recorded: Recorded): ModelsTemplateIO {
	const selects = [...script.selects];
	return {
		select: async (_ctx, title, options) => {
			recorded.selectTitles.push(title);
			recorded.selectOptions.push(options.map((option) => option.id));
			return selects.shift();
		},
		input: async (_ctx, title) => script.inputs?.[title] ?? "",
		secret: async (_ctx, title) => script.secrets?.[title] ?? "",
		confirm: async (_ctx, _title, lines) => {
			recorded.confirmLines.push([...lines]);
			return script.confirm ?? true;
		},
	};
}

async function run(dir: string, script: Script, mode: "tui" | "rpc" | "print" = "tui") {
	const notifications: string[] = [];
	const recorded: Recorded = { confirmLines: [], selectTitles: [], selectOptions: [] };
	await runPresetModelsTemplate(makeContext(mode, notifications), {
		io: scriptedIo(script, recorded),
		getModelsPath: () => join(dir, "models.json"),
		getSettingsPath: () => join(dir, "settings.json"),
		withMutationQueue: async (_path, fn) => fn(),
	});
	return { notifications, recorded };
}

function readJson(path: string) {
	return JSON.parse(readFileSync(path, "utf8"));
}

test("the shipped template has only placeholder endpoints and env-var keys, and valid defaults", () => {
	const template = loadModelsTemplate();
	assert.deepEqual(
		template.providers.map((provider) => provider.id),
		["openai-proxy", "anthropic-proxy", "deepseek-proxy"],
	);
	for (const provider of template.providers) {
		assert.ok(isPlaceholderBaseUrl(provider.baseUrl), provider.baseUrl);
		assert.ok(isEnvReference(provider.apiKey), provider.id);
	}
	assert.equal(template.defaultProvider, "anthropic-proxy");
	assert.equal(template.defaultModel, "claude-opus-5-5");
	assert.deepEqual(template.modelThinkingLevels, { "anthropic-proxy/claude-fable-5-1": "high" });
});

test("base URLs are validated and trailing slashes dropped", () => {
	assert.equal(validateBaseUrl("https://relay.example.com/v1"), undefined);
	assert.ok(validateBaseUrl("ftp://relay.example.com"));
	assert.ok(validateBaseUrl("https://user:pw@relay.example.com"));
	assert.ok(validateBaseUrl("https://relay.example.com/v1?x=1"));
	assert.equal(normalizeBaseUrl(" https://relay.example.com/v1/ "), "https://relay.example.com/v1");
	assert.equal(normalizeBaseUrl("http://localhost:8080"), "http://localhost:8080");
});

test("filling every provider replaces models.json, sets defaults, and never shows the key", async () => {
	const dir = makeDir();
	try {
		const key = runtimeKey();
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark", packages: ["npm:x"] }));
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { legacy: { baseUrl: "https://old.test" } } }));
		chmodSync(join(dir, "models.json"), 0o644);

		const { notifications, recorded } = await run(dir, {
			selects: ["fill", "openai-proxy", "gpt-6.1-sol"],
			inputs: {
				"openai-proxy: base URL": "https://relay.example.com/v1/",
				"anthropic-proxy: base URL": "https://relay.example.com",
			},
			secrets: { "openai-proxy: API key": key, "anthropic-proxy: API key": "$MY_CLAUDE_KEY" },
		});

		const models = readJson(join(dir, "models.json"));
		assert.equal(models.providers.legacy, undefined);
		assert.equal(models.providers["openai-proxy"].baseUrl, "https://relay.example.com/v1");
		assert.equal(models.providers["openai-proxy"].apiKey, key);
		assert.equal(models.providers["anthropic-proxy"].apiKey, "$MY_CLAUDE_KEY");
		// Left empty: the placeholders stay.
		assert.ok(isPlaceholderBaseUrl(models.providers["deepseek-proxy"].baseUrl));
		assert.equal(models.providers["deepseek-proxy"].apiKey, "$DEEPSEEK_PROXY_API_KEY");
		// Everything except baseUrl/apiKey is the template verbatim.
		const template = loadModelsTemplate().document as { providers: Record<string, { models: unknown }> };
		assert.deepEqual(models.providers["anthropic-proxy"].models, template.providers["anthropic-proxy"]!.models);
		assertModeOnPosix(join(dir, "models.json"), 0o600);
		assert.ok(existsSync(join(dir, "models.json.preset-bak")));

		const settings = readJson(join(dir, "settings.json"));
		assert.deepEqual(settings, {
			theme: "dark",
			packages: ["npm:x"],
			defaultProvider: "openai-proxy",
			defaultModel: "gpt-6.1-sol",
			modelThinkingLevels: { "anthropic-proxy/claude-fable-5-1": "high" },
		});

		// The template's default is offered first, for provider and model alike.
		assert.equal(recorded.selectOptions[1]![0], "anthropic-proxy");
		const shown = [...recorded.confirmLines.flat(), ...notifications].join("\n");
		assert.ok(!shown.includes(key), "API key leaked into the UI");
		assert.match(shown, /provider legacy \(not in the template, removed\)/);
		assert.match(shown, /deepseek-proxy: baseUrl and apiKey still a placeholder/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the template's default model is preselected for the template's default provider", async () => {
	const dir = makeDir();
	try {
		const { recorded } = await run(dir, { selects: ["keep", "anthropic-proxy", undefined] });
		assert.equal(recorded.selectOptions[2]![0], "claude-opus-5-5");
		assert.ok(!existsSync(join(dir, "models.json")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("keeping values preserves the current endpoint and key of providers already configured", async () => {
	const dir = makeDir();
	try {
		const key = runtimeKey();
		writeFileSync(
			join(dir, "models.json"),
			`{\n  // comment\n  "providers": { "anthropic-proxy": { "baseUrl": "https://mine.example.com", "apiKey": "${key}", }, },\n}\n`,
		);
		chmodSync(join(dir, "models.json"), 0o600);

		const { recorded } = await run(dir, { selects: ["keep", "anthropic-proxy", "claude-opus-5-5"] });
		const models = readJson(join(dir, "models.json"));
		assert.equal(models.providers["anthropic-proxy"].baseUrl, "https://mine.example.com");
		assert.equal(models.providers["anthropic-proxy"].apiKey, key);
		assert.ok(isPlaceholderBaseUrl(models.providers["openai-proxy"].baseUrl));
		assert.ok(!recorded.confirmLines.flat().join("\n").includes(key));
		assert.match(recorded.confirmLines.flat().join("\n"), /<current key, hidden>/);

		// A second identical run is a no-op: no prompt, no write.
		const before = readFileSync(join(dir, "models.json"), "utf8");
		const again = await run(dir, { selects: ["keep", "anthropic-proxy", "claude-opus-5-5"] });
		assert.equal(again.recorded.confirmLines.length, 0);
		assert.match(again.notifications.join("\n"), /already match/);
		assert.equal(readFileSync(join(dir, "models.json"), "utf8"), before);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("declining the confirmation or pressing Escape writes nothing", async () => {
	const dir = makeDir();
	try {
		writeFileSync(join(dir, "settings.json"), "{}");
		await run(dir, { selects: ["keep", "anthropic-proxy", "claude-opus-5-5"], confirm: false });
		await run(dir, { selects: [undefined] });
		await run(dir, { selects: ["fill"], secrets: { "openai-proxy: API key": undefined } });
		assert.ok(!existsSync(join(dir, "models.json")));
		assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), "{}");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an unparseable settings.json blocks the whole write", async () => {
	const dir = makeDir();
	try {
		writeFileSync(join(dir, "settings.json"), "{ not json");
		const { notifications } = await run(dir, { selects: ["keep", "anthropic-proxy", "claude-opus-5-5"] });
		assert.ok(!existsSync(join(dir, "models.json")));
		assert.match(notifications.join("\n"), /nothing was written/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("non-TUI modes refuse without writing", async () => {
	const dir = makeDir();
	try {
		const { notifications } = await run(dir, { selects: ["keep", "anthropic-proxy", "claude-opus-5-5"] }, "rpc");
		assert.match(notifications.join("\n"), /requires interactive TUI/);
		assert.ok(!existsSync(join(dir, "models.json")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the masked input never renders what was typed", () => {
	let result: string | undefined;
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
	const component = new MaskedInputComponent("API key", theme, keybindings, () => {}, (value) => {
		result = value;
	});
	const key = runtimeKey();
	for (const char of key) component.handleInput(char);
	assert.ok(!component.render(80).join("\n").includes(key));
	component.handleInput("\r");
	assert.equal(result, key);
});

test("template thinking levels fill only models without one and never replace the user's", async () => {
	const dir = makeDir();
	try {
		const mine = { "anthropic-proxy/claude-fable-5-1": "xhigh", "openai-proxy/gpt-6-astra": "low" };
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ modelThinkingLevels: mine }));
		const first = await run(dir, { selects: ["keep", "anthropic-proxy", "claude-opus-5-5"] });
		assert.deepEqual(readJson(join(dir, "settings.json")).modelThinkingLevels, mine);
		assert.ok(!first.recorded.confirmLines.flat().some((line) => line.includes("modelThinkingLevels")));

		writeFileSync(join(dir, "settings.json"), JSON.stringify({ modelThinkingLevels: { "openai-proxy/gpt-6-astra": "low" } }));
		const second = await run(dir, { selects: ["keep", "anthropic-proxy", "claude-opus-5-5"] });
		assert.deepEqual(readJson(join(dir, "settings.json")).modelThinkingLevels, {
			"openai-proxy/gpt-6-astra": "low",
			"anthropic-proxy/claude-fable-5-1": "high",
		});
		assert.ok(
			second.recorded.confirmLines.flat().some((line) => line.includes('modelThinkingLevels.anthropic-proxy/claude-fable-5-1: unset -> "high"')),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a template thinking level the model cannot take is rejected", () => {
	const dir = makeDir();
	try {
		const models = loadModelsTemplate().document;
		writeFileSync(join(dir, "models.json"), JSON.stringify(models));
		const write = (levels: Record<string, string>) =>
			writeFileSync(
				join(dir, "settings.json"),
				JSON.stringify({ defaultProvider: "anthropic-proxy", defaultModel: "claude-opus-5-5", modelThinkingLevels: levels }),
			);
		write({ "anthropic-proxy/claude-opus-4-6": "xhigh" });
		assert.throws(() => loadModelsTemplate(dir), /not supported/);
		write({ "anthropic-proxy/claude-nope": "high" });
		assert.throws(() => loadModelsTemplate(dir), /no such model/);
		write({ "anthropic-proxy/claude-fable-5-1": "turbo" });
		assert.throws(() => loadModelsTemplate(dir), /not a thinking level/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
