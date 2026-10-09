/**
 * models.json template.
 *
 * The preset's provider catalogue ships as `templates/models.json`: every
 * provider, model, compat flag, thinking map, and price is real, but each
 * provider's `baseUrl` is a `*.example.invalid` placeholder and its `apiKey`
 * is a `$ENV_VAR` reference. `templates/settings.json` carries the default
 * provider and model.
 *
 * Applying the template REPLACES models.json as a whole (the previous file is
 * kept as models.json.preset-bak) and merges only defaultProvider and
 * defaultModel into settings.json. Everything here is read-only except
 * applyModelsTemplate().
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	deepMerge,
	isPlainObject,
	type JsonObject,
	type JsonValue,
	jsonEquals,
	readJsonObject,
	writeJsonObjectAtomic,
} from "./json-merge.ts";
import { sanitizeTerminalText } from "./skills-sync-output.ts";

const TEMPLATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "templates");

export interface TemplateModel {
	id: string;
	name: string;
}

export interface TemplateProvider {
	id: string;
	api: string;
	/** Placeholder endpoint from the template. */
	baseUrl: string;
	/** Placeholder key from the template: a `$ENV_VAR` reference. */
	apiKey: string;
	models: TemplateModel[];
}

export interface ModelsTemplate {
	/** The full template document, placeholders included. */
	document: JsonObject;
	providers: TemplateProvider[];
	defaultProvider: string;
	defaultModel: string;
}

function readTemplateJson(path: string): JsonObject {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isPlainObject(parsed)) throw new Error(`${path} does not contain a JSON object`);
	return parsed;
}

/** Load and validate the shipped template. Throws on a malformed template. */
export function loadModelsTemplate(dir: string = TEMPLATE_DIR): ModelsTemplate {
	const document = readTemplateJson(resolve(dir, "models.json"));
	const settings = readTemplateJson(resolve(dir, "settings.json"));

	if (!isPlainObject(document.providers)) throw new Error("template models.json has no providers object");
	const providers: TemplateProvider[] = [];
	for (const [id, raw] of Object.entries(document.providers)) {
		if (!isPlainObject(raw)) throw new Error(`template provider "${id}" is not an object`);
		const { api, baseUrl, apiKey, models } = raw;
		if (typeof api !== "string" || typeof baseUrl !== "string" || typeof apiKey !== "string") {
			throw new Error(`template provider "${id}" needs string api, baseUrl, and apiKey`);
		}
		if (!Array.isArray(models) || models.length === 0) throw new Error(`template provider "${id}" has no models`);
		const list: TemplateModel[] = models.map((model) => {
			if (!isPlainObject(model) || typeof model.id !== "string") {
				throw new Error(`template provider "${id}" has a model without an id`);
			}
			return { id: model.id, name: typeof model.name === "string" ? model.name : model.id };
		});
		providers.push({ id, api, baseUrl, apiKey, models: list });
	}

	const { defaultProvider, defaultModel } = settings;
	if (typeof defaultProvider !== "string" || typeof defaultModel !== "string") {
		throw new Error("template settings.json needs string defaultProvider and defaultModel");
	}
	const provider = providers.find((entry) => entry.id === defaultProvider);
	if (!provider) throw new Error(`template default provider "${defaultProvider}" is not in models.json`);
	if (!provider.models.some((model) => model.id === defaultModel)) {
		throw new Error(`template default model "${defaultModel}" is not a model of "${defaultProvider}"`);
	}

	return { document, providers, defaultProvider, defaultModel };
}

// ── values ──────────────────────────────────────────────────────────────────

export function isPlaceholderBaseUrl(value: string): boolean {
	try {
		return new URL(value).hostname.endsWith(".invalid");
	} catch {
		return false;
	}
}

/** `$NAME` / `${NAME}`: pi reads the key from that environment variable. */
export function isEnvReference(value: string): boolean {
	return /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/.test(value.trim());
}

export function validateBaseUrl(value: string): string | undefined {
	const input = value.trim();
	if (!input) return "base URL cannot be empty";
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		return "base URL must be a valid http:// or https:// URL";
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "base URL must use http or https";
	if (!parsed.hostname) return "base URL must include a hostname";
	if (parsed.username || parsed.password) return "base URL must not include a username or password";
	if (parsed.search || parsed.hash || input.includes("?") || input.includes("#")) {
		return "base URL must not include a query or fragment";
	}
	return undefined;
}

/** Trim and drop trailing slashes; pi appends its own path segments. */
export function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

/** Where a provider's value came from; drives the summary wording. */
export type ValueSource = "entered" | "current" | "template";

