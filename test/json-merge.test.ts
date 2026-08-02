import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertModeOnPosix } from "./platform-test-utils.ts";
import { apply } from "../src/apply.ts";
import { deepMerge, type JsonObject, readJsonObject, writeJsonObjectAtomic } from "../src/json-merge.ts";
import type { SyncPlan } from "../src/plan.ts";

function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "pi-preset-json-merge-test-"));
}

function cleanup(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

test("deepMerge preserves unrelated nested fields and replaces arrays as units", () => {
	assert.deepEqual(
		deepMerge({ nested: { keep: true, change: "old" }, list: [1, 2] }, { nested: { change: "new" }, list: [3] }),
		{ nested: { keep: true, change: "new" }, list: [3] },
	);
});

test("legacy readJsonObject behavior remains strict JSON and non-destructive", () => {
	const home = makeHome();
	try {
		const missing = readJsonObject(join(home, "missing.json"));
		assert.deepEqual(missing, { exists: false, data: {} });
		const emptyPath = join(home, "empty.json");
		writeFileSync(emptyPath, "");
		assert.deepEqual(readJsonObject(emptyPath), { exists: true, data: {} });
		writeFileSync(emptyPath, "[]");
		assert.throws(() => readJsonObject(emptyPath), /JSON object/);
	} finally {
		cleanup(home);
	}
});

test("new model files use exact 0600 mode and leave no temporary sibling", () => {
	const home = makeHome();
	try {
		const path = join(home, "nested", "models.json");
		writeJsonObjectAtomic(path, { providers: {} }, { newFileMode: 0o600, rejectDanglingSymlink: true });
		assertModeOnPosix(path, 0o600);
		assert.deepEqual(
			readdirSync(join(home, "nested")).filter((name) => name.includes("preset.tmp")),
			[],
		);
	} finally {
		cleanup(home);
	}
});

test("existing owner-only modes and original backup bytes are preserved", () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		const original = '// comment\n{ "providers": {}, }\n';
		writeFileSync(path, original);
		chmodSync(path, 0o400);
		writeJsonObjectAtomic(path, { providers: { added: true } }, { newFileMode: 0o600, rejectDanglingSymlink: true });
		assertModeOnPosix(path, 0o400);
		assert.equal(readFileSync(`${path}.preset-bak`, "utf8"), original);
		assertModeOnPosix(`${path}.preset-bak`, 0o400);
	} finally {
		cleanup(home);
	}
});

test("legacy callers still preserve a broader existing mode when no opt-in gate is passed", () => {
	const home = makeHome();
	try {
		const path = join(home, "settings.json");
		writeFileSync(path, '{ "keep": true }');
		chmodSync(path, 0o640);
		writeJsonObjectAtomic(path, { keep: true, changed: true });
		assertModeOnPosix(path, 0o640);
	} finally {
		cleanup(home);
	}
});

test("valid symlinks are followed and dangling symlinks are rejected", () => {
	const home = makeHome();
	try {
		const target = join(home, "real-models.json");
		const link = join(home, "models.json");
		writeFileSync(target, '{ "providers": {} }');
		chmodSync(target, 0o600);
		symlinkSync(target, link);
		writeJsonObjectAtomic(
			link,
			{ providers: { selected: true } },
			{ newFileMode: 0o600, rejectDanglingSymlink: true },
		);
		assert.equal(lstatSync(link).isSymbolicLink(), true);
		assert.equal(JSON.parse(readFileSync(target, "utf8")).providers.selected, true);
		assert.equal(existsSync(`${target}.preset-bak`), true);

		const dangling = join(home, "dangling.json");
		symlinkSync(join(home, "does-not-exist.json"), dangling);
		assert.throws(
			() => writeJsonObjectAtomic(dangling, { providers: {} }, { newFileMode: 0o600, rejectDanglingSymlink: true }),
			/dangling symlink/,
		);
		assert.equal(lstatSync(dangling).isSymbolicLink(), true);
	} finally {
		cleanup(home);
	}
});

