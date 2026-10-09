/**
 * The installed preset's version, for comparing machines: the package.json
 * version plus the commit of the clone (pi installs git packages as clones).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PRESET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function presetVersion(root: string = PRESET_ROOT): string {
	let version = "?";
	try {
		version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "?";
	} catch {
		// unreadable package.json: show "?" rather than fail the menu
	}
	let commit: string | undefined;
	try {
		commit =
			execFileSync("git", ["rev-parse", "--short", "HEAD"], {
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 2000,
			}).trim() || undefined;
	} catch {
		// not a git checkout (e.g. installed from npm)
	}
	return commit ? `${version} (${commit})` : version;
}
