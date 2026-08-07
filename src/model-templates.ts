/** Credential-free model bundles used by the /pi-preset model wizard. */

export type FamilyId = "anthropic" | "openai" | "deepseek";
export type ModelInput = "text" | "image";

export interface ThinkingLevelMap {
	off: string | null;
	minimal: string | null;
	low: string | null;
	medium: string | null;
	high: string | null;
	xhigh: string | null;
	max: string | null;
}

export interface ModelCostTier {
	inputTokensAbove: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: readonly ModelCostTier[];
}

export interface ModelTemplate {
	id: string;
	name: string;
	reasoning: true;
	input: readonly ModelInput[];
	contextWindow: number;
	maxTokens: number;
	cost: ModelCost;
	thinkingLevelMap: ThinkingLevelMap;
}

export interface FamilyTemplate {
	id: FamilyId;
	label: string;
	api: "anthropic-messages" | "openai-responses";
	compat: Readonly<Record<string, boolean>>;
	models: readonly ModelTemplate[];
}

const ANTHROPIC_THINKING: ThinkingLevelMap = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const OPENAI_THINKING: ThinkingLevelMap = {
	off: "none",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const DEEPSEEK_THINKING: ThinkingLevelMap = {
	off: "none",
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
};

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

export const FAMILY_TEMPLATES: Readonly<Record<FamilyId, FamilyTemplate>> = deepFreeze({
	anthropic: {
		id: "anthropic",
		label: "Anthropic",
		api: "anthropic-messages",
		compat: {
			supportsEagerToolInputStreaming: false,
			supportsLongCacheRetention: true,
			forceAdaptiveThinking: true,
			supportsStrictTools: true,
		},
		models: [
			{
				id: "claude-fable-5",
				name: "Claude Fable 5",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
				thinkingLevelMap: { ...ANTHROPIC_THINKING },
			},
			{
				id: "claude-opus-5",
				name: "Claude Opus 5",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
				thinkingLevelMap: { ...ANTHROPIC_THINKING },
			},
			{
				id: "claude-sonnet-5",
				name: "Claude Sonnet 5",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
				thinkingLevelMap: { ...ANTHROPIC_THINKING },
			},
		],
	},
	openai: {
		id: "openai",
		label: "OpenAI",
		api: "openai-responses",
		compat: {
			supportsDeveloperRole: true,
			supportsStrictMode: true,
		},
		models: [
			{
				id: "gpt-5.6-sol",
				name: "GPT-5.6 Sol",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 372_000,
				maxTokens: 128_000,
				cost: {
					input: 5,
					output: 30,
					cacheRead: 0.5,
					cacheWrite: 6.25,
					tiers: [{ inputTokensAbove: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }],
				},
				thinkingLevelMap: { ...OPENAI_THINKING },
			},
			{
				id: "gpt-5.6-terra",
				name: "GPT-5.6 Terra",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 272_000,
				maxTokens: 128_000,
				cost: {
					input: 2,
					output: 12,
					cacheRead: 0.2,
					cacheWrite: 2.5,
					tiers: [{ inputTokensAbove: 272_000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 }],
				},
				thinkingLevelMap: { ...OPENAI_THINKING },
			},
			{
				id: "gpt-5.6-luna",
				name: "GPT-5.6 Luna",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 272_000,
				maxTokens: 128_000,
				cost: {
					input: 0.2,
					output: 1.2,
					cacheRead: 0.02,
					cacheWrite: 0.25,
					tiers: [{ inputTokensAbove: 272_000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 }],
				},
				thinkingLevelMap: { ...OPENAI_THINKING },
			},
		],
	},
	deepseek: {
		id: "deepseek",
		label: "DeepSeek",
		api: "openai-responses",
		compat: {
			supportsDeveloperRole: false,
			supportsLongCacheRetention: false,
			supportsStrictMode: true,
		},
		models: [
			{
				id: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				reasoning: true,
				input: ["text"],
				contextWindow: 1_000_000,
				maxTokens: 384_000,
				cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
				thinkingLevelMap: { ...DEEPSEEK_THINKING },
			},
		],
	},
});

export const FAMILY_ORDER: readonly FamilyId[] = ["anthropic", "openai", "deepseek"];

export function getFamilyTemplate(family: FamilyId): FamilyTemplate {
	return FAMILY_TEMPLATES[family];
}

/** Catalog for the fully custom provider flow: every option carries a user-facing explanation. */

export type CustomApiId = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface CustomApiOption {
	id: CustomApiId;
	label: string;
	description: string;
}

export const CUSTOM_API_OPTIONS: readonly CustomApiOption[] = deepFreeze([
	{
		id: "openai-completions",
		label: "OpenAI Chat Completions",
		description:
			"POST {baseUrl}/chat/completions. The most widely supported protocol; pick this for OpenAI-compatible relays and gateways (one-api, new-api, OpenRouter, vLLM, Ollama, ...).",
	},
	{
		id: "openai-responses",
		label: "OpenAI Responses",
		description:
			"POST {baseUrl}/responses. OpenAI's newer protocol; pick this only when the endpoint explicitly supports the Responses API.",
	},
	{
		id: "anthropic-messages",
		label: "Anthropic Messages",
		description:
			"POST {baseUrl}/messages. Pick this for Anthropic-compatible endpoints such as Claude relays and proxies exposing the Messages API.",
	},
]);

export interface CompatFlagOption {
	key: string;
	apis: readonly CustomApiId[];
	description: string;
}

/**
 * Boolean compatibility switches the custom wizard can set per provider.
 * Left unset, Pi keeps its own default (often auto-detected from the URL).
 */
export const COMPAT_FLAG_OPTIONS: readonly CompatFlagOption[] = deepFreeze([
	{
		key: "supportsDeveloperRole",
		apis: ["openai-completions", "openai-responses"],
		description:
			'Send the system prompt with the "developer" role instead of "system". True for real OpenAI endpoints; many relays only accept "system".',
	},
	{
		key: "supportsReasoningEffort",
		apis: ["openai-completions"],
		description:
			"Send the reasoning_effort request field for reasoning models. Disable when the endpoint rejects unknown fields.",
	},
	{
		key: "supportsUsageInStreaming",
		apis: ["openai-completions"],
		description:
			"Request token usage in streaming responses via stream_options.include_usage. Disable if the endpoint errors on stream_options.",
	},
	{
		key: "requiresToolResultName",
		apis: ["openai-completions"],
		description: "Include the tool name on tool-result messages. Some OpenAI-compatible providers require it.",
	},
	{
		key: "requiresThinkingAsText",
		apis: ["openai-completions"],
		description:
			"Replay past thinking blocks as plain <thinking> text. Needed by providers that reject reasoning content in the message history.",
	},
	{
		key: "supportsStrictMode",
		apis: ["openai-completions", "openai-responses"],
		description: "Use strict JSON-schema function tools. Disable if the provider rejects strict tool definitions.",
	},
	{
		key: "supportsLongCacheRetention",
		apis: ["openai-responses", "anthropic-messages"],
		description:
			"Request extended prompt-cache retention (24h on OpenAI Responses, 1h cache_control TTL on Anthropic). Disable when the provider only supports the default retention.",
	},
	{
		key: "supportsEagerToolInputStreaming",
		apis: ["anthropic-messages"],
		description:
			"Provider accepts per-tool eager_input_streaming. Disable for relays that reject that field (a legacy beta header is used instead).",
	},
	{
		key: "supportsStrictTools",
		apis: ["anthropic-messages"],
		description: "Advertise strict tool schemas to the provider. Disable if tool calls start failing schema validation.",
	},
	{
		key: "forceAdaptiveThinking",
		apis: ["anthropic-messages"],
		description:
			"Always drive thinking through Anthropic adaptive thinking, matching the bundled Anthropic preset behavior.",
	},
]);

export function compatFlagsForApi(api: CustomApiId): CompatFlagOption[] {
	return COMPAT_FLAG_OPTIONS.filter((flag) => flag.apis.includes(api));
}

export interface ThinkingPresetOption {
	id: "none" | "openai" | "anthropic" | "deepseek";
	label: string;
	description: string;
	reasoning: boolean;
	map: ThinkingLevelMap | null;
}

export const THINKING_PRESETS: readonly ThinkingPresetOption[] = deepFreeze([
	{
		id: "none",
		label: "No reasoning",
		description: "A plain model without thinking controls. Pi's thinking-level selector is disabled for this model.",
		reasoning: false,
		map: null,
	},
	{
		id: "openai",
		label: "OpenAI-style efforts",
		description:
			'Maps off/low/medium/high/xhigh/max to reasoning efforts, with "off" sent as "none". Matches the bundled OpenAI preset.',
		reasoning: true,
		map: { ...OPENAI_THINKING },
	},
	{
		id: "anthropic",
		label: "Anthropic-style efforts",
		description:
			"Maps low/medium/high/xhigh/max to thinking efforts; off and minimal are unavailable. Matches the bundled Anthropic preset.",
		reasoning: true,
		map: { ...ANTHROPIC_THINKING },
	},
	{
		id: "deepseek",
		label: "DeepSeek-style efforts",
		description:
			"Only off, low, high, and max are available; medium and xhigh are unavailable. Matches the bundled DeepSeek preset.",
		reasoning: true,
		map: { ...DEEPSEEK_THINKING },
	},
]);

export interface ThinkingLevelInfo {
	level: keyof ThinkingLevelMap;
	description: string;
}

/** Pi's seven thinking levels, in selector order, for the fully custom mapping editor. */
export const THINKING_LEVELS: readonly ThinkingLevelInfo[] = deepFreeze([
	{
		level: "off",
		description: 'Thinking disabled. Providers often expect "none" here; leave empty if thinking cannot be turned off.',
	},
	{
		level: "minimal",
		description: 'The lightest thinking effort. Providers often expect "minimal"; most APIs do not offer this level.',
	},
	{ level: "low", description: 'Low thinking effort. Providers commonly expect "low".' },
	{ level: "medium", description: 'Medium thinking effort, the usual default. Providers commonly expect "medium".' },
	{ level: "high", description: 'High thinking effort. Providers commonly expect "high".' },
	{
		level: "xhigh",
		description: 'Extra-high thinking effort. Providers may expect "xhigh"; leave empty if unsupported.',
	},
	{
		level: "max",
		description: 'Maximum thinking effort or budget. Providers may expect "max"; leave empty if unsupported.',
	},
]);

export interface ModalityOption {
	id: "text" | "text-image";
	label: string;
	description: string;
	input: readonly ModelInput[];
}

export const MODALITY_OPTIONS: readonly ModalityOption[] = deepFreeze([
	{
		id: "text",
		label: "Text only",
		description: "The model accepts text input only; Pi will not attach images to requests.",
		input: ["text"],
	},
	{
		id: "text-image",
		label: "Text + image",
		description: "The model accepts text and images (vision). Pick this only if the endpoint really supports image input.",
		input: ["text", "image"],
	},
]);
