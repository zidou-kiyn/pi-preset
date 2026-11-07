import assert from "node:assert/strict";
import { test } from "node:test";

import { newestRelease } from "../scripts/upstream.mjs";

test("a tag track follows the newest release, not a prerelease", () => {
	// git's -version:refname order: a release candidate sorts above its base version and above older releases.
	assert.equal(newestRelease(["v2.0.0-rc.7", "v2.0.0-rc.6", "v1.10.0", "v1.9.0"]), "v1.10.0");
	assert.equal(newestRelease(["v2.0.0-rc.7", "v2.0.0", "v1.10.0"]), "v2.0.0");
	assert.equal(newestRelease(["v0.11.0", "v0.1.0-ee574a7"]), "v0.11.0");
	assert.equal(newestRelease(["v1.2.3+build.5", "v1.2.2"]), "v1.2.3+build.5");
	assert.equal(newestRelease(["v2.0.0-rc.1"]), undefined);
});