export interface ProviderValues {
	baseUrl: string;
	baseUrlSource: ValueSource;
	apiKey: string;
	apiKeySource: ValueSource;
}

// ── existing models.json ────────────────────────────────────────────────────

/** Strip pi-supported `//` comments and trailing commas outside strings. */
export function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => {
			if (match[0] === '"') return match;
			return tail ?? "";
		});
}

export interface ExistingModels {
	exists: boolean;
	/** Parsed document; undefined when the file is missing or unparseable. */
	data?: JsonObject;
	/** Why the existing file could not be parsed. It is replaced as a whole anyway. */
	error?: string;
}

export function readExistingModels(path: string): ExistingModels {
	if (!existsSync(path)) return { exists: false };
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return { exists: true, error: (error as Error).message };
	}
	if (raw.trim() === "") return { exists: true, data: {} };
	try {
		const parsed: unknown = JSON.parse(stripJsonComments(raw));
		if (!isPlainObject(parsed)) return { exists: true, error: "not a JSON object" };
		return { exists: true, data: parsed };
	} catch (error) {
		return { exists: true, error: (error as Error).message };
	}
}

function existingProviders(existing: ExistingModels): JsonObject {
	const providers = existing.data?.providers;
	return isPlainObject(providers) ? providers : {};
}

/** Current baseUrl/apiKey of a provider in the existing file, so a re-run can keep them. */
export function currentProviderValues(
	existing: ExistingModels,
	providerId: string,
): { baseUrl?: string; apiKey?: string } {
	const provider = existingProviders(existing)[providerId];
	if (!isPlainObject(provider)) return {};
	const result: { baseUrl?: string; apiKey?: string } = {};
	if (typeof provider.baseUrl === "string" && provider.baseUrl.trim() !== "") result.baseUrl = provider.baseUrl;
	if (typeof provider.apiKey === "string" && provider.apiKey.trim() !== "") result.apiKey = provider.apiKey;
	return result;
}

// ── plan ────────────────────────────────────────────────────────────────────

/** The template with each provider's baseUrl/apiKey substituted. */
export function buildModelsDocument(template: ModelsTemplate, values: Readonly<Record<string, ProviderValues>>): JsonObject {
	const document = JSON.parse(JSON.stringify(template.document)) as JsonObject;
	const providers = document.providers as JsonObject;
	for (const provider of template.providers) {
		const value = values[provider.id];
		if (!value) continue;
		const entry = providers[provider.id] as JsonObject;
		entry.baseUrl = value.baseUrl;
		entry.apiKey = value.apiKey;
	}
	return document;
}

export interface SettingsChange {
	key: "defaultProvider" | "defaultModel";
	from: JsonValue | undefined;
	to: string;
}

export interface ModelsTemplatePlan {
	modelsPath: string;
	settingsPath: string;
	document: JsonObject;
	modelsChanged: boolean;
	modelsExisted: boolean;
	settingsPatch: { defaultProvider: string; defaultModel: string };
	settingsChanges: SettingsChange[];
	/** Providers still carrying a template placeholder, with the fields involved. */
	placeholders: { providerId: string; fields: string[] }[];
	/** Redacted summary for the confirmation screen. API keys never appear. */
	lines: string[];
}

function show(value: string): string {
	return sanitizeTerminalText(value, 300).replace(/\n+/g, " ");
}

function describeBaseUrl(value: ProviderValues): string {
	const suffix =
		value.baseUrlSource === "template" ? " (placeholder)" : value.baseUrlSource === "current" ? " (current)" : "";
	return `${show(value.baseUrl)}${suffix}`;
}

function describeApiKey(value: ProviderValues): string {
	if (value.apiKeySource === "template") return `${show(value.apiKey)} (placeholder: read from this environment variable)`;
	if (isEnvReference(value.apiKey)) return `${show(value.apiKey)} (environment variable${value.apiKeySource === "current" ? ", current" : ""})`;
	return value.apiKeySource === "current" ? "<current key, hidden>" : "<entered, hidden>";
}

export interface PlanModelsTemplateInput {
	template: ModelsTemplate;
	values: Readonly<Record<string, ProviderValues>>;
	defaultProvider: string;
	defaultModel: string;
	modelsPath: string;
	settingsPath: string;
	existing?: ExistingModels;
}

/**
 * Compute what applying the template would change. Throws when settings.json
 * cannot be parsed: nothing may be written in that case, models.json included.
 */
