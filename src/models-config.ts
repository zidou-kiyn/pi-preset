import { lstatSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isPlainObject, type JsonObject, type JsonValue, resolveJsonTargetPath } from "./json-merge.ts";
import {
	CUSTOM_API_OPTIONS,
	FAMILY_ORDER,
	FAMILY_TEMPLATES,
	type FamilyId,
	type FamilyTemplate,
	getFamilyTemplate,
	type ModelInput,
	type ModelTemplate,
	type ThinkingLevelMap,
} from "./model-templates.ts";

export interface ModelsDocument {
	inputPath: string;
	targetPath: string;
	exists: boolean;
	mode?: number;
	data: JsonObject;
	/** Original bytes are retained for diagnostics and backup assertions only. */
	raw?: string;
}

export interface ProviderCandidate extends JsonObject {
	baseUrl: string;
	apiKey: string;
	api: string;
	compat: JsonObject;
	models: JsonValue[];
}

export type ProviderPlanStatus = "add" | "replace" | "already-configured";

export interface ReadyProviderPlan {
	status: ProviderPlanStatus;
	providerId: string;
	candidate: ProviderCandidate;
	existingProvider: JsonValue | undefined;
	baselineProviderExists: boolean;
	diff: readonly string[];
	baselineTargetPath?: string;
}

export interface BlockedProviderPlan {
	status: "blocked";
	message: string;
}

export type ProviderPlan = ReadyProviderPlan | BlockedProviderPlan;

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_PROVIDER_IDS = new Set(["__proto__", "prototype", "constructor"]);

export const REDACTED_EXISTING = "<redacted-existing>";
export const REDACTED_SUPPLIED = "<redacted-supplied>";

/** Strip Pi-supported line comments without touching URL-like text in strings. */
export function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => {
			if (match[0] === '"') return match;
			return tail ?? "";
		});
}

function readTargetStats(inputPath: string): { targetPath: string; exists: boolean; mode?: number } {
	const requestedPath = resolve(inputPath);
	try {
		lstatSync(requestedPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { targetPath: requestedPath, exists: false };
		}
		throw new Error(`cannot inspect ${requestedPath}: ${(error as Error).message}`);
	}

	const targetPath = resolveJsonTargetPath(requestedPath, true);
	let targetStats: ReturnType<typeof statSync>;
	try {
		targetStats = statSync(targetPath);
	} catch (error) {
		throw new Error(`cannot inspect ${requestedPath}: ${(error as Error).message}`);
	}

	const mode = targetStats.mode & 0o777;
	if (process.platform !== "win32" && (mode & 0o077) !== 0) {
		throw new Error(
			`refusing to read ${requestedPath}: file permissions are broader than owner-only; run chmod 600 ${targetPath}`,
		);
	}

	return { targetPath, exists: true, mode };
}

function parseModelsRoot(raw: string, filePath: string): JsonObject {
	if (raw.trim() === "") return { providers: {} };

	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(raw));
	} catch (error) {
		throw new Error(`${filePath} is not valid JSON (${(error as Error).message}); refusing to write over it`);
	}

	if (!isPlainObject(parsed)) {
		throw new Error(`${filePath} does not contain a JSON object; refusing to write over it`);
	}

	const providers = parsed.providers;
	if (providers !== undefined && !isPlainObject(providers)) {
		throw new Error(`${filePath} has a non-object "providers" value; refusing to write over it`);
	}

	if (providers === undefined) return { ...parsed, providers: {} };
	return parsed;
}

/** Read and normalize a Pi models.json document, including JSONC syntax. */
export function readModelsDocument(inputPath: string): ModelsDocument {
	const requestedPath = resolve(inputPath);
	let stats: { targetPath: string; exists: boolean; mode?: number };
	stats = readTargetStats(requestedPath);

	if (!stats.exists) {
		return { inputPath: requestedPath, targetPath: stats.targetPath, exists: false, data: { providers: {} } };
	}

	let raw: string;
	try {
		raw = readFileSync(stats.targetPath, "utf8");
	} catch (error) {
		throw new Error(`cannot read ${requestedPath}: ${(error as Error).message}`);
	}

	return {
		inputPath: requestedPath,
		targetPath: stats.targetPath,
		exists: true,
		mode: stats.mode,
		data: parseModelsRoot(raw, requestedPath),
		raw,
	};
}

