/**
 * Private permissions for pi's data.
 *
 * pi creates its agent directory and files with the process umask, usually
 * 0755 / 0644. The directory holds API keys (auth.json, models.json and its
 * backups), MCP server config, and full session transcripts, so on a machine
 * with other users, or a home directory that is not 0700 (older Ubuntu,
 * macOS), they can read all of it. Sync preset tightens what it finds:
 * directories to 0700, credential files to 0600. POSIX only, and only paths
 * owned by the current user; nothing is created or loosened.
 */

import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "./paths.ts";

export interface PermissionChange {
	path: string;
	from: number;
	to: number;
}

/** Credential-bearing files in the agent directory, backups included. */
const CREDENTIAL_FILES = /^(auth|models|mcp)\.json(\..+)?$/u;

export interface PermissionTargets {
	agentDir: string;
	termiusDir: string;
}

function defaultTargets(): PermissionTargets {
	return { agentDir: getAgentDir(), termiusDir: join(homedir(), ".termius") };
}

/** What would change. Empty on Windows, for missing paths, and for paths owned by someone else. */
export function planPrivatePermissions(targets: PermissionTargets = defaultTargets()): PermissionChange[] {
	if (process.platform === "win32" || typeof process.getuid !== "function") return [];
	const uid = process.getuid();
	const changes: PermissionChange[] = [];
	const check = (path: string, kind: "dir" | "file") => {
		let info;
		try {
			info = lstatSync(path);
		} catch {
			return;
		}
		if (info.isSymbolicLink() || info.uid !== uid) return;
		if (kind === "dir" ? !info.isDirectory() : !info.isFile()) return;
		const mode = info.mode & 0o777;
		const to = privateMode(mode);
		if (to !== mode) changes.push({ path, from: mode, to });
	};

	check(targets.agentDir, "dir");
	if (existsSync(targets.agentDir)) {
		let names: string[] = [];
		try {
			names = readdirSync(targets.agentDir);
		} catch {
			// unreadable: the directory change above is still worth making
		}
		for (const name of names.sort()) {
			if (CREDENTIAL_FILES.test(name)) check(join(targets.agentDir, name), "file");
		}
	}
	check(targets.termiusDir, "dir");
	return changes;
}

/** Apply planned changes, re-checking each path; returns what was changed. */
export function applyPrivatePermissions(changes: readonly PermissionChange[]): PermissionChange[] {
	const done: PermissionChange[] = [];
	for (const change of changes) {
		let info;
		try {
			info = lstatSync(change.path);
		} catch {
			continue;
		}
		if (info.isSymbolicLink()) continue;
		const mode = info.mode & 0o777;
		const to = privateMode(mode);
		if (to === mode) continue;
		chmodSync(change.path, to);
		done.push({ path: change.path, from: mode, to });
	}
	return done;
}

/** Drop group and other bits; owner bits are left as the user set them. */
export function privateMode(mode: number): number {
	return mode & 0o700;
}

export function formatMode(mode: number): string {
	return mode.toString(8).padStart(3, "0");
}