export function planModelsTemplate(input: PlanModelsTemplateInput): ModelsTemplatePlan {
	const { template, values, modelsPath, settingsPath } = input;
	const provider = template.providers.find((entry) => entry.id === input.defaultProvider);
	if (!provider) throw new Error(`unknown provider "${input.defaultProvider}"`);
	if (!provider.models.some((model) => model.id === input.defaultModel)) {
		throw new Error(`"${input.defaultModel}" is not a model of "${input.defaultProvider}"`);
	}

	const existing = input.existing ?? readExistingModels(modelsPath);
	const settings = readJsonObject(settingsPath).data;
	const document = buildModelsDocument(template, values);
	const modelsChanged = existing.data === undefined || !jsonEquals(existing.data, document);

	const settingsPatch = { defaultProvider: input.defaultProvider, defaultModel: input.defaultModel };
	const settingsChanges: SettingsChange[] = [];
	for (const key of ["defaultProvider", "defaultModel"] as const) {
		if (settings[key] !== settingsPatch[key]) settingsChanges.push({ key, from: settings[key], to: settingsPatch[key] });
	}

	const placeholders: ModelsTemplatePlan["placeholders"] = [];
	for (const entry of template.providers) {
		const value = values[entry.id];
		if (!value) continue;
		const fields: string[] = [];
		if (isPlaceholderBaseUrl(value.baseUrl)) fields.push("baseUrl");
		if (value.apiKey === entry.apiKey) fields.push("apiKey");
		if (fields.length > 0) placeholders.push({ providerId: entry.id, fields });
	}

	const lines: string[] = [];
	if (modelsChanged) {
		lines.push("~ models.json: replace the whole file with the preset template");
		lines.push(`    ${show(modelsPath)}`);
		if (existing.exists) lines.push("    previous file kept as models.json.preset-bak");
		if (existing.error) lines.push(`  ! current file could not be parsed (${show(existing.error)}); it is replaced as is`);
		const templateIds = new Set(template.providers.map((entry) => entry.id));
		for (const id of Object.keys(existingProviders(existing))) {
			if (!templateIds.has(id)) lines.push(`  - provider ${show(id)} (not in the template, removed)`);
		}
		for (const entry of template.providers) {
			const value = values[entry.id];
			if (!value) continue;
			lines.push(`  + ${entry.id}  ${entry.api}, ${entry.models.length} model(s)`);
			lines.push(`      baseUrl  ${describeBaseUrl(value)}`);
			lines.push(`      apiKey   ${describeApiKey(value)}`);
		}
	} else {
		lines.push("= models.json: already matches the template with these values");
	}

	if (settingsChanges.length > 0) {
		lines.push(`~ settings.json: set ${settingsChanges.length} key(s)`);
		for (const change of settingsChanges) {
			const from = change.from === undefined ? "unset" : show(JSON.stringify(change.from));
			lines.push(`    ${change.key}: ${from} -> ${JSON.stringify(change.to)}`);
		}
	} else {
		lines.push(`= settings.json: default is already ${settingsPatch.defaultProvider} / ${settingsPatch.defaultModel}`);
	}

	for (const entry of placeholders) {
		lines.push(`! ${entry.providerId}: ${entry.fields.join(" and ")} still a placeholder`);
	}

	return {
		modelsPath,
		settingsPath,
		document,
		modelsChanged,
		modelsExisted: existing.exists,
		settingsPatch,
		settingsChanges,
		placeholders,
		lines,
	};
}

// ── apply ───────────────────────────────────────────────────────────────────

export interface ModelsTemplateApplyResult {
	modelsWritten: boolean;
	settingsWritten: boolean;
}

/**
 * Write the plan. settings.json is re-read right before its merge so keys
 * changed since planning survive; only defaultProvider/defaultModel are set.
 */
export function applyModelsTemplate(plan: ModelsTemplatePlan): ModelsTemplateApplyResult {
	// Parse settings.json first: if it broke since planning, fail before
	// models.json is touched rather than leaving a half-applied template.
	const settings = readJsonObject(plan.settingsPath).data;

	let modelsWritten = false;
	if (plan.modelsChanged) {
		writeJsonObjectAtomic(plan.modelsPath, plan.document, {
			newFileMode: 0o600,
			forceMode: 0o600,
			rejectDanglingSymlink: true,
		});
		modelsWritten = true;
	}

	let settingsWritten = false;
	const merged = deepMerge(settings, plan.settingsPatch);
	if (!jsonEquals(merged, settings)) {
		writeJsonObjectAtomic(plan.settingsPath, merged);
		settingsWritten = true;
	}

	return { modelsWritten, settingsWritten };
}
