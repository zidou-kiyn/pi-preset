/**
 * Classify remote Termius calls (exec / files) for the access levels in
 * levels.ts: read or write, why a call is a write, and whether it is
 * catastrophic.
 *
 * Fixed rules, not a model: a command line is read-only only when every
 * pipeline segment starts with an allowlisted read-only program (with
 * read-only subcommands where it matters), and it has no output redirection,
 * command substitution, or backgrounding. Anything the rules do not
 * recognise counts as a write, so the failure mode is an extra question,
 * never a silent change.
 *
 * Catastrophic commands (wiping disks or system directories, rebooting,
 * flushing firewalls, stopping sshd, deleting users, ...) are matched on
 * the words of every segment, inside `sh -c` / `bash -c` strings and command
 * substitutions too, after wrappers such as sudo. A false match costs a
 * question even on a trusted host.
 */

import type { OperationKind } from "./levels.ts";

export type { OperationKind };

/** Programs that only read, whatever their arguments (within the redirect rules). */
const READ_ONLY_PROGRAMS = new Set([
	"ls", "ll", "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "zgrep", "zcat",
	"stat", "file", "wc", "du", "df", "free", "uptime", "uname", "hostname", "hostnamectl", "whoami", "id",
	"groups", "w", "who", "last", "date", "ps", "pgrep", "pidof", "env", "printenv", "echo", "printf", "pwd",
	"which", "whereis", "type", "ss", "netstat", "lsblk", "lsof", "lscpu", "lsmem", "lspci", "lsusb", "nproc",
	"vmstat", "iostat", "mpstat", "sar", "dmesg", "ping", "dig", "nslookup", "host", "traceroute", "tracepath",
	"sort", "uniq", "cut", "tr", "column", "jq", "yq", "diff", "cmp", "md5sum", "sha1sum", "sha256sum",
	"basename", "dirname", "realpath", "readlink", "test", "[", "true", "false", "tree", "getent", "locale",
	"timedatectl", "loginctl", "true", "base64", "strings", "nl", "tac", "rev", "fold", "expand", "seq",
]);

/** Programs that are read-only only with these subcommands (first non-option argument). */
const READ_ONLY_SUBCOMMANDS: Record<string, readonly string[]> = {
	systemctl: ["status", "is-active", "is-enabled", "is-failed", "list-units", "list-unit-files", "list-timers", "show", "cat", "list-dependencies"],
	docker: ["ps", "images", "logs", "inspect", "stats", "version", "info", "top", "port", "diff", "history", "events"],
	podman: ["ps", "images", "logs", "inspect", "stats", "version", "info", "top", "port", "diff", "history"],
	kubectl: ["get", "describe", "logs", "top", "version", "explain", "api-resources", "api-versions", "cluster-info"],
	git: ["status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files", "describe", "blame", "shortlog"],
	ip: ["a", "addr", "address", "r", "route", "l", "link", "n", "neigh", "rule", "-br", "-s", "-4", "-6"],
	apt: ["list", "show", "policy", "search"],
	"apt-cache": ["show", "policy", "search", "depends", "rdepends"],
	dpkg: ["-l", "-L", "-s", "--list", "--status", "--listfiles"],
	rpm: ["-q", "-qa", "-qi", "-ql"],
	pm2: ["list", "ls", "status", "show", "describe", "logs", "jlist"],
	nginx: ["-t", "-T", "-v", "-V"],
	journalctl: [],
	find: [],
	sed: [],
	awk: [],
	curl: [],
	mount: [],
	crontab: ["-l"],
};

/**
 * Arguments that make an otherwise read-only program write (matched against
 * the joined argument list). A false match only costs a question.
 */
