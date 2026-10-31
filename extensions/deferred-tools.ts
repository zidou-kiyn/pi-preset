/**
 * deferred-tools — keeps the tools that bg-tasks.ts and web-search.ts register
 * as `deferred` reachable: codemode stays active, and one rules line names
 * the deferred tools that are not declared, so the model knows what
 * searchTools() can find. Logic in src/deferred-tools.ts.
 *
 * Runtime: pi-preset/extensions/deferred-tools.ts
 * Command: none
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { announceDeferred } from "../src/deferred-tools.ts";

export default function deferredTools(pi: ExtensionAPI): void {
	announceDeferred(pi);
}
