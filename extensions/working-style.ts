/**
 * working-style — adds a short <working-style> section to the system prompt:
 * deliver what was asked at the intended scope, keep solutions minimal, follow
 * the surrounding code. Text and sources in src/working-style.ts.
 *
 * Shipped as a prompt section rather than a line in ~/.pi/agent/AGENTS.md so
 * it updates with the preset and leaves the user's own AGENTS.md alone.
 *
 * Env:
 *   PI_PRESET_WORKING_STYLE=off   disable
 *
 * Runtime: pi-preset/extensions/working-style.ts
 * Command: none
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SECTION_NAME, WORKING_STYLE, workingStyleEnabled } from "../src/working-style.ts";

export default function workingStyle(pi: ExtensionAPI): void {
	if (!workingStyleEnabled(process.env.PI_PRESET_WORKING_STYLE)) return;
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections[SECTION_NAME] = WORKING_STYLE;
	});
}
