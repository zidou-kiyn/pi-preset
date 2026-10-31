import assert from "node:assert/strict";
import { test } from "node:test";
import {
	announceDeferred,
	deferredToolsEnabled,
	deferredToolsGuideline,
	undeclaredDeferred,
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

test("announceDeferred activates codemode and adds one rules line naming undeclared deferred tools", () => {
	const pi = fakePi(
		[
			{ name: "codemode", exposure: "codemode" },
			{ name: "monitor", exposure: "deferred" },
			{ name: "agent_bg", exposure: "deferred" },
			{ name: "web_search", exposure: "deferred" },
			{ name: "jobs", exposure: "direct" },
		],
		["read", "bash", "monitor"], // monitor: declared by a session from before the upgrade
	);
	announceDeferred(pi as never);

	pi.fire("session_start", {});
	assert.deepEqual(pi.active, ["read", "bash", "monitor", "codemode"]);

	const event = { systemPromptOptions: { selectedTools: ["read", "bash", "monitor", "codemode"], toolGuidelines: {} as Record<string, string[]> } };
	pi.fire("before_agent_start", event);
	// One line, every deferred tool that is not declared, and not the declared monitor.
	assert.deepEqual(event.systemPromptOptions.toolGuidelines.codemode, [deferredToolsGuideline(["agent_bg", "web_search"])]);

	const noCodemode = { systemPromptOptions: { selectedTools: ["read"], toolGuidelines: {} as Record<string, string[]> } };
	pi.fire("before_agent_start", noCodemode);
	assert.equal(noCodemode.systemPromptOptions.toolGuidelines.codemode, undefined);
});

test("session_start leaves the active set alone when nothing is deferred", () => {
	const pi = fakePi([{ name: "codemode", exposure: "codemode" }, { name: "jobs", exposure: "direct" }], ["read"]);
	announceDeferred(pi as never);
	pi.fire("session_start", {});
	assert.deepEqual(pi.active, ["read"]);
	assert.deepEqual(undeclaredDeferred([{ name: "a", exposure: "deferred" }], ["a"]), []);
});

test("PI_PRESET_DEFERRED_TOOLS=off keeps tools direct; the guideline names the search call", () => {
	assert.equal(deferredToolsEnabled("off"), false);
	assert.equal(deferredToolsEnabled(undefined), true);
	assert.match(deferredToolsGuideline(["monitor"]), /searchTools.*monitor/);
});