export function validateProviderId(providerId: string): string | undefined {
	if (!providerId.trim()) return "provider identifier cannot be empty";
	if (RESERVED_PROVIDER_IDS.has(providerId)) return "that provider identifier is reserved";
	if (!PROVIDER_ID_PATTERN.test(providerId)) {
		return "provider identifier must start with a letter or number and contain only letters, numbers, dot, underscore, or hyphen (up to 64 characters)";
	}
	return undefined;
}

export function validateBaseUrl(value: string): string | undefined {
	const input = value.trim();
	if (!input) return "base URL cannot be empty";

	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		return "base URL must be a valid HTTP or HTTPS URL";
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return "base URL must use http or https";
	}
	if (!parsed.hostname) return "base URL must include a hostname";
	if (parsed.username || parsed.password) return "base URL must not include username or password";
	if (input.includes("?") || input.includes("#") || parsed.search || parsed.hash) {
		return "base URL must not include a query or fragment";
	}
	return undefined;
}

export function normalizeBaseUrl(value: string): string {
	const error = validateBaseUrl(value);
	if (error) throw new Error(error);
	return new URL(value.trim()).toString();
}

export function validateApiKey(value: string): string | undefined {
	if (!value.trim()) return "API key cannot be empty";
	return undefined;
}

export function validateModelSelection(family: FamilyId, selectedModelIds: readonly string[]): string | undefined {
	const catalog = getFamilyTemplate(family).models;
	const allowed = new Set(catalog.map((model) => model.id));
	if (selectedModelIds.length === 0) return "select at least one model";
	if (selectedModelIds.some((id) => !allowed.has(id))) return "model selection contains an unsupported model";
	return undefined;
}

/** Return selected model IDs in the fixed catalog order, never toggle order. */
export function normalizeSelectedModelIds(family: FamilyId, selectedModelIds: readonly string[]): string[] {
	const error = validateModelSelection(family, selectedModelIds);
	if (error) throw new Error(error);
	const selected = new Set(selectedModelIds);
	return getFamilyTemplate(family)
		.models.filter((model) => selected.has(model.id))
		.map((model) => model.id);
}

function cloneJson(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function cloneModel(model: ModelTemplate): JsonObject {
	const cloned = cloneJson(model);
	if (!isPlainObject(cloned)) throw new Error(`model template ${model.id} is not an object`);
	return cloned;
}

function cloneFamilyCompat(family: FamilyTemplate): JsonObject {
	const cloned = cloneJson(family.compat);
	if (!isPlainObject(cloned)) throw new Error(`compatibility template for ${family.id} is not an object`);
	return cloned;
}

export function buildProviderCandidate(
	family: FamilyId,
	selectedModelIds: readonly string[],
	baseUrl: string,
	apiKey: string,
): ProviderCandidate {
	const selectionError = validateModelSelection(family, selectedModelIds);
	if (selectionError) throw new Error(selectionError);
	const baseUrlError = validateBaseUrl(baseUrl);
	if (baseUrlError) throw new Error(baseUrlError);
	const apiKeyError = validateApiKey(apiKey);
	if (apiKeyError) throw new Error(apiKeyError);

	const template = getFamilyTemplate(family);
	const selected = new Set(normalizeSelectedModelIds(family, selectedModelIds));
	const models = template.models.filter((model) => selected.has(model.id)).map(cloneModel);

	return {
		baseUrl: normalizeBaseUrl(baseUrl),
		apiKey,
		api: template.api,
		compat: cloneFamilyCompat(template),
		models,
	};
}

export function getModelsProviders(document: JsonObject): JsonObject {
	const providers = document.providers;
	if (!isPlainObject(providers)) throw new Error('models.json has a non-object "providers" value');
	return providers;
}

function hasOwn(source: JsonObject, key: string): boolean {
	return Object.hasOwn(source, key);
}

/** Semantic JSON equality: object key order is ignored, array order is not. */
export function semanticJsonEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
	if (left === right) return true;
	if (left === undefined || right === undefined) return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		return left.every((value, index) => semanticJsonEqual(value, right[index]));
	}
	if (isPlainObject(left) || isPlainObject(right)) {
		if (!isPlainObject(left) || !isPlainObject(right)) return false;
		const leftKeys = Object.keys(left).sort();
		const rightKeys = Object.keys(right).sort();
		if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
		return leftKeys.every((key) => semanticJsonEqual(left[key], right[key]));
	}
	return false;
}

