/**
 * todo-nudge — a one-line reminder in a tool result when a todo task stays
 * in_progress for many tool calls without a todo update, and a note when a
 * second task is set in_progress on top of an open one. No system prompt or
 * tool cost; logic and reasoning in src/todo-nudge.ts.
 *
 * Env:
 *   PI_PRESET_TODO_NUDGE=off   disable
 *   PI_PRESET_TODO_NUDGE=<n>   remind after n calls (default 8; the gap then doubles)
 *
 * Runtime: pi-preset/extensions/todo-nudge.ts
 * Command: none
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readThreshold, TodoNudge, tasksFromBranch } from "../src/todo-nudge.ts";

export default function todoNudge(pi: ExtensionAPI): void {
	const threshold = readThreshold(process.env.PI_PRESET_TODO_NUDGE);
	if (threshold === undefined) return;
	const nudge = new TodoNudge(threshold);

	const replay = (_event: unknown, ctx: ExtensionContext) => nudge.reset(tasksFromBranch(ctx.sessionManager.getBranch()));
	pi.on("session_start", replay);
	pi.on("session_tree", replay);

	pi.on("tool_result", (event) => {
		const line = nudge.onResult(event);
		if (!line) return;
		return {
			content: [...event.content, { type: "text" as const, text: line }],
			structuredContent: event.structuredContent,
		};
	});
}
