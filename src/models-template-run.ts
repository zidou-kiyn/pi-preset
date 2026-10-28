/**
 * "Apply models template" flow, invoked from the /pi-preset menu.
 *
 * 1. Choose whether to fill in each provider's base URL and API key now.
 *    Empty input keeps the provider's current value from models.json, or the
 *    template placeholder when there is none.
 * 2. Choose the default provider and model (the template's are preselected).
 * 3. Review a redacted summary; nothing is written before Enter.
 * 4. models.json is replaced as a whole (backup: models.json.preset-bak) and
 *    defaultProvider/defaultModel (and unset template thinking levels) are merged into settings.json.
 *
 * TUI only: the API key prompt is a masked custom component.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	applyModelsTemplate,
	currentProviderValues,
	isEnvReference,
	type ModelsTemplate,
	type ModelsTemplateApplyResult,
	type ModelsTemplatePlan,
	loadModelsTemplate,
	normalizeBaseUrl,
	planModelsTemplate,
	type ProviderValues,
	readExistingModels,
	validateBaseUrl,
} from "./models-template.ts";
import { getModelsPath, getSettingsPath } from "./paths.ts";
import { messages } from "./pi-preset-messages.ts";
import type { FlowOutcome } from "./preset-menu.ts";
import {
	confirmLinesWithUi,
	type DescribedOption,
	promptMaskedWithUi,
	selectDescribedWithUi,
} from "./preset-ui.ts";

export interface ModelsTemplateIO {
	select(ctx: ExtensionCommandContext, title: string, options: readonly DescribedOption[]): Promise<string | undefined>;
	input(ctx: ExtensionCommandContext, title: string, placeholder: string): Promise<string | undefined>;
	secret(ctx: ExtensionCommandContext, title: string, hint: string): Promise<string | undefined>;
	confirm(ctx: ExtensionCommandContext, title: string, lines: readonly string[]): Promise<boolean>;
}

export interface ModelsTemplateDependencies {
	io?: Partial<ModelsTemplateIO>;
	getModelsPath?: () => string;
	getSettingsPath?: () => string;
	loadTemplate?: () => ModelsTemplate;
	apply?: (plan: ModelsTemplatePlan) => ModelsTemplateApplyResult;
	withMutationQueue?: <T>(path: string, fn: () => Promise<T>) => Promise<T>;
}

const DEFAULT_IO: ModelsTemplateIO = {
	select: selectDescribedWithUi,
	input: (ctx, title, placeholder) => ctx.ui.input(title, placeholder),
	secret: promptMaskedWithUi,
	confirm: (ctx, title, lines) => confirmLinesWithUi(ctx, title, lines, messages().modelsReviewSubtitle),
};

const FILL_NOW = "fill";
const KEEP = "keep";

function report(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.mode === "json" || ctx.mode === "print") {
		console.error(message);
		return;
	}
	ctx.ui.notify(message, type);
}

/** Value used when the user leaves a prompt empty: the current one, else the placeholder. */
function fallbackValues(template: ModelsTemplate, existing: ReturnType<typeof readExistingModels>) {
	const values: Record<string, ProviderValues> = {};
	for (const provider of template.providers) {
		const current = currentProviderValues(existing, provider.id);
		// A value left over from an earlier run that is still the template's
		// placeholder is a placeholder, not something the user configured.
		const baseUrl = current.baseUrl === provider.baseUrl ? undefined : current.baseUrl;
		const apiKey = current.apiKey === provider.apiKey ? undefined : current.apiKey;
		values[provider.id] = {
			baseUrl: baseUrl ?? provider.baseUrl,
			baseUrlSource: baseUrl === undefined ? "template" : "current",
			apiKey: apiKey ?? provider.apiKey,
			apiKeySource: apiKey === undefined ? "template" : "current",
		};
	}
	return values;
}

async function promptBaseUrl(
	ctx: ExtensionCommandContext,
	io: ModelsTemplateIO,
	providerId: string,
	fallback: ProviderValues,
): Promise<string | undefined> {
	const m = messages();
	const placeholder =
		fallback.baseUrlSource === "current" ? m.baseUrlKeepCurrent(fallback.baseUrl) : m.baseUrlKeepPlaceholder(fallback.baseUrl);
	for (;;) {
		const value = await io.input(ctx, m.baseUrlTitle(providerId), placeholder);
		if (value === undefined) return undefined;
		if (value.trim() === "") return "";
		const error = validateBaseUrl(value);
		if (error === undefined) return normalizeBaseUrl(value);
		ctx.ui.notify(error, "warning");
	}
}

function keyHint(fallback: ProviderValues): string {
	const m = messages();
	const empty =
		fallback.apiKeySource === "current"
			? isEnvReference(fallback.apiKey)
				? m.keyKeepReference(fallback.apiKey)
				: m.keyKeepCurrent
			: m.keyKeepPlaceholder(fallback.apiKey);
	return m.keyHint(empty);
}

function providerOptions(template: ModelsTemplate, values: Record<string, ProviderValues>): DescribedOption[] {
	const ordered = [
		...template.providers.filter((provider) => provider.id === template.defaultProvider),
		...template.providers.filter((provider) => provider.id !== template.defaultProvider),
	];
	return ordered.map((provider) => {
		const value = values[provider.id]!;
		const unfilled = value.baseUrlSource === "template" || value.apiKeySource === "template";
		return {
			id: provider.id,
			label: provider.id === template.defaultProvider ? `${provider.id}  ${messages().presetDefault}` : provider.id,
			description: [
				`${provider.api}: ${provider.models.map((model) => model.name).join(", ")}`,
				unfilled ? messages().stillPlaceholder : "",
			]
				.filter(Boolean)
				.join("\n"),
		};
	});
}