const WRITE_FLAGS: Record<string, RegExp> = {
	find: /(^|\s)-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b/,
	sed: /(^|\s)(-i|--in-place)/,
	awk: /system\s*\(|>|\|/,
	journalctl: /--(vacuum|rotate|flush|sync|relinquish)/,
	curl: /(^|\s)(-X|--request|-d|--data\S*|-F|--form|-T|--upload-file|-o|--output|-O|--remote-name)\b/,
	docker: /(^|\s)(compose|exec|run|rm|rmi|stop|start|restart|kill|pull|push|build|prune)\b/,
	ip: /(^|\s)(add|del|delete|change|replace|set|flush|append)\b/,
	// `git branch -c/-C a b` (copy) is caught by the positional check below.
	git: /(^|\s)(-D|-d|--delete|-m|-M|--move|add|remove|rm|rename|set-url|set-head|prune)\b/,
	// mount with arguments mounts something; bare `mount` lists.
	mount: /\S/,
};

/** Global options that take a value before the subcommand (`git -C dir log`). */
const OPTIONS_WITH_VALUE: Record<string, ReadonlySet<string>> = {
	git: new Set(["-C", "-c", "--git-dir", "--work-tree"]),
	kubectl: new Set(["-n", "--namespace", "--context", "--kubeconfig", "-l", "--selector", "-o", "--output"]),
	docker: new Set(["--context", "-c", "-H", "--host", "--config"]),
	podman: new Set(["--connection", "-c", "--url"]),
	systemctl: new Set(["-H", "--host", "-M", "--machine"]),
};

function firstSubcommand(name: string, args: readonly string[], subcommands: readonly string[]): string | undefined {
	const withValue = OPTIONS_WITH_VALUE[name];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (subcommands.includes(arg)) return arg;
		if (withValue?.has(arg)) {
			i++;
			continue;
		}
		if (!arg.startsWith("-")) return arg;
	}
	return undefined;
}

/** `top` is only safe in batch mode; interactive top never returns. */
function topIsBatch(args: readonly string[]): boolean {
	return args.some((arg) => /^-[A-Za-z]*b/.test(arg));
}

interface Segment {
	words: string[];
}

interface Parsed {
	segments: Segment[];
	/** Output redirection, substitution, backgrounding, or unbalanced quotes. */
	unsafe: boolean;
}

const HARMLESS_REDIRECT = /^(\d?>&\d|\d?>\s*\/dev\/null|&>\s*\/dev\/null)$/;

/** Split a command line into pipeline segments; flags constructs the rules cannot vet. */
export function parseCommand(command: string): Parsed {
	const segments: Segment[] = [];
	let words: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;
	let unsafe = false;
	const pushWord = () => {
		if (word !== "") words.push(word);
		word = "";
	};
	const pushSegment = () => {
		pushWord();
		if (words.length > 0) segments.push({ words });
		words = [];
	};

	for (let i = 0; i < command.length; i++) {
		const c = command[i]!;
		if (quote) {
			if (c === quote) quote = undefined;
			else if (quote === '"' && (c === "`" || (c === "$" && command[i + 1] === "("))) unsafe = true;
			else if (quote === '"' && c === "\\" && i + 1 < command.length) word += command[++i];
			else word += c;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			continue;
		}
		if (c === "\\" && i + 1 < command.length) {
			word += command[++i];
			continue;
		}
		if (c === "`" || (c === "$" && command[i + 1] === "(") || (c === "<" && command[i + 1] === "(") ) {
			unsafe = true;
			word += c;
			continue;
		}
		if (c === ">" || (c === "&" && command[i + 1] === ">")) {
			// Collect the redirection text (fd prefix, operator, target) and allow
			// only fd duplication and /dev/null.
			// `2>` / `1>`: a lone digit right before the operator is its fd.
			const fd = /^\d$/.test(word) ? word : "";
			if (fd) word = "";
			pushWord();
			let j = i;
			let redirect = fd;
			while (j < command.length && /[>&]/.test(command[j]!)) redirect += command[j++];
			while (j < command.length && command[j] === " ") j++;
			let target = "";
			while (j < command.length && !/[\s;|&]/.test(command[j]!)) target += command[j++];
			if (!HARMLESS_REDIRECT.test(`${redirect}${target}`.replace(/\s+/g, ""))) unsafe = true;
			i = j - 1;
			continue;
		}
		if (c === "&" && command[i + 1] !== "&") {
			// A lone & backgrounds a process.
			unsafe = true;
			pushSegment();
			continue;
		}
		if (c === ";" || c === "|" || c === "&" || c === "\n") {
			pushSegment();
			if ((c === "|" || c === "&") && command[i + 1] === c) i++;
			continue;
		}
		if (c === " " || c === "\t") {
			pushWord();
			continue;
		}
		word += c;
	}
	if (quote) unsafe = true;
	pushSegment();
	return { segments, unsafe };
}

