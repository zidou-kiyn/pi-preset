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

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash" || !ctx.hasUI) return;
		if (!bashIsPatty()) return;
		// patty's bash adds run_in_background on top of the built-in schema.
		const input = event.input as BashInput;
		const next = cappedTimeout(input, config);
		if (next !== undefined) input.timeout = next;
	});
}
