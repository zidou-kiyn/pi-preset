import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildProviderCandidate,
	type ProviderPlan,
	planProviderUpsert,
	type ReadyProviderPlan,
	readModelsDocument,
} from "../src/models-config.ts";
import { applyProviderPlan } from "../src/models-config-apply.ts";

function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "pi-preset-models-apply-test-"));
}

function cleanup(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

function runtimeKey(): string {
	return `runtime-${randomBytes(18).toString("hex")}`;
}

function candidate(family: "anthropic" | "openai" | "deepseek", models: readonly string[], key = runtimeKey()) {
	return buildProviderCandidate(family, models, "https://api.example.invalid/v1", key);
}

function secureWrite(path: string, content: string): void {
	writeFileSync(path, content);
	chmodSync(path, 0o600);
}

function readyPlan(plan: ProviderPlan): ReadyProviderPlan {
	if (plan.status === "blocked") throw new Error(plan.message);
	return plan;
}

test("add preserves unrelated top-level fields and sibling providers", () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		secureWrite(
			path,
			JSON.stringify({
				customTopLevel: { keep: [1, 2, 3] },
				providers: { sibling: { keep: true, models: ["outside-catalog"] } },
			}),
		);
		const provider = candidate("openai", ["gpt-5.6-sol", "gpt-5.6-luna"]);
		const before = readModelsDocument(path);
		const plan = planProviderUpsert(before.data, "provider-id", provider, before.targetPath);
		assert.equal(plan.status, "add");
		const result = applyProviderPlan(readyPlan(plan), path);
		assert.equal(result.changed, true);
		const after = JSON.parse(readFileSync(path, "utf8"));
		assert.deepEqual(after.customTopLevel, { keep: [1, 2, 3] });
		assert.deepEqual(after.providers.sibling, { keep: true, models: ["outside-catalog"] });
		assert.deepEqual(
			after.providers["provider-id"].models.map((model: { id: string }) => model.id),
			["gpt-5.6-sol", "gpt-5.6-luna"],
		);
	} finally {
		cleanup(home);
	}
});

test("replacement replaces the provider object as a unit without stale fields", () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		const old = {
			baseUrl: "https://old.example.invalid/v1",
			apiKey: runtimeKey(),
			api: "openai-responses",
			compat: { supportsDeveloperRole: false, staleCompatibility: true },
			models: [{ id: "stale-model", custom: true }],
		};
		secureWrite(path, JSON.stringify({ providers: { "provider-id": old, sibling: { keep: true } } }));
		const provider = candidate("openai", ["gpt-5.6-terra"]);
		const before = readModelsDocument(path);
		const plan = planProviderUpsert(before.data, "provider-id", provider, before.targetPath);
		assert.equal(plan.status, "replace");
		applyProviderPlan(readyPlan(plan), path);
		const after = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(after.providers["provider-id"].models[0].id, "gpt-5.6-terra");
		assert.equal("staleCompatibility" in after.providers["provider-id"].compat, false);
		assert.equal("stale-model" === after.providers["provider-id"].models[0].id, false);
		assert.deepEqual(after.providers.sibling, { keep: true });
	} finally {
		cleanup(home);
	}
});

test("commented input is normalized after writing while backup retains original bytes", () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		const original = '// preserve in backup\n{ "top": { "keep": true, }, "providers": {}, }\n';
		secureWrite(path, original);
		const before = readModelsDocument(path);
		const plan = planProviderUpsert(
			before.data,
			"provider-id",
			candidate("deepseek", ["deepseek-v4-flash"]),
			before.targetPath,
		);
		applyProviderPlan(readyPlan(plan), path);
		assert.equal(readFileSync(`${path}.preset-bak`, "utf8"), original);
		assert.equal(readFileSync(path, "utf8").includes("// preserve in backup"), false);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).top, { keep: true });
	} finally {
		cleanup(home);
	}
});

test("provider target TOCTOU conflict aborts without changing the latest file", () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		secureWrite(path, JSON.stringify({ providers: {} }));
		const before = readModelsDocument(path);
		const plan = planProviderUpsert(
			before.data,
			"provider-id",
			candidate("deepseek", ["deepseek-v4-flash"]),
			before.targetPath,
		);
		const concurrent = candidate("openai", ["gpt-5.6-sol"]);
		secureWrite(path, JSON.stringify({ providers: { "provider-id": concurrent, sibling: { keep: true } } }));
		assert.throws(() => applyProviderPlan(readyPlan(plan), path), /changed after preview/);
		const after = JSON.parse(readFileSync(path, "utf8"));
		assert.deepEqual(after.providers["provider-id"], concurrent);
		assert.deepEqual(after.providers.sibling, { keep: true });
		assert.equal(statSync(`${path}.preset-bak`, { throwIfNoEntry: false }), undefined);
	} finally {
		cleanup(home);
	}
});

