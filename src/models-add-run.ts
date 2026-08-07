import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { type FamilyId, getFamilyTemplate } from "./model-templates.ts";
import {
	buildCustomProviderCandidate,
	buildProviderCandidate,
	type CustomProviderSpec,
	type ModelsDocument,
	normalizeBaseUrl,
	type ProviderCandidate,
	planProviderUpsert,
	type ReadyProviderPlan,
	readModelsDocument,
	validateApiKey,
	validateBaseUrl,
	validateProviderId,
	type WizardFamilyChoice,
	wizardFamilyFromLabel,
	wizardFamilyOptions,
} from "./models-config.ts";
import { type ApplyModelsProviderResult, applyProviderPlan } from "./models-config-apply.ts";
import {
	collectCustomProviderWithUi,
	confirmProviderDiff,
	promptApiKeyWithUi,
	selectModelsWithUi,
} from "./models-wizard-ui.ts";
import { getModelsPath } from "./paths.ts";

export interface PresetModelsAddDependencies {
	getModelsPath?: () => string;
	selectFamily?: (ctx: ExtensionCommandContext) => Promise<WizardFamilyChoice | undefined>;
	selectModels?: (ctx: ExtensionCommandContext, family: FamilyId) => Promise<string[] | undefined>;
	collectCustomProvider?: (ctx: ExtensionCommandContext) => Promise<CustomProviderSpec | undefined>;
	input?: (ctx: ExtensionCommandContext, title: string, placeholder?: string) => Promise<string | undefined>;
	promptApiKey?: (ctx: ExtensionCommandContext) => Promise<string | undefined>;
	readDocument?: (path: string) => ModelsDocument;
	confirmDiff?: (ctx: ExtensionCommandContext, title: string, diff: readonly string[]) => Promise<boolean>;
	confirmReplacement?: (ctx: ExtensionCommandContext, providerId: string) => Promise<boolean>;
	apply?: (plan: ReadyProviderPlan, path: string) => Promise<ApplyModelsProviderResult> | ApplyModelsProviderResult;
	withMutationQueue?: <T>(path: string, fn: () => Promise<T>) => Promise<T>;
}

function report(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.mode === "json" || ctx.mode === "print") {
		console.error(message);
		return;
	}
	ctx.ui.notify(message, type);
}

async function defaultSelectFamily(ctx: ExtensionCommandContext): Promise<WizardFamilyChoice | undefined> {
	const label = await ctx.ui.select("Select a model family", wizardFamilyOptions());
	return label === undefined ? undefined : wizardFamilyFromLabel(label);
}

async function defaultSelectModels(ctx: ExtensionCommandContext, family: FamilyId): Promise<string[] | undefined> {
	return selectModelsWithUi(ctx, getFamilyTemplate(family));
}

function defaultInput(ctx: ExtensionCommandContext, title: string, placeholder?: string): Promise<string | undefined> {
	return ctx.ui.input(title, placeholder);
}

