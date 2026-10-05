import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDefaultCacheRetention, CACHE_RETENTION_ENV } from "../src/cache-retention.ts";

test("unset or empty PI_CACHE_RETENTION defaults to long", () => {
	const unset: NodeJS.ProcessEnv = {};
	assert.equal(applyDefaultCacheRetention(unset), true);
	assert.equal(unset[CACHE_RETENTION_ENV], "long");

	const empty: NodeJS.ProcessEnv = { [CACHE_RETENTION_ENV]: "" };
	assert.equal(applyDefaultCacheRetention(empty), true);
	assert.equal(empty[CACHE_RETENTION_ENV], "long");
});

test("an explicit PI_CACHE_RETENTION is left untouched", () => {
	const env: NodeJS.ProcessEnv = { [CACHE_RETENTION_ENV]: "short" };
	assert.equal(applyDefaultCacheRetention(env), false);
	assert.equal(env[CACHE_RETENTION_ENV], "short");
});
