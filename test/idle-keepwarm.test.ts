import assert from "node:assert/strict";
import { test } from "node:test";
import {
	detectRetention,
	formatClock,
	formatRemaining,
	isCacheMiss,
	isWarmReplay,
	parseDuration,
	parseMaxWarms,
	publishSnapshot,
	readConfig,
	readSnapshot,
	refreshDelayMs,
	ttlMsFor,
	warmPayload,
} from "../src/idle-keepwarm.ts";

// UI text is asserted in English whatever the system locale.
process.env.PI_PRESET_LANG = "en";

test("config: on by default, no idle limit, 7 refreshes; off and limits come from env", () => {
	assert.deepEqual(readConfig({}), { enabled: true, maxIdleMs: Number.POSITIVE_INFINITY, maxWarms: 7 });
	assert.equal(readConfig({ PI_PRESET_KEEPWARM_MAX_WARMS: "5" }).maxWarms, 5);
	assert.equal(readConfig({ PI_PRESET_KEEPWARM: "off" }).enabled, false);
	assert.equal(readConfig({ PI_PRESET_KEEPWARM_MAX_IDLE: "3h" }).maxIdleMs, 3 * 60 * 60_000);
	assert.equal(readConfig({ PI_PRESET_KEEPWARM_EVERY_SEC: "20" }).everyMs, 20_000);
});

test("durations parse minutes and hours; off/invalid means no limit", () => {
	assert.equal(parseDuration("90m"), 90 * 60_000);
	assert.equal(parseDuration("45"), 45 * 60_000);
	assert.equal(parseDuration("1.5h"), 90 * 60_000);
	assert.equal(parseDuration("off"), undefined);
	assert.equal(parseDuration("forever"), undefined);
	assert.equal(parseDuration(undefined), undefined);
});

test("refresh limit: a positive integer, off/0 means none, invalid keeps the default", () => {
	assert.equal(parseMaxWarms("8"), 8);
	assert.equal(parseMaxWarms("off"), Number.POSITIVE_INFINITY);
	assert.equal(parseMaxWarms("0"), Number.POSITIVE_INFINITY);
	assert.equal(parseMaxWarms("1.5"), 7);
	assert.equal(parseMaxWarms("-2"), 7);
	assert.equal(parseMaxWarms(""), 7);
	assert.equal(parseMaxWarms(undefined), 7);
});

test("1-token caps are warm replays, real requests are not", () => {
	assert.equal(isWarmReplay({ max_tokens: 1 }), true);
	assert.equal(isWarmReplay({ max_tokens: 128_000 }), false);
	assert.equal(isWarmReplay({}), false);
});

test("retention comes from the cache_control TTL anywhere in the prefix", () => {
	assert.equal(detectRetention({ messages: [{ role: "user", content: "hi" }] }), undefined);
	assert.equal(
		detectRetention({ system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }] }),
		"short",
	);
	assert.equal(
		detectRetention({
			system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
			messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }] }],
		}),
		"long",
	);
});

test("TTL prefers the model's promptCache and refreshes at 90%", () => {
	assert.equal(ttlMsFor({ short: 300, long: 3600 }, "long"), 3_600_000);
	assert.equal(ttlMsFor(undefined, "short"), 300_000);
	assert.equal(refreshDelayMs(3_600_000), 3_240_000);
	assert.equal(refreshDelayMs(300_000), 270_000);
	assert.equal(refreshDelayMs(3_600_000, 20_000), 20_000);
});

test("the warm payload only caps output", () => {
	const payload = { model: "m", max_tokens: 128_000, messages: [{ role: "user", content: "x" }], betas: ["b"] };
	assert.deepEqual(warmPayload(payload), { ...payload, max_tokens: 1, stream: true });
	assert.equal(payload.max_tokens, 128_000);
});

test("a refresh that reads less than half its prompt from cache is a miss", () => {
	assert.equal(isCacheMiss({ input: 3, cacheRead: 150_000, cacheWrite: 0 }), false);
	assert.equal(isCacheMiss({ input: 3, cacheRead: 0, cacheWrite: 150_000 }), true);
	assert.equal(isCacheMiss({ input: 3, cacheRead: 10_000, cacheWrite: 140_000 }), true);
	assert.equal(isCacheMiss(undefined), false);
});

test("countdown is whole minutes, hours past 60m", () => {
	assert.equal(formatRemaining(30_000), "<1m");
	assert.equal(formatRemaining(47 * 60_000 + 59_000), "47m");
	assert.equal(formatRemaining(60 * 60_000), "1h");
	assert.equal(formatRemaining(65 * 60_000), "1h05m");
	assert.equal(formatClock(new Date(2026, 0, 1, 9, 5).getTime()), "09:05");
});

test("the snapshot is shared through a global registry symbol", () => {
	publishSnapshot({ expiresAt: 1, warms: 2 });
	assert.deepEqual(readSnapshot(), { expiresAt: 1, warms: 2 });
	publishSnapshot(undefined);
	assert.equal(readSnapshot(), undefined);
});
