import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withPlatform } from "./platform-test-utils.ts";
import { isPlainObject, type JsonValue } from "../src/json-merge.ts";
import {
	buildProviderCandidate,
	normalizeBaseUrl,
	normalizeSelectedModelIds,
	planProviderUpsert,
	REDACTED_EXISTING,
	REDACTED_SUPPLIED,
	readModelsDocument,
	redactJson,
	renderProviderDiff,
	semanticJsonEqual,
	stripJsonComments,
	validateApiKey,
	validateBaseUrl,
	validateModelSelection,
	validateProviderId,
} from "../src/models-config.ts";

function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "pi-preset-models-config-test-"));
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

function modelIds(models: readonly JsonValue[]): string[] {
	return models.map((model) => {
		if (!isPlainObject(model) || typeof model.id !== "string") throw new Error("test model is not an object");
		return model.id;
	});
}

function readyPlan(plan: ReturnType<typeof planProviderUpsert>) {
	if (plan.status === "blocked") throw new Error(plan.message);
	return plan;
}

test("provider identifiers enforce the approved pattern and reserved names", () => {
	assert.equal(validateProviderId("provider-id_01.v2"), undefined);
	assert.match(validateProviderId("") ?? "", /cannot be empty/);
	assert.match(validateProviderId("-starts-with-hyphen") ?? "", /start with/);
	assert.match(validateProviderId("a".repeat(65)) ?? "", /64/);
	for (const reserved of ["__proto__", "prototype", "constructor"]) {
		assert.match(validateProviderId(reserved) ?? "", /reserved/);
	}
});

test("base URL validation normalizes supported URLs and rejects credentials or unsupported syntax", () => {
	assert.equal(normalizeBaseUrl(" https://api.example.invalid/v1 "), "https://api.example.invalid/v1");
	assert.equal(validateBaseUrl("http://api.example.invalid"), undefined);
	assert.match(validateBaseUrl("ftp://api.example.invalid") ?? "", /http or https/);
	assert.match(validateBaseUrl("https://user:password@api.example.invalid") ?? "", /username or password/);
	assert.match(validateBaseUrl("https://api.example.invalid/v1?token=hidden") ?? "", /query or fragment/);
	assert.match(validateBaseUrl("not-a-url") ?? "", /valid HTTP or HTTPS/);
});

test("API keys and model selections are validated without echoing secret input", () => {
	const key = runtimeKey();
	assert.equal(validateApiKey(` ${key} `), undefined);
	const emptyError = validateApiKey(" \t");
	assert.match(emptyError ?? "", /cannot be empty/);
	assert.equal((emptyError ?? "").includes(key), false);
	assert.match(validateModelSelection("openai", []) ?? "", /at least one/);
	assert.match(validateModelSelection("openai", ["not-in-catalog"]) ?? "", /unsupported/);
	assert.deepEqual(normalizeSelectedModelIds("openai", ["gpt-5.6-luna", "gpt-5.6-sol"]), [
		"gpt-5.6-sol",
		"gpt-5.6-luna",
	]);
});

test("Pi JSONC comments and trailing commas are accepted and the root is normalized", () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		secureWrite(path, '// a comment\n{ "other": { "url": "https://example.invalid/a//b", }, }\n');
		const document = readModelsDocument(path);
		assert.deepEqual(document.data, { other: { url: "https://example.invalid/a//b" }, providers: {} });
		assert.equal(document.raw?.includes("// a comment"), true);
		assert.equal(
			stripJsonComments('{"url":"https://example.invalid/a//b",}'),
			'{"url":"https://example.invalid/a//b"}',
		);
	} finally {
		cleanup(home);
	}
});

test("invalid JSON, non-object roots, non-object providers, broad modes, and dangling links block before write", async () => {
	const home = makeHome();
	try {
		const invalidPath = join(home, "invalid.json");
		secureWrite(invalidPath, "{ not json");
		assert.throws(() => readModelsDocument(invalidPath), /not valid JSON/);

		const arrayPath = join(home, "array.json");
		secureWrite(arrayPath, "[]");
		assert.throws(() => readModelsDocument(arrayPath), /JSON object/);

		const providersPath = join(home, "providers.json");
		secureWrite(providersPath, '{ "providers": [] }');
		assert.throws(() => readModelsDocument(providersPath), /non-object "providers"/);

		for (const platform of ["linux", "darwin"] as const) {
			const broadPath = join(home, `${platform}-broad.json`);
			secureWrite(broadPath, '{ "providers": {} }');
			chmodSync(broadPath, 0o640);
			await withPlatform(platform, () => {
				assert.throws(() => readModelsDocument(broadPath), /chmod 600/);
			});
		}

		const danglingPath = join(home, "dangling.json");
		symlinkSync(join(home, "missing-target.json"), danglingPath);
		assert.throws(() => readModelsDocument(danglingPath), /dangling symlink/);
	} finally {
		cleanup(home);
	}
});

