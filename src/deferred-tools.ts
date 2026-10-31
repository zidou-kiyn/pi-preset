/**
 * deferred-tools — register some vendored tools with `deferred` exposure.
 *
 * A direct tool costs its declaration on every request. Measured on pi 1.4
 * with claude-opus-5-5: monitor + agent_bg are ~1.1k tokens of the 9.2k-token
 * preset system prompt, web_search + url_context ~0.6k, and in a 24-run
 * benchmark the model used none of them. A deferred tool is out of the prompt
 * but stays callable: codemode scripts find it with `searchTools()` /
 * `describeTool()` (which carry its guidelines) and `tool_search` can declare
 * it. jobs and bash stay direct: the model uses them on every long command.
 *
 * The vendored extensions register their tools themselves, so the wrapper
 * hands them a pi whose registerTool() adds the exposure for the named tools
 * and passes everything else through unchanged. extensions/deferred-tools.ts
 * makes them reachable: it keeps codemode active and adds one rules line
 * naming the deferred tools that are not declared. It lists them from
 * pi.getAllTools() on every run rather than from module state: jiti gives
 * each extension file its own module instance, so state in this file is not
 * shared between the wrappers, and a session resumed or reloaded from before
 * the upgrade can still have a deferred tool in its declared set.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Tool names each wrapper defers, keyed by the wrapper's name. */
export const DEFERRED_TOOLS = {
	"bg-tasks": ["monitor", "agent_bg"],
	"web-search": ["web_search", "url_context"],
} as const;

/** `PI_PRESET_DEFERRED_TOOLS=off` (or 0 / false) keeps every tool direct. */
export function deferredToolsEnabled(value: string | undefined): boolean {
	return !/^(off|0|false|no)$/i.test(value?.trim() ?? "");
}

/** One rules line so the model knows what searchTools() can still reach. */
export function deferredToolsGuideline(names: readonly string[]): string {
	return `Not declared but reachable from codemode scripts, \`await searchTools("<need>")\` then \`await tools.<name>(args)\`: ${names.join(", ")}.`;
}

type ToolLike = { name: string; exposure: string };

/** Names of the deferred tools that are not in the declared set, in registration order. */
export function undeclaredDeferred(all: readonly ToolLike[], declared: readonly string[]): string[] {
	return all.filter((tool) => tool.exposure === "deferred" && !declared.includes(tool.name)).map((tool) => tool.name);
}

/**
 * Makes deferred tools reachable: codemode is activated at session start when
 * it is registered but inactive, and the codemode rules get one line naming
 * the deferred tools that are not declared. Installed once, by
 * extensions/deferred-tools.ts.
 */
export function announceDeferred(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		const all = pi.getAllTools();
		const active = pi.getActiveTools();
		if (undeclaredDeferred(all, active).length === 0) return;
		const codemode = all.find((tool) => tool.name === "codemode");
		if (codemode && codemode.exposure !== "hidden" && !active.includes("codemode")) {
			pi.setActiveTools([...active, "codemode"]);
		}
	});
	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;
		if (!options.selectedTools.includes("codemode")) return;
		const names = undeclaredDeferred(pi.getAllTools(), options.selectedTools);
		if (names.length === 0) return;
		options.toolGuidelines.codemode = [...(options.toolGuidelines.codemode ?? []), deferredToolsGuideline(names)];
	});
}

/** A view of `pi` whose registerTool() gives the named tools `exposure`. */
export function withExposure(
	pi: ExtensionAPI,
	names: readonly string[],
	exposure: "deferred" | "codemode" = "deferred",
): ExtensionAPI {
	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (definition: Parameters<ExtensionAPI["registerTool"]>[0]) =>
					target.registerTool(names.includes(definition.name) ? { ...definition, exposure } : definition);
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
