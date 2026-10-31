/**
 * bg-tasks — the vendored pi-patty-bg-tasks (bash with backgrounding, jobs,
 * monitor, agent_bg), with monitor and agent_bg registered as deferred tools:
 * out of the system prompt, found from codemode with searchTools(); see
 * extensions/deferred-tools.ts and src/deferred-tools.ts.
 *
 * Env:
 *   PI_PRESET_DEFERRED_TOOLS=off   every tool stays declared (upstream behavior)
 *
 * Runtime: pi-preset/extensions/bg-tasks.ts (wraps vendor/pi-patty-bg-tasks)
 * Command: the vendored extension's own (/bg, /jobs, ...)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bgTasks from "../vendor/pi-patty-bg-tasks/index.ts";
import { DEFERRED_TOOLS, deferredToolsEnabled, withExposure } from "../src/deferred-tools.ts";

export default function wrappedBgTasks(pi: ExtensionAPI): void {
	const names = deferredToolsEnabled(process.env.PI_PRESET_DEFERRED_TOOLS) ? DEFERRED_TOOLS["bg-tasks"] : [];
	bgTasks(withExposure(pi, names));
}