test("unique temporary files do not reuse the legacy static tmp path", () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		const legacyTmp = `${path}.preset.tmp`;
		writeFileSync(legacyTmp, "leave me alone");
		writeJsonObjectAtomic(path, { providers: {} }, { newFileMode: 0o600 });
		assert.equal(readFileSync(legacyTmp, "utf8"), "leave me alone");
		assert.deepEqual(
			readdirSync(home).filter((name) => name.includes("preset.tmp-")),
			[],
		);
	} finally {
		cleanup(home);
	}
});

test("serialization failures leave the target, backup, and temporary files untouched", () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		const original = '{ "providers": {} }';
		writeFileSync(path, original);
		chmodSync(path, 0o600);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		assert.throws(() => writeJsonObjectAtomic(path, cyclic as JsonObject), /circular/i);
		assert.equal(readFileSync(path, "utf8"), original);
		assert.equal(existsSync(`${path}.preset-bak`), false);
		assert.deepEqual(
			readdirSync(home).filter((name) => name.includes("preset.tmp") || name.includes("preset.bak-tmp")),
			[],
		);
	} finally {
		cleanup(home);
	}
});

test("backup creation never follows a pre-existing backup symlink", () => {
	const home = makeHome();
	try {
		const path = join(home, "models.json");
		const backupPath = `${path}.preset-bak`;
		const unrelated = join(home, "unrelated.txt");
		const original = '{ "providers": { "before": true } }';
		writeFileSync(path, original);
		chmodSync(path, 0o600);
		writeFileSync(unrelated, "must remain unchanged");
		symlinkSync(unrelated, backupPath);

		writeJsonObjectAtomic(path, { providers: { after: true } }, { newFileMode: 0o600 });

		assert.equal(readFileSync(unrelated, "utf8"), "must remain unchanged");
		assert.equal(lstatSync(backupPath).isSymbolicLink(), false);
		assert.equal(readFileSync(backupPath, "utf8"), original);
		assertModeOnPosix(backupPath, 0o600);
	} finally {
		cleanup(home);
	}
});

test("legacy preset-sync callers retain merge behavior and existing modes", async () => {
	const home = makeHome();
	try {
		const settingsPath = join(home, "settings.json");
		const webSearchPath = join(home, "web-search.json");
		writeFileSync(settingsPath, JSON.stringify({ keep: { nested: true }, packages: ["local-existing"] }));
		writeFileSync(webSearchPath, JSON.stringify({ keep: { nested: true }, webSearch: { extra: "preserve" } }));
		chmodSync(settingsPath, 0o640);
		chmodSync(webSearchPath, 0o640);
		const syncPlan: SyncPlan = {
			steps: [
				{ kind: "settings.packages.add", settingsPath, missing: ["npm:pi-preset-writer-regression"] },
				{
					kind: "json.patch",
					targetId: "web-search.json",
					configPath: webSearchPath,
					patch: { webSearch: { enabled: false }, ssrf: { trustEnvProxy: true } },
					changes: [
						{ key: "webSearch.enabled", path: ["webSearch", "enabled"], from: undefined, to: false },
						{ key: "ssrf.trustEnvProxy", path: ["ssrf", "trustEnvProxy"], from: undefined, to: true },
					],
				},
			],
			notes: [],
			blockers: [],
		};

		const result = await apply(syncPlan);
		assert.equal(result.ok, true);
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		const webSearch = JSON.parse(readFileSync(webSearchPath, "utf8"));
		assert.deepEqual(settings.keep, { nested: true });
		assert.deepEqual(settings.packages, ["local-existing", "npm:pi-preset-writer-regression"]);
		assert.deepEqual(webSearch.keep, { nested: true });
		assert.deepEqual(webSearch.webSearch, { extra: "preserve", enabled: false });
		assert.deepEqual(webSearch.ssrf, { trustEnvProxy: true });
		assertModeOnPosix(settingsPath, 0o640);
		assertModeOnPosix(webSearchPath, 0o640);
		assert.equal(existsSync(`${settingsPath}.preset-bak`), true);
		assert.equal(existsSync(`${webSearchPath}.preset-bak`), true);
	} finally {
		cleanup(home);
	}
});
