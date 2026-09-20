/**
 * headless-keepalive — hold Node's event loop open while a tool is executing.
 *
 * Why: in headless `pi -p` children (Trellis `trellis_subagent`, pi-patty's
 * own `agent_bg`, any `--mode json|text` driver) nothing keeps the event loop
 * alive once stdin is drained and the LLM stream has ended. `pi-patty-bg-tasks`
 * spawns its foreground `bash` with `detached: true` + `proc.unref()` and
 * unref's every timer, so the first bash call makes Node see an empty loop and
 * exit 0 mid tool-call: no `tool_execution_end`, no `agent_end`, no answer.
 *
 * Fix: keep one ref'd interval per in-flight tool call. In the TUI the terminal
 * already holds the loop, so this is a no-op there. Safe to drop once
 * pi-patty-bg-tasks stops unref'ing its foreground child.
 *
 * Runtime: pi-preset/extensions/headless-keepalive.ts
 * Command: none (event hooks only)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function headlessKeepalive(pi: ExtensionAPI): void {
	const active = new Map<string, ReturnType<typeof setInterval>>();

	const release = (id: string): void => {
		const timer = active.get(id);
		if (!timer) return;
		clearInterval(timer);
		active.delete(id);
	};
	const releaseAll = (): void => {
		for (const id of [...active.keys()]) release(id);
	};

	pi.on("tool_execution_start", async (event) => {
		if (active.has(event.toolCallId)) return;
		active.set(event.toolCallId, setInterval(() => {}, 1000)); // ref'd handle
	});

	pi.on("tool_execution_end", async (event) => {
		release(event.toolCallId);
	});

	pi.on("agent_end", async () => releaseAll());
	pi.on("session_shutdown", async () => releaseAll());
}
