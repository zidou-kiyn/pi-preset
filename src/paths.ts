/**
 * Path resolution.
 *
 * Everything the preset writes lives under pi's agent dir:
 *
 *   settings.json / keybindings.json / extensions/  -> getAgentDir():
 *       PI_CODING_AGENT_DIR (tilde-expanded) | ~/.pi/agent
 *       (pi's own config.ts getAgentDir; it has no XDG_CONFIG_HOME branch)
 *
 * Setting PI_CODING_AGENT_DIR is what makes a single-directory sandbox work.
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";

/** Mirror of pi's expandTildePath for the env-var case. */
function expandTilde(input: string): string {
	const home = homedir();
	if (input === "~") return home;
	if (input.startsWith("~/") || (platform() === "win32" && input.startsWith("~\\"))) {
		return join(home, input.slice(2));
	}
	return input;
}

/** pi's agent config directory (holds settings.json, extensions/, themes/, ...). */
export function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return expandTilde(envDir);
	return join(homedir(), ".pi", "agent");
}

export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** pi's native custom-provider catalogue. */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** pi's keybinding overrides. A per-action key list here REPLACES the default list, it does not extend it. */
export function getKeybindingsPath(): string {
	return join(getAgentDir(), "keybindings.json");
}

/**
 * pi-tool-display's own config file.
 *
 * The extension resolves it from the same agent dir pi does, so a sandbox that
 * sets PI_CODING_AGENT_DIR moves both together (pi-tool-display agent-dir.ts
 * resolvePiAgentDir + config-store.ts CONFIG_FILE).
 */
export function getToolDisplayConfigPath(): string {
	return join(getUserExtensionsDir(), "pi-tool-display", "config.json");
}

/** Directory auto-discovered for user extensions. */
export function getUserExtensionsDir(): string {
	return join(getAgentDir(), "extensions");
}

/**
 * Parking directory for demoted extensions. Deliberately a sibling of
 * extensions/ rather than a child, so pi's auto-discovery never walks into it.
 */
export function getDisabledExtensionsDir(): string {
	return join(getAgentDir(), "extensions-disabled");
}
