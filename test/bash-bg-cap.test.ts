import assert from "node:assert/strict";
import { test } from "node:test";
import { CAP_SECONDS, cappedTimeout, DEFAULT_SECONDS, readConfig } from "../src/bash-bg-cap.ts";

const config = { defaultSeconds: 30, capSeconds: 60 };

test("defaults are 30s when absent and a 60s cap", () => {
	assert.equal(DEFAULT_SECONDS, 30);
	assert.equal(CAP_SECONDS, 60);
	assert.deepEqual(readConfig({}), { defaultSeconds: 30, capSeconds: 60 });
});

test("missing timeout gets the default; large ones are capped; small ones are left alone", () => {
	assert.equal(cappedTimeout({ command: "npm test" }, config), 30);
	assert.equal(cappedTimeout({ command: "npm run build", timeout: 600 }, config), 60);
	assert.equal(cappedTimeout({ command: "npm run build", timeout: 60 }, config), undefined);
	assert.equal(cappedTimeout({ command: "ls", timeout: 10 }, config), undefined, "never raised");
	assert.equal(cappedTimeout({ command: "ls", timeout: 0 }, config), 30, "invalid timeout treated as missing");
});

test("background runs and sleep-first commands are never touched", () => {
	assert.equal(cappedTimeout({ command: "npm run dev", run_in_background: true, timeout: 600 }, config), undefined);
	// pi-patty-bg-tasks kills (not backgrounds) these when the timer fires.
	assert.equal(cappedTimeout({ command: "sleep 1; make", timeout: 600 }, config), undefined);
	assert.equal(cappedTimeout({ command: "  sleep 0.5 && make" }, config), undefined);
	assert.equal(cappedTimeout({ command: "make sleepy" }, config), 30);
	assert.equal(cappedTimeout({ timeout: 600 }, config), undefined, "no command, no change");
});

test("env overrides, off switch, and bad values", () => {
	assert.deepEqual(readConfig({ PI_PRESET_BASH_BG_DEFAULT: "20", PI_PRESET_BASH_BG_CAP: "90" }), {
		defaultSeconds: 20,
		capSeconds: 90,
	});
	assert.equal(readConfig({ PI_PRESET_BASH_BG_CAP: "off" }), undefined);
	assert.equal(readConfig({ PI_PRESET_BASH_BG_DEFAULT: "OFF" }), undefined);
	assert.deepEqual(readConfig({ PI_PRESET_BASH_BG_DEFAULT: "abc", PI_PRESET_BASH_BG_CAP: "-5" }), {
		defaultSeconds: 30,
		capSeconds: 60,
	});
	assert.deepEqual(readConfig({ PI_PRESET_BASH_BG_DEFAULT: "120" }), { defaultSeconds: 60, capSeconds: 60 }, "default never exceeds cap");
});
