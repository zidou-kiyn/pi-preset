/**
 * Keep the agent's own tools away from the Termius credentials.
 *
 * The Termius MCP server holds the vault password and keys; the model only
 * sees command output. But the agent also has local tools (bash, read, ...)
 * running as the same user, which could open the server's encrypted cache in
 * ~/.termius, ask the OS keychain for the vault password, or read the server
 * process. This blocks tool calls that point at those places.
 *
 * Only path and command fields are inspected (path, file_path, command,
 * local_path, ...), so writing a file that merely mentions ~/.termius is
 * fine. termius's own `files` tool is checked too: its local_path must not
 * upload the vault cache to a remote host.
 *
 * It is a second line, not an isolation boundary: an agent determined to
 * reach the secrets as the same OS user could obfuscate the path. It stops the
 * ordinary ways (a `cat`, a `read`, a keychain lookup) and makes intent visible.
 */

import { homedir } from "node:os";

export interface GuardVerdict {
	block: boolean;
	reason?: string;
}

/** Input fields that name a local path or a command to run locally. */
const PATH_FIELDS = new Set([
	"path",
	"paths",
	"file_path",
	"filePath",
	"file",
	"files",
	"dir",
	"directory",
	"cwd",
	"local_path",
	"target",
	"source",
	"destination",
]);
const COMMAND_FIELDS = new Set(["command", "cmd"]);

const KEYCHAIN_TOOLS =
	/\b(secret-tool|keyring|security\s+(find|dump|export)-?\w*|cmdkey|vaultcmd|CredRead|Get-StoredCredential|kwallet-query|gnome-keyring)\b/i;

const PROCESS_MEMORY =
	/\/proc\/(\d+|self|\$\w+|\*)\/(mem|environ|maps)\b|\b(gdb|gcore|lldb)\b.*\s(-p|--pid|attach)\b|\bstrace\b.*\s(-p|--attach)\b/i;

/** Spellings of the Termius data directory. */
export function termiusDataFragments(home = homedir()): string[] {
	const normalized = home.replace(/\\/g, "/").replace(/\/$/, "");
	return [`${normalized}/.termius`, "~/.termius", "$HOME/.termius", "${HOME}/.termius", "%USERPROFILE%/.termius"];
}

function collect(value: unknown, key: string | undefined, paths: string[], commands: string[], depth = 0): void {
	if (depth > 6 || value === null || value === undefined) return;
	if (typeof value === "string") {
		if (key && PATH_FIELDS.has(key)) paths.push(value);
		if (key && COMMAND_FIELDS.has(key)) commands.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collect(item, key, paths, commands, depth + 1);
		return;
	}
	if (typeof value === "object") {
		for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
			collect(child, childKey, paths, commands, depth + 1);
		}
	}
}

function mentionsTermiusDir(text: string, home: string): boolean {
	const normalized = text.replace(/\\/g, "/").toLowerCase();
	if (termiusDataFragments(home).some((fragment) => normalized.includes(fragment.toLowerCase()))) return true;
	// A relative `.termius` path segment (e.g. after `cd ~`).
	return /(^|[\s"'=:/])\.termius(\/|["'\s;|&)]|$)/.test(normalized);
}

const DIR_REASON =
	"Blocked by pi-preset: ~/.termius holds the Termius MCP server's encrypted vault cache and secrets. Use the termius MCP tools (status, hosts, exec, files) instead; the user signs in with /termius login.";

/** Inspect one tool call. */
export function guardToolCall(toolName: string, input: unknown, home = homedir()): GuardVerdict {
	const paths: string[] = [];
	const commands: string[] = [];
	if (typeof input === "string") commands.push(input);
	else collect(input, undefined, paths, commands);

	// termius's own exec/files paths are on the remote host; only its
	// local_path touches this machine.
	if (toolName.startsWith("mcp__termius__")) {
		const localPath = (input as Record<string, unknown> | undefined)?.local_path;
		if (typeof localPath === "string" && mentionsTermiusDir(localPath, home)) return { block: true, reason: DIR_REASON };
		return { block: false };
	}

	if ([...paths, ...commands].some((text) => mentionsTermiusDir(text, home))) return { block: true, reason: DIR_REASON };

	for (const command of commands) {
		if (KEYCHAIN_TOOLS.test(command) && /termius/i.test(command)) {
			return {
				block: true,
				reason: "Blocked by pi-preset: the OS keychain entry of termius-mcp holds the vault password and is off limits to tools.",
			};
		}
		if (PROCESS_MEMORY.test(command)) {
			return {
				block: true,
				reason: "Blocked by pi-preset: reading another process's memory or environment can expose the Termius MCP server's credentials.",
			};
		}
	}
	return { block: false };
}

