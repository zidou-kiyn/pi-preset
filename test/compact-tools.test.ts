import assert from "node:assert/strict";
import { test } from "node:test";
import { LineCapComponent, readLineBudget, withLineCap } from "../src/compact-tools.ts";

class Lines {
	invalidated = 0;
	lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {
		this.invalidated++;
	}
}

const theme = { fg: (_color: string, text: string) => text };
const hint = (hidden: number) => `+${hidden}`;
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

function context(overrides: Record<string, unknown> = {}) {
	return {
		args: {},
		toolCallId: "t1",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	} as any;
}

test("collapsed rows are cut to the budget with a hint line", () => {
	const component = new LineCapComponent(new Lines(lines(30)), theme, 5, hint);
	assert.deepEqual(component.render(80), ["line 1", "line 2", "line 3", "line 4", "+26"]);
	component.expanded = true;
	assert.equal(component.render(80).length, 30);
});

test("short rows are untouched", () => {
	const component = new LineCapComponent(new Lines(lines(5)), theme, 5, hint);
	assert.deepEqual(component.render(80), lines(5));
});

test("withLineCap keeps execute/schema and wraps only the renderers", () => {
	const execute = async () => ({ content: [], details: undefined });
	const seen: unknown[] = [];
	const base = {
		name: "edit",
		label: "edit",
		description: "d",
		parameters: {},
		execute,
		renderCall: (_args: unknown, _theme: unknown, ctx: any) => {
			seen.push(ctx.lastComponent);
			return ctx.lastComponent ?? new Lines(lines(40));
		},
		renderResult: () => new Lines(lines(40)),
	} as any;
	const capped = withLineCap(base, { callLines: 10, resultLines: 3, hint });
	assert.equal(capped.execute, execute);
	assert.equal(capped.parameters, base.parameters);

	const first = capped.renderCall({}, theme, context());
	assert.equal(first.render(80).length, 10);
	// The base renderer gets its own component back, not the wrapper.
	const second = capped.renderCall({}, theme, context({ lastComponent: first, expanded: true }));
	assert.equal(second, first, "wrapper is reused");
	assert.ok(seen[1] instanceof Lines);
	assert.equal(second.render(80).length, 40, "expanded shows everything");

	assert.equal(capped.renderResult({}, { expanded: false, isPartial: false }, theme, context()).render(80).length, 3);
	assert.equal(
		capped.renderResult({}, { expanded: false, isPartial: false }, theme, context({ isError: true })).render(80).length,
		40,
		"errors are never cut",
	);
});

test("line budget parsing", () => {
	assert.equal(readLineBudget(undefined, 16), 16);
	assert.equal(readLineBudget("24", 16), 24);
	assert.equal(readLineBudget("off", 16), undefined);
	assert.equal(readLineBudget("1", 16), 16);
	assert.equal(readLineBudget("junk", 16), 16);
});
