import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { type PresetModelsAddDependencies, runPresetModelsAdd } from "../extensions/preset-models-add.ts";
import { FAMILY_TEMPLATES } from "../src/model-templates.ts";
import { buildProviderCandidate } from "../src/models-config.ts";
import { applyProviderPlan } from "../src/models-config-apply.ts";
import {
	DiffConfirmationComponent,
	MaskedInputComponent,
	ModelChecklistComponent,
	type WizardTheme,
} from "../src/models-wizard-ui.ts";

function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "pi-preset-workflow-test-"));
}

function cleanup(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

function runtimeKey(): string {
	return `runtime-${randomBytes(18).toString("hex")}`;
}

function secureWrite(path: string, content: string): void {
	writeFileSync(path, content);
	chmodSync(path, 0o600);
}

function makeContext(mode: "tui" | "rpc" | "json" | "print", notifications: string[]) {
	return {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			custom: async () => undefined,
			notify: (message: string) => notifications.push(message),
		},
	} as unknown as ExtensionCommandContext;
}

function makeDependencies(
	path: string,
	key: string,
	options: {
		confirmDiff?: boolean;
		confirmReplacement?: boolean;
		selectedModels?: string[];
		providerId?: string;
		baseUrl?: string;
		applyCalls?: { count: number };
	} = {},
): PresetModelsAddDependencies {
	return {
		getModelsPath: () => path,
		selectFamily: async () => "openai",
		selectModels: async () => options.selectedModels ?? ["gpt-5.6-sol"],
		input: async (_ctx, title) =>
			title === "Provider identifier"
				? (options.providerId ?? "provider-id")
				: (options.baseUrl ?? "https://api.example.invalid/v1"),
		promptApiKey: async () => key,
		confirmDiff: async () => options.confirmDiff ?? true,
		confirmReplacement: async () => options.confirmReplacement ?? true,
		apply: async (plan, targetPath) => {
			if (options.applyCalls) options.applyCalls.count++;
			return applyProviderPlan(plan, targetPath);
		},
		withMutationQueue: async (_targetPath, fn) => fn(),
	};
}

const theme: WizardTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function keybindings(): KeybindingsManager {
	return new KeybindingsManager(TUI_KEYBINDINGS);
}

test("every family checklist starts empty and cannot continue without an explicit selection", () => {
	const manager = keybindings();
	for (const family of Object.values(FAMILY_TEMPLATES)) {
		const initial = new ModelChecklistComponent(
			family,
			theme,
			manager,
			() => {},
			() => {},
		);
		assert.deepEqual(initial.getSelectedModelIds(), []);
		assert.equal(initial.isContinueEnabled(), false);
	}
	let result: string[] | undefined = ["unexpected"];
	const component = new ModelChecklistComponent(
		FAMILY_TEMPLATES.openai,
		theme,
		manager,
		() => {},
		(value) => {
			result = value;
		},
	);
	assert.deepEqual(component.getSelectedModelIds(), []);
	assert.equal(component.isContinueEnabled(), false);
	component.handleInput("\x1b[6~");
	component.handleInput("\n");
	assert.deepEqual(component.getSelectedModelIds(), []);
	assert.deepEqual(result, ["unexpected"]);
	component.handleInput("\x1b[A");
	component.handleInput("\n");
	assert.deepEqual(component.getSelectedModelIds(), ["gpt-5.6-luna"]);
	assert.equal(component.isContinueEnabled(), true);
	component.handleInput("\x1b[6~");
	component.handleInput("\n");
	assert.deepEqual(result, ["gpt-5.6-luna"]);

	let orderedResult: string[] | undefined;
	const ordered = new ModelChecklistComponent(
		FAMILY_TEMPLATES.openai,
		theme,
		manager,
		() => {},
		(value) => {
			orderedResult = value;
		},
	);
	ordered.handleInput("\x1b[6~");
	ordered.handleInput("\x1b[A");
	ordered.handleInput("\n");
	ordered.handleInput("\x1b[5~");
	ordered.handleInput("\n");
	ordered.handleInput("\x1b[6~");
	ordered.handleInput("\n");
	assert.deepEqual(orderedResult, ["gpt-5.6-sol", "gpt-5.6-luna"]);
});

