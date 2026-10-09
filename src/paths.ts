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

/** pi's user-level MCP server configuration (docs/mcp.md). */
export function getMcpConfigPath(): string {
	return join(getAgentDir(), "mcp.json");
}

/**
 * Skill roots older presets installed the upstream grilling skills into:
 * ~/.agents/skills (skills CLI 1.7.1+) and the agent dir's skills/ (older).
 */
export function getLegacySkillRoots(): string[] {
	return [join(homedir(), ".agents", "skills"), join(getAgentDir(), "skills")];
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