function isSecretKey(key: string): boolean {
	const normalized = key.toLowerCase().replaceAll("-", "_");
	return (
		normalized === "apikey" ||
		normalized === "api_key" ||
		normalized.endsWith("apikey") ||
		normalized.endsWith("api_key") ||
		normalized === "authorization" ||
		normalized === "token" ||
		normalized.endsWith("_token") ||
		normalized.endsWith("token") ||
		normalized === "secret" ||
		normalized.endsWith("_secret") ||
		normalized.endsWith("secret") ||
		normalized === "password" ||
		normalized.endsWith("_password") ||
		normalized.endsWith("password")
	);
}

function redactHeaders(value: JsonValue, marker: string): JsonValue {
	if (isPlainObject(value)) {
		const result: JsonObject = {};
		for (const [key, child] of Object.entries(value)) result[key] = redactHeaders(child, marker);
		return result;
	}
	if (Array.isArray(value)) return value.map((child) => redactHeaders(child, marker));
	return marker;
}

/** Recursively redact credential-bearing values without exposing their shape. */
export function redactJson(value: JsonValue, role: "existing" | "supplied"): JsonValue {
	const marker = role === "existing" ? REDACTED_EXISTING : REDACTED_SUPPLIED;
	if (Array.isArray(value)) return value.map((child) => redactJson(child, role));
	if (!isPlainObject(value)) return value;

	const result: JsonObject = {};
	for (const [key, child] of Object.entries(value)) {
		if (key.toLowerCase() === "headers") {
			result[key] = redactHeaders(child, marker);
		} else if (isSecretKey(key)) {
			result[key] = marker;
		} else {
			result[key] = redactJson(child, role);
		}
	}
	return result;
}

function formatDiffValue(providerId: string, value: JsonValue, prefix: string): string[] {
	const role = prefix === "-" ? "existing" : "supplied";
	const redacted = isPlainObject(value) ? redactJson(value, role) : role === "existing" ? REDACTED_EXISTING : value;
	const serialized = JSON.stringify(redacted, null, 2);
	const lines = serialized.split("\n");
	return lines.map(
		(line, index) => `${prefix} ${index === 0 ? `providers[${JSON.stringify(providerId)}] = ${line}` : line}`,
	);
}

/** Render a deterministic provider-only diff; redaction happens before serialization. */
export function renderProviderDiff(
	providerId: string,
	existingProvider: JsonValue | undefined,
	candidate: ProviderCandidate,
): string[] {
	const lines: string[] = [];
	if (existingProvider !== undefined) lines.push(...formatDiffValue(providerId, existingProvider, "-"));
	lines.push(...formatDiffValue(providerId, candidate, "+"));
	return lines;
}

export function planProviderUpsert(
	document: JsonObject,
	providerId: string,
	candidate: ProviderCandidate,
	baselineTargetPath?: string,
): ProviderPlan {
	const providerIdError = validateProviderId(providerId);
	if (providerIdError) return { status: "blocked", message: providerIdError };

	let providers: JsonObject;
	try {
		providers = getModelsProviders(document);
	} catch (error) {
		return { status: "blocked", message: (error as Error).message };
	}

	const baselineProviderExists = hasOwn(providers, providerId);
	const existingProvider = baselineProviderExists ? providers[providerId] : undefined;
	const status: ProviderPlanStatus = !baselineProviderExists
		? "add"
		: semanticJsonEqual(existingProvider, candidate)
			? "already-configured"
			: "replace";

	return {
		status,
		providerId,
		candidate,
		existingProvider,
		baselineProviderExists,
		diff: status === "already-configured" ? [] : renderProviderDiff(providerId, existingProvider, candidate),
		baselineTargetPath,
	};
}

export function familyOptions(): string[] {
	return FAMILY_ORDER.map((family) => FAMILY_TEMPLATES[family].label);
}

export function familyFromLabel(label: string): FamilyId | undefined {
	for (const family of Object.values(FAMILY_TEMPLATES)) {
		if (family.label === label) return family.id;
	}
	return undefined;
}

export const CUSTOM_PROVIDER_LABEL = "Custom (configure every parameter yourself)";

export type WizardFamilyChoice = FamilyId | "custom";

export function wizardFamilyOptions(): string[] {
	return [...familyOptions(), CUSTOM_PROVIDER_LABEL];
}

export function wizardFamilyFromLabel(label: string): WizardFamilyChoice | undefined {
	if (label === CUSTOM_PROVIDER_LABEL) return "custom";
	return familyFromLabel(label);
}