test("masked input uses a fixed mask, never renders the value, and clears its editor before resolving", () => {
	const manager = keybindings();
	const key = runtimeKey();
	const renderFor = (value: string): string => {
		const component = new MaskedInputComponent(
			"API key",
			theme,
			manager,
			() => {},
			() => {},
		);
		component.handleInput(value);
		return component.render(80).join("\n");
	};
	assert.equal(renderFor(key.slice(0, 3)), renderFor(key));

	let result: string | undefined;
	const component = new MaskedInputComponent(
		"API key",
		theme,
		manager,
		() => {},
		(value) => {
			result = value;
		},
	);
	component.handleInput(key);
	const rendered = component.render(80).join("\n");
	assert.equal(rendered.includes(key), false);
	assert.equal(rendered.includes("••••••••"), true);
	component.handleInput("\n");
	assert.equal(result, key);
	assert.equal(component.render(80).join("\n").includes(key), false);
	assert.equal(component.render(80).join("\n").includes("••••••••"), false);
});

test("diff confirmation scrolls with injected bindings and cancels", () => {
	const manager = keybindings();
	let result: boolean | undefined;
	const lines = Array.from({ length: 20 }, (_unused, index) => `+ line-${index}-<redacted-supplied>`);
	const component = new DiffConfirmationComponent(
		"Preview",
		lines,
		theme,
		manager,
		() => {},
		(value) => {
			result = value;
		},
	);
	assert.equal(component.getScrollOffset(), 0);
	component.handleInput("\x1b[6~");
	assert.equal(component.getScrollOffset() > 0, true);
	component.handleInput("\x1b");
	assert.equal(result, false);
});

test("successful workflow writes the selected bundle and never reports the API key", async () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		const key = runtimeKey();
		const notifications: string[] = [];
		const ctx = makeContext("tui", notifications);
		const dependencies = makeDependencies(path, key);
		let preview = "";
		dependencies.confirmDiff = async (_ctx, _title, diff) => {
			preview = diff.join("\n");
			return true;
		};
		await runPresetModelsAdd(ctx, dependencies);
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(parsed.providers["provider-id"].api, "openai-responses");
		assert.deepEqual(
			parsed.providers["provider-id"].models.map((model: { id: string }) => model.id),
			["gpt-5.6-sol"],
		);
		assert.equal(parsed.providers["provider-id"].apiKey, key);
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.equal(preview.includes(key), false);
		assert.equal(notifications.join("\n").includes(key), false);
		assert.equal(notifications.join("\n").includes("no restart is required"), true);
	} finally {
		cleanup(home);
	}
});

test("cancellation before apply leaves mtime and bytes unchanged", async () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		secureWrite(path, JSON.stringify({ providers: { sibling: { keep: true } } }));
		const beforeBytes = readFileSync(path);
		const beforeMtime = statSync(path).mtimeMs;
		for (const variant of ["family", "model", "id", "url", "key", "preview"] as const) {
			const notifications: string[] = [];
			const ctx = makeContext("tui", notifications);
			const calls = { count: 0 };
			const base = makeDependencies(path, runtimeKey(), { applyCalls: calls });
			const dependencies: PresetModelsAddDependencies =
				variant === "family"
					? { ...base, selectFamily: async () => undefined }
					: variant === "model"
						? { ...base, selectModels: async () => undefined }
						: variant === "id"
							? {
									...base,
									input: async (_ctx, title) =>
										title === "Provider identifier" ? undefined : "https://api.example.invalid/v1",
								}
							: variant === "url"
								? {
										...base,
										input: async (_ctx, title) =>
											title === "Provider identifier" ? "provider-id" : undefined,
									}
								: variant === "key"
									? { ...base, promptApiKey: async () => undefined }
									: { ...base, confirmDiff: async () => false };
			await runPresetModelsAdd(ctx, dependencies);
			assert.equal(calls.count, 0, variant);
		}
		assert.deepEqual(readFileSync(path), beforeBytes);
		assert.equal(statSync(path).mtimeMs, beforeMtime);
	} finally {
		cleanup(home);
	}
});

