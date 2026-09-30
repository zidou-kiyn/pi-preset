/**
 * bash-bg-cap — move stuck foreground `bash` commands to the background sooner.
 *
 * Why: under pi-patty-bg-tasks, `bash`'s `timeout` is when a foreground
 * command slides into the background (the model then gets job_decide:
 * keep / kill / check), not when it is killed. Models treat it as a kill
 * deadline and pass hundreds of seconds, so a hung command holds the session
 * for minutes. This rewrites the call before it runs:
 *
 *   no timeout          -> 30s  (PI_PRESET_BASH_BG_DEFAULT)
 *   timeout > 60s       -> 60s  (PI_PRESET_BASH_BG_CAP)
 *   run_in_background   -> untouched
 *   `sleep ...` command -> untouched (patty kills those at the timeout)
 *
 * Nothing is killed by this: a capped build keeps running in the background
 * and reports when it finishes. Set either variable to `off` to disable.
 *
 * Only active when the registered `bash` tool comes from pi-patty-bg-tasks.
 * With pi's built-in bash, `timeout` IS a kill deadline, and capping it would
 * kill long builds. Also skipped without a UI (print / json modes), where
 * patty ignores the timeout anyway.
 *
 * Two hooks, because pi keeps two copies of the arguments:
 *
 *   message_end  caps `toolCall.arguments` on the finalized assistant message.
 *                That object is shared by agent state, the tool row in the TUI
 *                (so it shows `(timeout 60s)`, not the model's 150s), and the
 *                saved transcript. Extensions see message_end before the UI.
 *   tool_call    caps the validated copy that actually executes. Covers calls
 *                that never pass through an assistant message (codemode
 *                scripts) and is a no-op when message_end already capped it.
 *   tool_result  appends a terse `timeout capped 150s -> 60s` line.
 *
 * Because the transcript then shows the capped value as the model's own
 * argument, a bash guideline in the system prompt explains the rewrite up
 * front. Without it the model concluded it had made a mistake, and with only
 * a tool-result note it suspected a prompt injection (both seen in live runs).
 *
 * Runtime: pi-preset/extensions/bash-bg-cap.ts
 * Command: none (event hook only)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type BashInput, cappedTimeout, readConfig } from "../src/bash-bg-cap.ts";

export default function bashBgCap(pi: ExtensionAPI): void {
	const config = readConfig();
	if (!config) return;

	const bashIsPatty = (): boolean => {
		const bash = pi.getAllTools().find((tool) => tool.name === "bash");
		return bash !== undefined && /[\\/]pi-patty-bg-tasks[\\/]/.test(bash.sourceInfo.path);
	};

	// toolCallId -> timeout the model originally passed (undefined = none).
	const capped = new Map<string, number | undefined>();
	const originalTimeout = (input: BashInput): number | undefined =>
		typeof input.timeout === "number" ? input.timeout : undefined;

	pi.on("before_agent_start", async (event, ctx) => {
		if (!ctx.hasUI || !bashIsPatty()) return;
		const guidelines = event.systemPromptOptions.toolGuidelines;
		guidelines.bash = [
			...(guidelines.bash ?? []),
			`The pi-preset extension rewrites bash \`timeout\` before a call runs: omitted becomes ${config.defaultSeconds}s, ` +
				`anything above ${config.capSeconds}s becomes ${config.capSeconds}s, and your recorded call shows the rewritten value. ` +
				"Under pi-patty-bg-tasks the timeout only moves a still-running command to the background (it is not killed), " +
				"so this is expected, not an error on your part.",
		];
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || !ctx.hasUI) return;
		const calls = message.content.filter((part) => part.type === "toolCall" && part.name === "bash");
		if (calls.length === 0 || !bashIsPatty()) return;
		for (const call of calls) {
			if (call.type !== "toolCall") continue;
			const input = call.arguments as BashInput;
			const next = cappedTimeout(input, config);
			if (next === undefined) continue;
			capped.set(call.id, originalTimeout(input));
			// In place: the TUI row and the tool loop hold this same object.
			input.timeout = next;
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash" || !ctx.hasUI) return;
		if (!bashIsPatty()) return;
		// patty's bash adds run_in_background on top of the built-in schema.
		const input = event.input as BashInput;
		const next = cappedTimeout(input, config);
		if (next === undefined) return;
		if (!capped.has(event.toolCallId)) capped.set(event.toolCallId, originalTimeout(input));
		input.timeout = next;
	});

	pi.on("tool_result", async (event) => {
		if (!capped.has(event.toolCallId)) return;
		const original = capped.get(event.toolCallId);
		capped.delete(event.toolCallId);
		const applied = (event.input as BashInput).timeout;
		const from = original === undefined ? "none" : `${original}s`;
		const note = `[pi-preset] bash timeout capped: ${from} -> ${String(applied)}s`;
		return {
			content: [...event.content, { type: "text", text: note }],
			...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
		};
	});

	pi.on("session_shutdown", async () => capped.clear());
}