export async function runPresetModelsAdd(
	ctx: ExtensionCommandContext,
	dependencies: PresetModelsAddDependencies = {},
): Promise<void> {
	if (ctx.mode !== "tui") {
		report(ctx, "pi-preset models requires interactive TUI mode; no file was written", "error");
		return;
	}

	const selectFamily = dependencies.selectFamily ?? defaultSelectFamily;
	const selectedFamily = await selectFamily(ctx);
	if (selectedFamily === undefined) return;

	let customSpec: CustomProviderSpec | undefined;
	let selectedModelIds: string[] | undefined;
	if (selectedFamily === "custom") {
		const collectCustomProvider = dependencies.collectCustomProvider ?? collectCustomProviderWithUi;
		customSpec = await collectCustomProvider(ctx);
		if (customSpec === undefined) return;
		if (customSpec.models.length === 0) {
			ctx.ui.notify("Define at least one model; nothing was written", "warning");
			return;
		}
	} else {
		const selectModels = dependencies.selectModels ?? defaultSelectModels;
		selectedModelIds = await selectModels(ctx, selectedFamily);
		if (selectedModelIds === undefined) return;
		if (selectedModelIds.length === 0) {
			ctx.ui.notify("Select at least one model; nothing was written", "warning");
			return;
		}
	}

	const input = dependencies.input ?? defaultInput;
	const providerId = await input(ctx, "Provider identifier", "letters, numbers, dot, underscore, or hyphen");
	if (providerId === undefined) return;
	const providerIdError = validateProviderId(providerId);
	if (providerIdError) {
		ctx.ui.notify(providerIdError, "error");
		return;
	}

	const baseUrl = await input(ctx, "Base URL", "https://api.example.invalid/v1");
	if (baseUrl === undefined) return;
	const baseUrlError = validateBaseUrl(baseUrl);
	if (baseUrlError) {
		ctx.ui.notify(baseUrlError, "error");
		return;
	}

	const modelsPath = dependencies.getModelsPath?.() ?? getModelsPath();
	let document: ModelsDocument;
	try {
		document = (dependencies.readDocument ?? readModelsDocument)(modelsPath);
	} catch (error) {
		report(ctx, `pi-preset models: cannot prepare models.json: ${(error as Error).message}`, "error");
		return;
	}

	const promptApiKey = dependencies.promptApiKey ?? promptApiKeyWithUi;
	const apiKey = await promptApiKey(ctx);
	if (apiKey === undefined) return;
	const apiKeyError = validateApiKey(apiKey);
	if (apiKeyError) {
		ctx.ui.notify(apiKeyError, "error");
		return;
	}

	let candidate: ProviderCandidate;
	try {
		candidate =
			selectedFamily === "custom"
				? buildCustomProviderCandidate(customSpec!, normalizeBaseUrl(baseUrl), apiKey)
				: buildProviderCandidate(selectedFamily, selectedModelIds!, normalizeBaseUrl(baseUrl), apiKey);
	} catch (error) {
		ctx.ui.notify((error as Error).message, "error");
		return;
	}

	const plan = planProviderUpsert(document.data, providerId, candidate, document.targetPath);
	if (plan.status === "blocked") {
		ctx.ui.notify(plan.message, "error");
		return;
	}
	if (plan.status === "already-configured") {
		ctx.ui.notify(`Provider "${providerId}" is already configured; nothing was written`, "info");
		return;
	}

	const confirmDiff = dependencies.confirmDiff ?? confirmProviderDiff;
	const confirmed = await confirmDiff(
		ctx,
		plan.status === "replace" ? `Preview replacement for ${providerId}` : `Preview provider ${providerId}`,
		plan.diff,
	);
	if (!confirmed) {
		ctx.ui.notify("pi-preset models: cancelled, nothing was written", "info");
		return;
	}

	if (plan.status === "replace") {
		const confirmReplacement =
			dependencies.confirmReplacement ??
			(async (replacementCtx: ExtensionCommandContext, replacementId: string) =>
				replacementCtx.ui.confirm(
					"Replace existing provider?",
					`Provider "${replacementId}" already exists and differs. Replace that provider object as a unit?`,
				));
		if (!(await confirmReplacement(ctx, providerId))) {
			ctx.ui.notify("pi-preset models: replacement cancelled, nothing was written", "info");
			return;
		}
	}

	const apply = dependencies.apply ?? applyProviderPlan;
	const queue = dependencies.withMutationQueue ?? withFileMutationQueue;
	try {
		const result = await queue(modelsPath, async () => apply(plan, modelsPath));
		if (!result.changed) {
			ctx.ui.notify(`Provider "${providerId}" is already configured; nothing was written`, "info");
			return;
		}
		ctx.ui.notify(
			`models.json updated for "${providerId}". Open /model to reload the selected models; no restart is required.`,
			"info",
		);
	} catch (error) {
		report(ctx, `pi-preset models: ${(error as Error).message || "write failed"}`, "error");
	}
}