test("replacement needs a second confirmation and decline performs no write", async () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		const oldKey = runtimeKey();
		const old = buildProviderCandidate("openai", ["gpt-5.6-terra"], "https://old.example.invalid/v1", oldKey);
		secureWrite(path, JSON.stringify({ providers: { "provider-id": old } }));
		const beforeBytes = readFileSync(path);
		const beforeMtime = statSync(path).mtimeMs;
		const calls = { count: 0 };
		const notifications: string[] = [];
		await runPresetModelsAdd(
			makeContext("tui", notifications),
			makeDependencies(path, runtimeKey(), { confirmReplacement: false, applyCalls: calls }),
		);
		assert.equal(calls.count, 0);
		assert.deepEqual(readFileSync(path), beforeBytes);
		assert.equal(statSync(path).mtimeMs, beforeMtime);
		assert.equal(notifications.join("\n").includes("replacement cancelled"), true);
	} finally {
		cleanup(home);
	}
});

test("permission and parse blockers occur before the masked key prompt", async () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		secureWrite(path, "{ not json");
		let keyPrompts = 0;
		const notifications: string[] = [];
		const dependencies = makeDependencies(path, runtimeKey());
		dependencies.promptApiKey = async () => {
			keyPrompts++;
			return runtimeKey();
		};
		await runPresetModelsAdd(makeContext("tui", notifications), dependencies);
		assert.equal(keyPrompts, 0);
		assert.equal(notifications.join("\n").includes("not valid JSON"), true);
	} finally {
		cleanup(home);
	}
});

test("non-TUI modes report the guard and do not read, prompt, or write", async () => {
	const diagnostics: string[] = [];
	const originalConsoleError = console.error;
	console.error = (...args: unknown[]) => diagnostics.push(args.map(String).join(" "));
	try {
		for (const mode of ["rpc", "json", "print"] as const) {
			const notifications: string[] = [];
			let reads = 0;
			let applies = 0;
			const ctx = makeContext(mode, notifications);
			await runPresetModelsAdd(ctx, {
				readDocument: () => {
					reads++;
					throw new Error("must not read");
				},
				apply: async () => {
					applies++;
					throw new Error("must not apply");
				},
			});
			assert.equal(reads, 0);
			assert.equal(applies, 0);
			if (mode === "rpc") {
				assert.equal(
					notifications.some((message) => message.includes("requires interactive TUI mode")),
					true,
				);
			}
		}
	} finally {
		console.error = originalConsoleError;
	}
	assert.equal(diagnostics.length, 2);
	assert.equal(
		diagnostics.every((message) => message.includes("requires interactive TUI mode")),
		true,
	);
});

test("already configured workflow skips confirmation and apply", async () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		const key = runtimeKey();
		const provider = buildProviderCandidate("openai", ["gpt-5.6-sol"], "https://api.example.invalid/v1", key);
		secureWrite(path, JSON.stringify({ providers: { "provider-id": provider } }));
		let confirms = 0;
		let applies = 0;
		const notifications: string[] = [];
		const dependencies = makeDependencies(path, key);
		dependencies.confirmDiff = async () => {
			confirms++;
			return true;
		};
		dependencies.apply = async () => {
			applies++;
			throw new Error("must not apply");
		};
		await runPresetModelsAdd(makeContext("tui", notifications), dependencies);
		assert.equal(confirms, 0);
		assert.equal(applies, 0);
		assert.equal(notifications.join("\n").includes("already configured"), true);
	} finally {
		cleanup(home);
	}
});

