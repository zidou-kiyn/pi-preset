/**
 * Path resolution.
 *
 * pi and pi-web-access do NOT share a config-dir resolver, and the difference
 * matters: writing settings.json to the web-search location would put it where
 * pi never reads it.
 *
 *   settings.json / extensions/  -> getAgentDir():
 *       PI_CODING_AGENT_DIR (tilde-expanded) | ~/.pi/agent
 *       (pi's own config.ts getAgentDir; it has no XDG_CONFIG_HOME branch)
 *
 *   web-search.json              -> getWebSearchConfigDir():
 *       PI_CODING_AGENT_DIR | $XDG_CONFIG_HOME/pi | ~/.pi
 *       (pi-web-access utils.ts getWebSearchConfigDir)
 *
 * Both collapse onto PI_CODING_AGENT_DIR when it is set, which is what makes a
 * single-directory sandbox work.
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

/** pi-web-access's config directory. Note the XDG branch that getAgentDir lacks. */
export function getWebSearchConfigDir(): string {
	if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
	if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "pi");
	return join(homedir(), ".pi");
}

export function getWebSearchConfigPath(): string {
	return join(getWebSearchConfigDir(), "web-search.json");
}

export type FontPlatform = "linux" | "darwin" | "win32" | "unsupported";

export function getFontPlatform(): FontPlatform {
	const p = platform();
	if (p === "linux") return "linux";
	if (p === "darwin") return "darwin";
	if (p === "win32") return "win32";
	return "unsupported";
}

/**
 * Directory fonts are installed into. Undefined on win32 and unknown platforms,
 * where this package never writes fonts.
 */
export function getFontInstallDir(dirName: string): string | undefined {
	switch (getFontPlatform()) {
		case "linux": {
			const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
			return join(dataHome, "fonts", dirName);
		}
		case "darwin":
			return join(homedir(), "Library", "Fonts");
		default:
			return undefined;
	}
}

/** Directories scanned when fc-list is unavailable. */
export function getFontSearchDirs(): string[] {
	switch (getFontPlatform()) {
		case "linux": {
			const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
			return [join(dataHome, "fonts"), join(homedir(), ".fonts"), "/usr/share/fonts", "/usr/local/share/fonts"];
		}
		case "darwin":
			return [join(homedir(), "Library", "Fonts"), "/Library/Fonts", "/System/Library/Fonts"];
		default:
			return [];
	}
}
