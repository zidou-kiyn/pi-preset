import assert from "node:assert/strict";
import { test } from "node:test";
import workingStyle from "../extensions/working-style.ts";
import { SECTION_NAME, WORKING_STYLE, workingStyleEnabled } from "../src/working-style.ts";

type Handler = (event: { systemPromptOptions: { sections: Record<string, string> } }) => void;

function load(env: string | undefined): Handler | undefined {
	const saved = process.env.PI_PRESET_WORKING_STYLE;
	if (env === undefined) delete process.env.PI_PRESET_WORKING_STYLE;
	else process.env.PI_PRESET_WORKING_STYLE = env;
	let handler: Handler | undefined;
	try {
		workingStyle({ on: (name: string, fn: Handler) => name === "before_agent_start" && (handler = fn) } as never);
	} finally {
		if (saved === undefined) delete process.env.PI_PRESET_WORKING_STYLE;
		else process.env.PI_PRESET_WORKING_STYLE = saved;
	}
	return handler;
}

test("adds the working-style section; a valid pi section name", () => {
	const handler = load(undefined);
	assert.ok(handler);
	const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
	handler(event);
	assert.equal(event.systemPromptOptions.sections[SECTION_NAME], WORKING_STYLE);
	assert.match(SECTION_NAME, /^[a-z][a-z0-9_-]*$/);
});

test("PI_PRESET_WORKING_STYLE=off disables it", () => {
	assert.equal(load("off"), undefined);
	assert.equal(workingStyleEnabled("0"), false);
	assert.equal(workingStyleEnabled(""), true);
	assert.equal(workingStyleEnabled("on"), true);
});

test("the section stays short and says nothing about re-verifying", () => {
	assert.ok(WORKING_STYLE.length < 1200, `${WORKING_STYLE.length} chars`);
	assert.doesNotMatch(WORKING_STYLE, /double-check|re-verify|verify your/i);
});
