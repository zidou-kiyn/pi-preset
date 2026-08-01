import assert from "node:assert/strict";
import { test } from "node:test";
import { FAMILY_ORDER, FAMILY_TEMPLATES } from "../src/model-templates.ts";

test("all supported families expose the fixed APIs and compatibility flags", () => {
	assert.deepEqual(FAMILY_ORDER, ["anthropic", "openai", "deepseek"]);
	assert.equal(FAMILY_TEMPLATES.anthropic.api, "anthropic-messages");
	assert.deepEqual(FAMILY_TEMPLATES.anthropic.compat, {
		supportsEagerToolInputStreaming: false,
		supportsLongCacheRetention: true,
		forceAdaptiveThinking: true,
		supportsStrictTools: true,
	});
	assert.equal(FAMILY_TEMPLATES.openai.api, "openai-responses");
	assert.deepEqual(FAMILY_TEMPLATES.openai.compat, {
		supportsDeveloperRole: true,
		supportsStrictMode: true,
	});
	assert.equal(FAMILY_TEMPLATES.deepseek.api, "openai-responses");
	assert.deepEqual(FAMILY_TEMPLATES.deepseek.compat, {
		supportsDeveloperRole: false,
		supportsLongCacheRetention: false,
		supportsStrictMode: true,
	});
});

test("Anthropic templates exactly preserve current local credential-free metadata", () => {
	const thinkingLevelMap = {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	};
	assert.deepEqual(FAMILY_TEMPLATES.anthropic.models, [
		{
			id: "claude-fable-5",
			name: "Claude Fable 5",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
			thinkingLevelMap,
		},
		{
			id: "claude-opus-5",
			name: "Claude Opus 5",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
			thinkingLevelMap,
		},
		{
			id: "claude-sonnet-5",
			name: "Claude Sonnet 5",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
			thinkingLevelMap,
		},
	]);
});

test("OpenAI templates exactly preserve Sol, Terra, and Luna metadata and tiers", () => {
	const thinkingLevelMap = {
		off: "none",
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	};
	assert.deepEqual(FAMILY_TEMPLATES.openai.models, [
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
			thinkingLevelMap,
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
			thinkingLevelMap,
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
			thinkingLevelMap,
		},
	]);
});

test("DeepSeek template exactly preserves text-only limits and unsupported thinking levels", () => {
	assert.deepEqual(FAMILY_TEMPLATES.deepseek.models, [
		{
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			reasoning: true,
			input: ["text"],
			contextWindow: 1_000_000,
			maxTokens: 384_000,
			cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
			thinkingLevelMap: {
				off: "none",
				minimal: null,
				low: "low",
				medium: null,
				high: "high",
				xhigh: null,
				max: "max",
			},
		},
	]);
});

test("public templates contain no endpoint or credential fields", () => {
	const serialized = JSON.stringify(FAMILY_TEMPLATES);
	assert.equal(serialized.includes("baseUrl"), false);
	assert.equal(serialized.includes("apiKey"), false);
});
