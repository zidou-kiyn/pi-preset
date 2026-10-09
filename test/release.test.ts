import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error plain .mjs script without types
import { nextVersion } from "../scripts/release.mjs";
import { presetVersion } from "../src/version.ts";

test("nextVersion bumps semver parts and accepts an explicit version", () => {
	assert.equal(nextVersion("0.2.0", "patch"), "0.2.1");
	assert.equal(nextVersion("0.2.3", "minor"), "0.3.0");
	assert.equal(nextVersion("0.2.3", "major"), "1.0.0");
	assert.equal(nextVersion("0.2.3", "0.9.1"), "0.9.1");
	assert.throws(() => nextVersion("0.2.3", "huge"));
});

test("presetVersion reads package.json and tolerates a non-git directory", () => {
	const dir = mkdtempSync(join(tmpdir(), "preset-version-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
	assert.match(presetVersion(dir), /^1\.2\.3( \([0-9a-f]+\))?$/u);
});
