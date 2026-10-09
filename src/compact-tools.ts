/**
 * compact-tools — cap how many lines a collapsed tool row takes in the TUI.
 *
 * pi's built-in renderers already collapse most tools (read shows nothing,
 * bash 5 lines, grep/find/ls 15–20, write 10), but `edit` always draws its
 * whole diff. This wraps a tool definition's renderers in a component that
 * renders the original and cuts the collapsed view to N lines plus an expand
 * hint. Expanding (ctrl+o) shows the original renderer untouched.
 *
 * Only the TUI changes: execute(), the schema, and the result the model sees
 * are the base definition's own.
 */

import type { ToolDefinition, ToolRenderContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

/** Builds the "… N more lines" line with the theme of the current render. */
export type HiddenLinesHint = (hidden: number, theme: any) => string;

/** Renders `inner` and truncates it to `maxLines` while collapsed. */
export class LineCapComponent implements Component {
	expanded = false;
	inner: Component;
	theme: unknown;
	private readonly maxLines: number;
	private readonly hint: HiddenLinesHint;

	constructor(inner: Component, theme: unknown, maxLines: number, hint: HiddenLinesHint) {
		this.inner = inner;
		this.theme = theme;
		this.maxLines = maxLines;
		this.hint = hint;
	}

	render(width: number): string[] {
		const lines = this.inner.render(width);
		if (this.expanded || lines.length <= this.maxLines) return lines;
		const kept = Math.max(1, this.maxLines - 1);
		return [...lines.slice(0, kept), this.hint(lines.length - kept, this.theme)];
	}

	invalidate(): void {
		this.inner.invalidate();
	}
}

export interface CapOptions {
	/** Collapsed line budget for the call row (edit draws its diff here). */
	callLines: number;
	/** Collapsed line budget for the result row. Error results are never cut. */
	resultLines: number;
	hint: HiddenLinesHint;
}

function wrap(
	render: (context: ToolRenderContext) => Component,
	context: ToolRenderContext,
	theme: unknown,
	expanded: boolean,
	maxLines: number,
	hint: HiddenLinesHint,
): Component {
	// Base renderers reuse their previous component through lastComponent; hand
	// them their own component back instead of our wrapper.
	const previous = context.lastComponent instanceof LineCapComponent ? context.lastComponent : undefined;
	const inner = render({ ...context, lastComponent: previous?.inner });
	const component = previous ?? new LineCapComponent(inner, theme, maxLines, hint);
	component.inner = inner;
	component.theme = theme;
	component.expanded = expanded;
	return component;
}

/** A copy of `base` whose collapsed call and result rows are line-capped. */
export function withLineCap<T extends ToolDefinition<any, any, any>>(base: T, options: CapOptions): T {
	const { renderCall, renderResult } = base;
	const capped: T = { ...base };
	if (renderCall) {
		capped.renderCall = (args, theme, context) =>
			wrap((ctx) => renderCall(args, theme, ctx), context, theme, context.expanded, options.callLines, options.hint);
	}
	if (renderResult) {
		capped.renderResult = (result, renderOptions, theme, context) =>
			wrap(
				(ctx) => renderResult(result, renderOptions, theme, ctx),
				context,
				theme,
				renderOptions.expanded || context.isError,
				options.resultLines,
				options.hint,
			);
	}
	return capped;
}

/** Line budget from the environment: the fallback when unset or invalid, undefined for `off`. */
export function readLineBudget(raw: string | undefined, fallback: number): number | undefined {
	if (raw === undefined || raw.trim() === "") return fallback;
	if (raw.trim().toLowerCase() === "off") return undefined;
	const value = Math.floor(Number(raw));
	return Number.isFinite(value) && value >= 2 ? value : fallback;
}