test("unrelated concurrent sibling changes survive when the target is unchanged", () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		secureWrite(path, JSON.stringify({ providers: { sibling: { before: true } }, top: "before" }));
		const before = readModelsDocument(path);
		const plan = planProviderUpsert(
			before.data,
			"provider-id",
			candidate("anthropic", ["claude-fable-5"]),
			before.targetPath,
		);
		secureWrite(path, JSON.stringify({ providers: { sibling: { before: true, concurrent: true } }, top: "after" }));
		applyProviderPlan(readyPlan(plan), path);
		const after = JSON.parse(readFileSync(path, "utf8"));
		assert.deepEqual(after.providers.sibling, { before: true, concurrent: true });
		assert.equal(after.top, "after");
		assert.equal(after.providers["provider-id"].models[0].id, "claude-fable-5");
	} finally {
		cleanup(home);
	}
});

test("exact no-op does not create a backup or rewrite the file", async () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		const provider = candidate("deepseek", ["deepseek-v4-flash"]);
		secureWrite(path, JSON.stringify({ providers: { "provider-id": provider } }));
		const before = readModelsDocument(path);
		const plan = planProviderUpsert(before.data, "provider-id", provider, before.targetPath);
		assert.equal(plan.status, "already-configured");
		const beforeBytes = readFileSync(path);
		const beforeMtime = statSync(path).mtimeMs;
		await new Promise((resolveWait) => setTimeout(resolveWait, 10));
		const result = applyProviderPlan(readyPlan(plan), path);
		assert.equal(result.changed, false);
		assert.deepEqual(readFileSync(path), beforeBytes);
		assert.equal(statSync(path).mtimeMs, beforeMtime);
		assert.equal(statSync(`${path}.preset-bak`, { throwIfNoEntry: false }), undefined);
	} finally {
		cleanup(home);
	}
});

test("valid symlink apply keeps the link and owner-only target mode", () => {
	const home = makeHome();
	try {
		const target = join(home, "real.json");
		const path = join(home, "models.json");
		const original = JSON.stringify({ providers: {} });
		secureWrite(target, original);
		symlinkSync(target, path);
		const before = readModelsDocument(path);
		const plan = planProviderUpsert(
			before.data,
			"provider-id",
			candidate("openai", ["gpt-5.6-terra"]),
			before.targetPath,
		);
		applyProviderPlan(readyPlan(plan), path);
		assert.equal(lstatSync(path).isSymbolicLink(), true);
		assert.equal(statSync(target).mode & 0o777, 0o600);
		assert.equal(JSON.parse(readFileSync(target, "utf8")).providers["provider-id"].models[0].id, "gpt-5.6-terra");
		assert.equal(readFileSync(`${target}.preset-bak`, "utf8"), original);
		assert.equal(statSync(`${target}.preset-bak`).mode & 0o777, 0o600);
	} finally {
		cleanup(home);
	}
});

test("retargeted or newly dangling symlinks abort without writing either target", () => {
	const home = makeHome();
	try {
		const firstTarget = join(home, "first.json");
		const secondTarget = join(home, "second.json");
		const path = join(home, "models.json");
		secureWrite(firstTarget, JSON.stringify({ providers: {}, target: "first" }));
		secureWrite(secondTarget, JSON.stringify({ providers: {}, target: "second" }));
		symlinkSync(firstTarget, path);
		const before = readModelsDocument(path);
		const plan = planProviderUpsert(
			before.data,
			"provider-id",
			candidate("deepseek", ["deepseek-v4-flash"]),
			before.targetPath,
		);

		unlinkSync(path);
		symlinkSync(secondTarget, path);
		assert.throws(() => applyProviderPlan(readyPlan(plan), path), /changed after preview/);
		assert.equal(JSON.parse(readFileSync(firstTarget, "utf8")).target, "first");
		assert.equal(JSON.parse(readFileSync(secondTarget, "utf8")).target, "second");

		unlinkSync(path);
		symlinkSync(join(home, "missing.json"), path);
		assert.throws(() => applyProviderPlan(readyPlan(plan), path), /dangling symlink/);
		assert.equal(statSync(`${firstTarget}.preset-bak`, { throwIfNoEntry: false }), undefined);
		assert.equal(statSync(`${secondTarget}.preset-bak`, { throwIfNoEntry: false }), undefined);
	} finally {
		cleanup(home);
	}
});