test("Windows writable files skip the POSIX group/other permission gate", async () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		secureWrite(path, '{ "providers": {} }');
		chmodSync(path, 0o666);
		const document = await withPlatform("win32", () => readModelsDocument(path));
		assert.equal(document.exists, true);
		assert.deepEqual(document.data, { providers: {} });
	} finally {
		cleanup(home);
	}
});

test("candidate construction emits only selected catalog models with complete metadata", () => {
	const candidate = buildProviderCandidate(
		"anthropic",
		["claude-sonnet-5", "claude-fable-5"],
		"https://api.example.invalid/v1",
		runtimeKey(),
	);
	assert.equal(candidate.api, "anthropic-messages");
	assert.deepEqual(modelIds(candidate.models), ["claude-fable-5", "claude-sonnet-5"]);
	assert.deepEqual(candidate.compat, {
		supportsEagerToolInputStreaming: false,
		supportsLongCacheRetention: true,
		forceAdaptiveThinking: true,
		supportsStrictTools: true,
	});
	assert.equal(modelIds(candidate.models).includes("claude-opus-5"), false);
});

test("plans add, exact no-op, and replacement states", () => {
	const key = runtimeKey();
	const candidate = buildProviderCandidate("deepseek", ["deepseek-v4-flash"], "https://api.example.invalid/v1", key);
	const add = readyPlan(planProviderUpsert({ providers: {} }, "provider-id", candidate, "/tmp/models.json"));
	assert.equal(add.status, "add");
	assert.equal(
		add.diff.some((line) => line.includes(key)),
		false,
	);

	const exact = readyPlan(planProviderUpsert({ providers: { "provider-id": candidate } }, "provider-id", candidate));
	assert.equal(exact.status, "already-configured");
	assert.deepEqual(exact.diff, []);

	const firstModel = candidate.models[0];
	if (!isPlainObject(firstModel)) throw new Error("test model is not an object");
	const changed = { ...candidate, models: [...candidate.models, { ...firstModel, id: "stale-model" }] };
	const replace = readyPlan(planProviderUpsert({ providers: { "provider-id": changed } }, "provider-id", candidate));
	assert.equal(replace.status, "replace");
	assert.ok(replace.diff.some((line) => line.includes(REDACTED_EXISTING)));
	assert.ok(replace.diff.some((line) => line.includes(REDACTED_SUPPLIED)));
	assert.equal(
		replace.diff.some((line) => line.includes(key)),
		false,
	);

	const blocked = planProviderUpsert({ providers: {} }, "__proto__", candidate);
	assert.equal(blocked.status, "blocked");
});

test("recursive redaction distinguishes existing and supplied secrets, including nested headers", () => {
	const key = runtimeKey();
	const value = {
		apiKey: key,
		headers: { Authorization: key, nested: { token: key }, safe: "not-secret" },
		nested: { password: key, clientSecret: key, "x-api-key": key, value: "keep" },
	};
	const existing = redactJson(value, "existing");
	const supplied = redactJson(value, "supplied");
	assert.equal(JSON.stringify(existing).includes(key), false);
	assert.equal(JSON.stringify(supplied).includes(key), false);
	assert.equal((existing as { apiKey: string }).apiKey, REDACTED_EXISTING);
	assert.equal((supplied as { apiKey: string }).apiKey, REDACTED_SUPPLIED);
	assert.equal((existing as { nested: { value: string } }).nested.value, "keep");
	assert.equal((existing as { nested: { "x-api-key": string } }).nested["x-api-key"], REDACTED_EXISTING);
});

test("provider-only diff is deterministic and never includes the supplied key", () => {
	const key = runtimeKey();
	const candidate = buildProviderCandidate("openai", ["gpt-5.6-sol"], "https://api.example.invalid/v1", key);
	const diff = renderProviderDiff("provider-id", { apiKey: runtimeKey(), keep: true }, candidate);
	assert.equal(diff[0]?.startsWith('- providers["provider-id"]'), true);
	assert.equal(
		diff.some((line) => line.includes(key)),
		false,
	);
	assert.equal(
		diff.some((line) => line.includes("<redacted-existing>")),
		true,
	);
	assert.equal(
		diff.some((line) => line.includes("<redacted-supplied>")),
		true,
	);
});

test("semantic equality ignores object order but preserves array order", () => {
	assert.equal(semanticJsonEqual({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 }), true);
	assert.equal(semanticJsonEqual([1, 2], [2, 1]), false);
	assert.equal(semanticJsonEqual(undefined, undefined), true);
	assert.equal(semanticJsonEqual(undefined, null), false);
});

test("malformed non-object provider values are fully redacted in replacement previews", () => {
	const key = runtimeKey();
	const candidate = buildProviderCandidate("deepseek", ["deepseek-v4-flash"], "https://api.example.invalid/v1", key);
	const existingValue = runtimeKey();
	const diff = renderProviderDiff("provider-id", existingValue, candidate);
	assert.equal(diff.join("\n").includes(existingValue), false);
	assert.equal(diff.join("\n").includes(key), false);
	assert.equal(diff.join("\n").includes(REDACTED_EXISTING), true);
});
