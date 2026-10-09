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
 * Running the server's own code is blocked as well: launching the installed
 * server or CLI, importing the `termius` package, or running Python against
 * the vendored source other than its test suite. The server decrypts the
 * vault with the remembered password, so any script on top of it can read
 * every credential, and calling it directly also skips pi's approval modes.
 * The agent reaches Termius only through the MCP tools, where approvals and
 * output redaction apply. The installed server directory (its config holds
 * a proxy URL that may carry a password) is off limits to path tools too.
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

/** Commands that run the Termius server code directly. */
const SERVER_CODE = [
	// the installed server environment
	/termius-mcp[\\/](venv|config\.json)|\.pi[\\/]agent[\\/]termius-mcp/i,
	// the server or CLI as a command (start of a command, or after ; & | $( `)
	/(^|[;&|]|\$\(|`)\s*(\S*[\\/])?termius(-mcp)?(\.exe)?(\s|$)/i,
	// the package from Python
	/-m\s+termius\b|\b(import|from)\s+termius\b|\btermius\.(main|json_login|runtime|vault|sync|keychain|session|cloud|core|mcp)\b|\blogin-json\b/i,
];
const VENDORED_SOURCE = /vendor[\\/]termius-mcp/i;
const RUNS_PYTHON = /\b(python[\d.]*|uv\s+run|uvx|pipx?\s+run)\b/i;
const RUNS_TESTS = /\bpytest\b/i;

function runsServerCode(command: string): boolean {
	if (SERVER_CODE.some((pattern) => pattern.test(command))) return true;
	return VENDORED_SOURCE.test(command) && RUNS_PYTHON.test(command) && !RUNS_TESTS.test(command);
}

function mentionsServerDir(text: string): boolean {
	return /[\\/]\.pi[\\/]agent[\\/]termius-mcp([\\/]|$)|^~[\\/]\.pi[\\/]agent[\\/]termius-mcp/i.test(text.replace(/\\/g, "/"));
}

const SERVER_REASON =
	"Blocked by pi-preset: this runs the Termius MCP server's code directly, which can decrypt every stored credential and skips the approval modes. Use the termius MCP tools (status, hosts, host, exec, files); tests run with `npm run test:termius`.";

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
	if (paths.some(mentionsServerDir)) return { block: true, reason: SERVER_REASON };

	for (const command of commands) {
		if (runsServerCode(command)) return { block: true, reason: SERVER_REASON };
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

