import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFERRED_TOOLS,
	announceDeferred,
	deferredToolsEnabled,
	deferredToolsGuideline,
	withExposure,
} from "../src/deferred-tools.ts";

type Tool = { name: string; exposure?: string };

function fakePi(registered: Tool[] = [], active: string[] = []) {
	const handlers: Record<string, ((event: any) => void)[]> = {};
	return {
		registered,
		active,
		handlers,
		registerTool(definition: Tool) {
			registered.push(definition);
		},
		getAllTools() {
			return registered.map((tool) => ({ ...tool, exposure: tool.exposure ?? "direct" }));
		},
		getActiveTools() {
			return [...active];
		},
		setActiveTools(names: string[]) {
			active.splice(0, active.length, ...names);
		},
		on(name: string, handler: (event: any) => void) {
			(handlers[name] ??= []).push(handler);
		},
		fire(name: string, event: any) {
			for (const handler of handlers[name] ?? []) handler(event);
		},
	};
}

test("withExposure defers only the named tools and passes other members through", () => {
	const pi = fakePi();
	const wrapped = withExposure(pi as never, ["monitor"]);
	wrapped.registerTool({ name: "monitor" } as never);
	wrapped.registerTool({ name: "jobs" } as never);
	assert.deepEqual(pi.registered, [{ name: "monitor", exposure: "deferred" }, { name: "jobs" }]);
	assert.deepEqual(wrapped.getActiveTools(), []);
});

test("announceDeferred activates codemode once and adds one rules line for deferred tools", () => {
	const pi = fakePi(
		[
			{ name: "codemode", exposure: "codemode" },
			{ name: "monitor", exposure: "deferred" },
			{ name: "agent_bg", exposure: "deferred" },
			{ name: "web_search", exposure: "direct" },
		],
		["read", "bash"],
	);
	announceDeferred(pi as never, DEFERRED_TOOLS["bg-tasks"]);
	announceDeferred(pi as never, DEFERRED_TOOLS["web-search"]);
	assert.equal(pi.handlers.session_start?.length, 1, "one session_start hook for both wrappers");

	pi.fire("session_start", {});
	assert.deepEqual(pi.active, ["read", "bash", "codemode"]);

	const event = { systemPromptOptions: { selectedTools: ["read", "bash", "codemode"], toolGuidelines: {} as Record<string, string[]> } };
	pi.fire("before_agent_start", event);
	// web_search is still direct in this fake, so it is not announced.
	assert.deepEqual(event.systemPromptOptions.toolGuidelines.codemode, [deferredToolsGuideline(["monitor", "agent_bg"])]);

	const noCodemode = { systemPromptOptions: { selectedTools: ["read"], toolGuidelines: {} as Record<string, string[]> } };
	pi.fire("before_agent_start", noCodemode);
	assert.equal(noCodemode.systemPromptOptions.toolGuidelines.codemode, undefined);
});

test("PI_PRESET_DEFERRED_TOOLS=off keeps tools direct; the guideline names the search call", () => {
	assert.equal(deferredToolsEnabled("off"), false);
	assert.equal(deferredToolsEnabled(undefined), true);
	assert.match(deferredToolsGuideline(["monitor"]), /searchTools.*monitor/);
});
