/**
 * web-search — the vendored pi-web-search, with web_search and url_context
 * registered as deferred tools: out of the system prompt, found from codemode
 * with searchTools(). See src/deferred-tools.ts for the numbers.
 *
 * Env:
 *   PI_PRESET_DEFERRED_TOOLS=off   every tool stays declared (upstream behavior)
 *
 * Runtime: pi-preset/extensions/web-search.ts (wraps vendor/pi-web-search)
 * Command: none
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import webSearch from "../vendor/pi-web-search/src/index.ts";
import { DEFERRED_TOOLS, announceDeferred, deferredToolsEnabled, withExposure } from "../src/deferred-tools.ts";

export default function wrappedWebSearch(pi: ExtensionAPI): void {
	const names = deferredToolsEnabled(process.env.PI_PRESET_DEFERRED_TOOLS) ? DEFERRED_TOOLS["web-search"] : [];
	webSearch(withExposure(pi, names));
	announceDeferred(pi, names);
}