/** Custom provider flow: user-supplied schema instead of a bundled template. */

export interface CustomModelSpec {
	id: string;
	name: string;
	input: readonly ModelInput[];
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	thinkingLevelMap?: ThinkingLevelMap;
}

export interface CustomProviderSpec {
	api: string;
	compat: Record<string, boolean>;
	models: readonly CustomModelSpec[];
}

export function validateCustomModelId(value: string): string | undefined {
	const id = value.trim();
	if (!id) return "model ID cannot be empty";
	if (id.length > 256) return "model ID is too long (max 256 characters)";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
	if (/[\x00-\x1f\x7f]/.test(id)) return "model ID must not contain control characters";
	return undefined;
}

/** Parse a token count such as "128000", "128k", "1m", or "200,000". */
export function parseTokenCount(value: string): number | undefined {
	const text = value.trim().toLowerCase().replaceAll(",", "").replaceAll("_", "");
	const match = /^(\d+(?:\.\d+)?)([km]?)$/.exec(text);
	if (!match) return undefined;
	const scale = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1;
	const parsed = Number(match[1]) * scale;
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 100_000_000) return undefined;
	return parsed;
}

/**
 * Parse "input,output,cacheRead,cacheWrite" USD-per-million-token costs.
 * Missing trailing values default to 0; an empty string means all zeros.
 */
export function parseCostList(value: string): CustomModelSpec["cost"] | undefined {
	const text = value.trim();
	const parts = text === "" ? [] : text.split(",").map((part) => part.trim());
	if (parts.length > 4) return undefined;
	const numbers: number[] = [];
	for (const part of parts) {
		if (part === "" || !/^\d+(?:\.\d+)?$/.test(part)) return undefined;
		const parsed = Number(part);
		if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100_000) return undefined;
		numbers.push(parsed);
	}
	return {
		input: numbers[0] ?? 0,
		output: numbers[1] ?? 0,
		cacheRead: numbers[2] ?? 0,
		cacheWrite: numbers[3] ?? 0,
	};
}

export function validateCustomProviderSpec(spec: CustomProviderSpec): string | undefined {
	if (!CUSTOM_API_OPTIONS.some((option) => option.id === spec.api)) {
		return `unsupported API protocol "${spec.api}"`;
	}
	if (spec.models.length === 0) return "define at least one model";
	const seen = new Set<string>();
	for (const model of spec.models) {
		const idError = validateCustomModelId(model.id);
		if (idError) return idError;
		if (seen.has(model.id)) return `duplicate model ID "${model.id}"`;
		seen.add(model.id);
		if (!model.name.trim()) return `model "${model.id}" needs a display name`;
		if (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0) {
			return `model "${model.id}" needs a positive integer context window`;
		}
		if (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0) {
			return `model "${model.id}" needs a positive integer max output token count`;
		}
		if (model.maxTokens > model.contextWindow) {
			return `model "${model.id}" has max output tokens larger than its context window`;
		}
		for (const cost of Object.values(model.cost)) {
			if (!Number.isFinite(cost) || cost < 0) return `model "${model.id}" has a negative or invalid cost`;
		}
		if (model.reasoning) {
			if (model.thinkingLevelMap === undefined) {
				return `model "${model.id}" enables reasoning but has no thinking level map`;
			}
			if (Object.values(model.thinkingLevelMap).every((value) => value === null)) {
				return `model "${model.id}" has a thinking level map with every level unavailable`;
			}
		}
	}
	return undefined;
}

export function buildCustomProviderCandidate(
	spec: CustomProviderSpec,
	baseUrl: string,
	apiKey: string,
): ProviderCandidate {
	const specError = validateCustomProviderSpec(spec);
	if (specError) throw new Error(specError);
	const baseUrlError = validateBaseUrl(baseUrl);
	if (baseUrlError) throw new Error(baseUrlError);
	const apiKeyError = validateApiKey(apiKey);
	if (apiKeyError) throw new Error(apiKeyError);

	const models = spec.models.map((model) => {
		const entry: JsonObject = {
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			input: [...model.input],
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			cost: { ...model.cost },
		};
		if (model.thinkingLevelMap !== undefined) entry.thinkingLevelMap = { ...model.thinkingLevelMap };
		return entry;
	});

	return {
		baseUrl: normalizeBaseUrl(baseUrl),
		apiKey,
		api: spec.api,
		compat: { ...spec.compat },
		models,
	};
}