/** Strip leading `VAR=value` assignments and harmless wrappers (`time`, `nice`, `timeout N`). */
function programWords(words: string[]): string[] {
	let index = 0;
	while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index++;
	const rest = words.slice(index);
	if (rest[0] === "time" || rest[0] === "nice") return programWords(rest.slice(1));
	if (rest[0] === "timeout" && rest.length > 2) return programWords(rest.slice(2));
	return rest;
}

/** Why a call counts as a write (shown in the approval dialog). */
export type WriteReason =
	| { code: "construct" }
	| { code: "empty" }
	| { code: "program"; program: string }
	| { code: "argument"; program: string }
	| { code: "subcommand"; program: string; subcommand?: string }
	| { code: "file-action"; action: string };

/** Undefined when the segment only reads. */
function segmentWriteReason(words: string[]): WriteReason | undefined {
	const [program, ...args] = programWords(words);
	if (!program) return undefined;
	const name = program.split("/").pop()!;
	const argText = args.join(" ");
	const writeFlag = WRITE_FLAGS[name];
	if (writeFlag?.test(argText)) return { code: "argument", program: name };
	if (READ_ONLY_PROGRAMS.has(name)) return undefined;
	if (name === "top") return topIsBatch(args) ? undefined : { code: "argument", program: name };
	const subcommands = READ_ONLY_SUBCOMMANDS[name];
	if (subcommands === undefined) return { code: "program", program: name };
	if (subcommands.length === 0) return undefined;
	const first = firstSubcommand(name, args, subcommands);
	if (first === undefined) return name === "crontab" ? { code: "subcommand", program: name } : undefined;
	if (!subcommands.includes(first)) return { code: "subcommand", program: name, subcommand: first };
	// `git branch NAME` creates a branch; only listing forms are reads.
	if (name === "git" && first === "branch" && !args.slice(args.indexOf("branch") + 1).every((arg) => arg.startsWith("-"))) {
		return { code: "subcommand", program: name, subcommand: first };
	}
	return undefined;
}

/** Why a command line counts as a write; undefined when it only reads. */
export function commandWriteReason(command: string): WriteReason | undefined {
	const parsed = parseCommand(command);
	if (parsed.unsafe) return { code: "construct" };
	if (parsed.segments.length === 0) return { code: "empty" };
	for (const segment of parsed.segments) {
		const reason = segmentWriteReason(segment.words);
		if (reason) return reason;
	}
	return undefined;
}

/** read = safe to run without asking at the auto level. */
export function classifyCommand(command: string): OperationKind {
	return commandWriteReason(command) ? "write" : "read";
}

const READ_FILE_ACTIONS = new Set(["list", "stat", "read", "get"]);

function fileAction(args: Record<string, unknown>): string {
	return typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
}

/** Why a Termius MCP call counts as a write; undefined for a read. */
export function writeReason(tool: string, args: Record<string, unknown>): WriteReason | undefined {
	if (tool === "exec") return commandWriteReason(typeof args.command === "string" ? args.command : "");
	if (tool === "files") {
		const action = fileAction(args);
		return READ_FILE_ACTIONS.has(action) ? undefined : { code: "file-action", action };
	}
	return undefined;
}

/** Classify a Termius MCP call by tool name and arguments. */
export function classifyTermiusCall(tool: string, args: Record<string, unknown>): OperationKind {
	return writeReason(tool, args) ? "write" : "read";
}

/** Tools of the Termius server that reach a remote host. */
export const GATED_TERMIUS_TOOLS = new Set(["exec", "files"]);

// ── catastrophic commands ────────────────────────────────────────────────────

export type CatastrophicRule =
	| "wipe-system-path"
	| "format-disk"
	| "write-disk"
	| "partition"
	| "power"
	| "firewall"
	| "ssh-daemon"
	| "delete-user"
	| "system-permissions"
	| "kill-init"
	| "fork-bomb";

/** Top-level directories whose loss breaks the system. */
const SYSTEM_DIRS = new Set([
	"bin", "boot", "dev", "etc", "home", "lib", "lib32", "lib64", "opt", "proc", "root", "run", "sbin", "srv", "sys", "usr", "var",
]);

