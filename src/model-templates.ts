/** Credential-free model bundles used by /preset-models-add. */

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