test("empty selection stops before provider inputs or masked credential entry", async () => {
	const notifications: string[] = [];
	let inputs = 0;
	let keyPrompts = 0;
	await runPresetModelsAdd(makeContext("tui", notifications), {
		selectFamily: async () => "anthropic",
		selectModels: async () => [],
		input: async () => {
			inputs++;
			return undefined;
		},
		promptApiKey: async () => {
			keyPrompts++;
			return undefined;
		},
	});
	assert.equal(inputs, 0);
	assert.equal(keyPrompts, 0);
	assert.equal(notifications.join("\n").includes("at least one model"), true);
});

test("invalid URL and empty API key fail before preview or write", async () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		for (const variant of ["url", "key"] as const) {
			const notifications: string[] = [];
			let keyPrompts = 0;
			let confirms = 0;
			let applies = 0;
			const dependencies = makeDependencies(path, runtimeKey(), {
				baseUrl: variant === "url" ? "not-a-url" : undefined,
			});
			dependencies.promptApiKey = async () => {
				keyPrompts++;
				return variant === "key" ? "   " : runtimeKey();
			};
			dependencies.confirmDiff = async () => {
				confirms++;
				return true;
			};
			dependencies.apply = async () => {
				applies++;
				throw new Error("must not apply");
			};
			await runPresetModelsAdd(makeContext("tui", notifications), dependencies);
			assert.equal(keyPrompts, variant === "url" ? 0 : 1);
			assert.equal(confirms, 0);
			assert.equal(applies, 0);
			assert.equal(existsSync(path), false);
			assert.equal(existsSync(`${path}.preset-bak`), false);
		}
	} finally {
		cleanup(home);
	}
});

test("broad permissions block before masked credential entry", async () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		secureWrite(path, '{ "providers": {} }');
		chmodSync(path, 0o640);
		let keyPrompts = 0;
		const notifications: string[] = [];
		const dependencies = makeDependencies(path, runtimeKey());
		dependencies.promptApiKey = async () => {
			keyPrompts++;
			return runtimeKey();
		};
		await runPresetModelsAdd(makeContext("tui", notifications), dependencies);
		assert.equal(keyPrompts, 0);
		assert.equal(notifications.join("\n").includes("chmod 600"), true);
		assert.equal(existsSync(`${path}.preset-bak`), false);
	} finally {
		cleanup(home);
	}
});

test("write errors never include the supplied key in notifications", async () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		const key = runtimeKey();
		const notifications: string[] = [];
		const dependencies = makeDependencies(path, key);
		dependencies.apply = async () => {
			throw new Error("simulated write failure");
		};
		await runPresetModelsAdd(makeContext("tui", notifications), dependencies);
		assert.equal(notifications.join("\n").includes(key), false);
		assert.equal(existsSync(path), false);
	} finally {
		cleanup(home);
	}
});

test("wizard components never render beyond the supplied terminal width", () => {
	const manager = keybindings();
	const checklist = new ModelChecklistComponent(
		FAMILY_TEMPLATES.anthropic,
		theme,
		manager,
		() => {},
		() => {},
	);
	const masked = new MaskedInputComponent(
		"API key",
		theme,
		manager,
		() => {},
		() => {},
	);
	masked.handleInput(runtimeKey());
	const diff = new DiffConfirmationComponent(
		"Preview a deliberately long provider diff title",
		[`+ ${"long-value-".repeat(20)}`],
		theme,
		manager,
		() => {},
		() => {},
	);
	for (const width of [0, 1, 8, 20, 80]) {
		for (const component of [checklist, masked, diff]) {
			for (const line of component.render(width)) assert.equal(visibleWidth(line) <= width, true);
		}
	}
});