/** `/`, `/*`, `/etc`, `/usr/`, `/var/*`, `~`, `$HOME`: a path whose removal is catastrophic. */
export function isSystemPath(path: string): boolean {
	const text = path.trim().replace(/^["']|["']$/g, "");
	if (["~", "~/", "~/*", "$HOME", "${HOME}", "$HOME/", "$HOME/*"].includes(text)) return true;
	if (!text.startsWith("/")) return false;
	const parts = text.split("/").filter((part) => part !== "" && part !== ".");
	if (parts.length === 0) return true;
	if (parts.length === 1) return parts[0] === "*" || SYSTEM_DIRS.has(parts[0]!);
	return parts.length === 2 && SYSTEM_DIRS.has(parts[0]!) && parts[1] === "*";
}

const WRAPPERS = new Set(["sudo", "doas", "nohup", "exec", "command", "builtin", "time", "nice", "ionice", "stdbuf", "setsid", "env"]);
/** Options of wrappers that take a separate value (`sudo -u root`, `nice -n 5`). */
const WRAPPER_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
	sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-U", "-r", "-t", "-T", "-D", "--user", "--group", "--host", "--prompt", "--chdir"]),
	doas: new Set(["-u", "-C"]),
	nice: new Set(["-n", "--adjustment"]),
	ionice: new Set(["-c", "-n", "-p", "--class", "--classdata", "--pid"]),
	stdbuf: new Set(["-i", "-o", "-e"]),
	env: new Set(["-u", "-C", "--unset", "--chdir"]),
};

/** The words of the actual program, past sudo / env / nice / timeout and assignments. */
function unwrap(words: string[]): string[] {
	let rest = words;
	for (let guard = 0; guard < 8; guard++) {
		while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!)) rest = rest.slice(1);
		const name = rest[0]?.split("/").pop();
		if (name === "timeout") {
			rest = rest.slice(1);
			while (rest[0]?.startsWith("-")) rest = rest.slice(1);
			rest = rest.slice(1);
			continue;
		}
		if (!name || !WRAPPERS.has(name)) return rest;
		rest = rest.slice(1);
		while (rest[0]?.startsWith("-")) {
			const option = rest[0]!;
			rest = rest.slice(WRAPPER_VALUE_OPTIONS[name]?.has(option) ? 2 : 1);
		}
	}
	return rest;
}

const SSH_UNITS = /^(ssh|sshd|openssh-server)(\.service|\.socket)?$/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "su"]);

function hasFlag(args: readonly string[], short: string, long?: string): boolean {
	return args.some((arg) => (long !== undefined && arg === long) || (/^-[A-Za-z]+$/.test(arg) && arg.slice(1).includes(short)));
}

function positional(args: readonly string[]): string[] {
	return args.filter((arg) => !arg.startsWith("-"));
}

function segmentCatastrophe(words: string[]): CatastrophicRule | undefined {
	const [program, ...args] = unwrap(words);
	if (!program) return undefined;
	const name = program.split("/").pop()!;
	const lower = args.map((arg) => arg.toLowerCase());
	switch (name) {
		case "rm":
			if (args.includes("--no-preserve-root")) return "wipe-system-path";
			return hasFlag(args, "r", "--recursive") || hasFlag(args, "R") ? (positional(args).some(isSystemPath) ? "wipe-system-path" : undefined) : undefined;
		case "chmod":
		case "chown":
		case "chgrp":
			return (hasFlag(args, "R", "--recursive") && positional(args).slice(1).some(isSystemPath)) ? "system-permissions" : undefined;
		case "mkswap":
		case "mke2fs":
		case "wipefs":
			return "format-disk";
		case "dd":
			return args.some((arg) => /^of=\/dev\/(?!null$|zero$|stdout$|stderr$)/.test(arg)) ? "write-disk" : undefined;
		case "shred":
			return positional(args).some((arg) => arg.startsWith("/dev/")) ? "write-disk" : undefined;
		case "fdisk":
		case "sfdisk":
		case "gdisk":
		case "cfdisk":
		case "sgdisk":
			return args.some((arg) => /^(-l|--list|-d|--dump|-J|--json|-p|--print|-s|--show-size)$/.test(arg)) ? undefined : "partition";
		case "parted":
			return lower.some((arg) => /^(mklabel|mktable|mkpart|rm|resizepart|resize|rescue)$/.test(arg)) ? "partition" : undefined;
		case "reboot":
		case "poweroff":
		case "halt":
		case "shutdown":
			return args.includes("--help") ? undefined : "power";
		case "init":
		case "telinit":
			return args.some((arg) => arg === "0" || arg === "6") ? "power" : undefined;
		case "systemctl": {
			const [verb, ...units] = positional(args);
			if (verb && /^(reboot|poweroff|halt|kexec|rescue|emergency|soft-reboot)$/.test(verb)) return "power";
			if (verb && /^(stop|disable|mask|kill)$/.test(verb) && units.some((unit) => SSH_UNITS.test(unit))) return "ssh-daemon";
			return undefined;
		}
		case "service":
			return args[0] && SSH_UNITS.test(args[0]) && args[1] === "stop" ? "ssh-daemon" : undefined;
		case "pkill":
		case "killall":
			return positional(args).some((arg) => SSH_UNITS.test(arg)) ? "ssh-daemon" : undefined;
		case "kill":
			return positional(args).includes("1") ? "kill-init" : undefined;
		case "iptables":
		case "ip6tables":
		case "iptables-legacy":
		case "iptables-nft":
			if (args.some((arg) => arg === "-F" || arg === "--flush" || arg === "-X")) return "firewall";
			for (let i = 0; i < args.length - 2; i++) {
				if ((args[i] === "-P" || args[i] === "--policy") && /^INPUT$/i.test(args[i + 1]!) && /^(DROP|REJECT)$/i.test(args[i + 2]!)) return "firewall";
			}
			return undefined;
		case "nft":
			return lower[0] === "flush" && lower[1] === "ruleset" ? "firewall" : undefined;
		case "ufw":
			return lower[0] === "reset" || lower[0] === "disable" ? "firewall" : undefined;
		case "userdel":
		case "deluser":
			return "delete-user";
		default:
			if (/^mkfs(\.\w+)?$/.test(name)) return "format-disk";
			return undefined;
	}
}