function modelOptions(template: ModelsTemplate, providerId: string): DescribedOption[] {
	const provider = template.providers.find((entry) => entry.id === providerId)!;
	const preferred = providerId === template.defaultProvider ? template.defaultModel : provider.models[0]?.id;
	const ordered = [
		...provider.models.filter((model) => model.id === preferred),
		...provider.models.filter((model) => model.id !== preferred),
	];
	return ordered.map((model) => ({
		id: model.id,
		label:
			model.id === template.defaultModel && providerId === template.defaultProvider
				? `${model.name}  ${messages().presetDefault}`
				: model.name,
		description: `${providerId}/${model.id}`,
	}));
}

/** Resolves "nothing-written" when the flow was cancelled or had nothing to write. */
export async function runPresetModelsTemplate(
	ctx: ExtensionCommandContext,
	dependencies: ModelsTemplateDependencies = {},
): Promise<FlowOutcome> {
	const m = messages();
	if (ctx.mode !== "tui") {
		report(ctx, m.modelsNeedsTui, "error");
		return "nothing-written";
	}
	const io: ModelsTemplateIO = { ...DEFAULT_IO, ...dependencies.io };

	let template: ModelsTemplate;
	try {
		template = (dependencies.loadTemplate ?? loadModelsTemplate)();
	} catch (error) {
		report(ctx, m.modelsLoadFailed((error as Error).message), "error");
		return "nothing-written";
	}

	const modelsPath = dependencies.getModelsPath?.() ?? getModelsPath();
	const settingsPath = dependencies.getSettingsPath?.() ?? getSettingsPath();
	const existing = readExistingModels(modelsPath);
	const values = fallbackValues(template, existing);

	const mode = await io.select(ctx, m.modelsTitle, [
		{
			id: FILL_NOW,
			label: m.modelsFillLabel,
			description: m.modelsFillHelp(template.providers.map((provider) => provider.id).join(", ")),
		},
		{
			id: KEEP,
			label: m.modelsKeepLabel,
			description: m.modelsKeepHelp,
		},
	]);
	if (mode === undefined) return "nothing-written";

	if (mode === FILL_NOW) {
		for (const provider of template.providers) {
			const fallback = values[provider.id]!;
			const baseUrl = await promptBaseUrl(ctx, io, provider.id, fallback);
			if (baseUrl === undefined) return "nothing-written";
			const apiKey = await io.secret(ctx, m.apiKeyTitle(provider.id), keyHint(fallback));
			if (apiKey === undefined) return "nothing-written";
			values[provider.id] = {
				baseUrl: baseUrl === "" ? fallback.baseUrl : baseUrl,
				baseUrlSource: baseUrl === "" ? fallback.baseUrlSource : "entered",
				apiKey: apiKey.trim() === "" ? fallback.apiKey : apiKey.trim(),
				apiKeySource: apiKey.trim() === "" ? fallback.apiKeySource : "entered",
			};
		}
	}

	const defaultProvider = await io.select(ctx, m.defaultProviderTitle, providerOptions(template, values));
	if (defaultProvider === undefined) return "nothing-written";
	const defaultModel = await io.select(ctx, m.defaultModelTitle(defaultProvider), modelOptions(template, defaultProvider));
	if (defaultModel === undefined) return "nothing-written";

	let plan: ModelsTemplatePlan;
	try {
		plan = planModelsTemplate({ template, values, defaultProvider, defaultModel, modelsPath, settingsPath, existing });
	} catch (error) {
		report(ctx, m.modelsPlanFailed((error as Error).message), "error");
		return "nothing-written";
	}

	if (!plan.modelsChanged && plan.settingsChanges.length === 0) {
		ctx.ui.notify(m.modelsAlreadyMatch, "info");
		return "nothing-written";
	}

	if (!(await io.confirm(ctx, m.modelsConfirmTitle, plan.lines))) {
		ctx.ui.notify(m.modelsCancelled, "info");
		return "nothing-written";
	}

	const queue = dependencies.withMutationQueue ?? withFileMutationQueue;
	const apply = dependencies.apply ?? applyModelsTemplate;
	let result: ModelsTemplateApplyResult;
	try {
		result = await queue(modelsPath, () => queue(settingsPath, async () => apply(plan)));
	} catch (error) {
		report(ctx, m.modelsWriteFailed((error as Error).message || m.modelsWriteFailedUnknown), "error");
		return "nothing-written";
	}

	const lines: string[] = [];
	if (result.modelsWritten) lines.push(m.modelsReplaced(plan.modelsExisted));
	if (result.settingsWritten) lines.push(m.modelsDefaultSet(`${defaultProvider}/${defaultModel}`));
	if (plan.placeholders.length > 0) {
		lines.push(
			m.modelsStillPlaceholders(
				plan.placeholders.map((entry) => `${entry.providerId} (${entry.fields.join(", ")})`).join("; "),
				modelsPath,
			),
		);
	}
	ctx.ui.notify(lines.join("\n") || m.modelsNothingWritten, plan.placeholders.length > 0 ? "warning" : "info");
	return result.modelsWritten || result.settingsWritten ? "done" : "nothing-written";
}
