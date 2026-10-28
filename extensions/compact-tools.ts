/**
 * compact-tools — keep collapsed `edit` rows short (replaces pi-tool-display).
 *
 * pi draws an edit's whole diff even while the row is collapsed. This
 * re-registers the built-in edit tool with the same definition and only its
 * renderers wrapped: the collapsed row shows the first PI_PRESET_EDIT_LINES
 * lines (default 16) and a ctrl+o hint; expanding shows pi's full diff.
 * Nothing the model sends or receives changes.
 *
 * `bash` belongs to the vendored pi-patty-bg-tasks and keeps pi's own 5-line
 * preview; read/grep/find/ls/write already collapse in pi. Set
 * PI_PRESET_EDIT_LINES=off to keep pi's renderer.
 *
 * Runtime: pi-preset/extensions/compact-tools.ts
 * Command: none
 */

import { createEditToolDefinition, type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";
import { readLineBudget, withLineCap } from "../src/compact-tools.ts";
import { messages } from "../src/compact-tools-messages.ts";

export default function compactTools(pi: ExtensionAPI): void {
	const editLines = readLineBudget(process.env.PI_PRESET_EDIT_LINES, 16);
	if (editLines === undefined) return;

	const hint = (hidden: number, theme: { fg(color: string, text: string): string }) => {
		const m = messages();
		return `${theme.fg("muted", m.moreLines(hidden))}${keyHint("app.tools.expand", m.toExpand)}${theme.fg("muted", m.close)}`;
	};

	// Re-registered per session so the definition carries the session's cwd.
	pi.on("session_start", async (_event, ctx) => {
		pi.registerTool(withLineCap(createEditToolDefinition(ctx.cwd), { callLines: editLines, resultLines: editLines, hint }));
	});
}