/** `sh -c '...'` and `su -c '...'` run their argument as a command line. */
function nestedCommands(words: string[]): string[] {
	const [program, ...args] = unwrap(words);
	if (!program || !SHELLS.has(program.split("/").pop()!)) return [];
	const index = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
	return index === -1 || args[index + 1] === undefined ? [] : [args[index + 1]!];
}

/** Bodies of `$(...)` and backticks (not nested). */
function substitutions(command: string): string[] {
	const bodies: string[] = [];
	for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) bodies.push(match[1] ?? match[2] ?? "");
	return bodies;
}

const FORK_BOMB = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/;
const DISK_REDIRECT = />\s*\/dev\/(sd|hd|vd|xvd|nvme|mmcblk|disk|mapper\/)/;

function commandCatastrophe(command: string, depth = 0): CatastrophicRule | undefined {
	if (depth > 3) return undefined;
	if (FORK_BOMB.test(command)) return "fork-bomb";
	if (DISK_REDIRECT.test(command)) return "write-disk";
	const parsed = parseCommand(command);
	for (const segment of parsed.segments) {
		const rule = segmentCatastrophe(segment.words);
		if (rule) return rule;
		for (const nested of nestedCommands(segment.words)) {
			const inner = commandCatastrophe(nested, depth + 1);
			if (inner) return inner;
		}
	}
	for (const body of substitutions(command)) {
		const inner = commandCatastrophe(body, depth + 1);
		if (inner) return inner;
	}
	return undefined;
}

/** The catastrophic rule a call matches, if any. */
export function catastrophicRule(tool: string, args: Record<string, unknown>): CatastrophicRule | undefined {
	if (tool === "exec") return typeof args.command === "string" ? commandCatastrophe(args.command) : undefined;
	if (tool === "files") {
		const action = fileAction(args);
		const path = typeof args.path === "string" ? args.path : "";
		if (action === "rm" && args.recursive === true && isSystemPath(path)) return "wipe-system-path";
		if (action === "rename" && isSystemPath(path)) return "wipe-system-path";
	}
	return undefined;
}

/** One-line description of a gated call for the approval dialog. */
export function describeCall(tool: string, args: Record<string, unknown>): string {
	const host = String(args.name ?? "?");
	if (tool === "exec") return `${host}$ ${String(args.command ?? "")}`;
	const action = String(args.action ?? "?");
	const path = args.path === undefined ? "" : ` ${String(args.path)}`;
	const dest = args.dest === undefined ? "" : ` -> ${String(args.dest)}`;
	const local = args.local_path === undefined ? "" : ` (local ${String(args.local_path)})`;
	return `${host}: files ${action}${path}${dest}${local}`;
}
