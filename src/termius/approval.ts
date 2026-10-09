/**
 * Approval policy for remote Termius commands (exec / files).
 *
 *   review       every remote command and file operation asks first
 *   auto         read-only commands and file reads run; anything else asks
 *   dangerously  nothing asks
 *
 * `auto` classifies with fixed rules, not a model: a command line is
 * read-only only when every pipeline segment starts with an allowlisted
 * read-only program (with read-only subcommands where it matters), and it has
 * no output redirection, command substitution, or backgrounding. Anything the
 * rules do not recognise counts as a write, so the failure mode is an extra
 * question, never a silent change.
 */

export type ApprovalMode = "review" | "auto" | "dangerously";
export const APPROVAL_MODES: readonly ApprovalMode[] = ["review", "auto", "dangerously"];
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "auto";

export type OperationKind = "read" | "write";

export function isApprovalMode(value: unknown): value is ApprovalMode {
	return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

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

function isReadOnlySegment(words: string[]): boolean {
	const [program, ...args] = programWords(words);
	if (!program) return true;
	const name = program.split("/").pop()!;
	const argText = args.join(" ");
	const writeFlag = WRITE_FLAGS[name];
	if (writeFlag?.test(argText)) return false;
	if (READ_ONLY_PROGRAMS.has(name)) return true;
	if (name === "top") return topIsBatch(args);
	const subcommands = READ_ONLY_SUBCOMMANDS[name];
	if (subcommands === undefined) return false;
	if (subcommands.length === 0) return true;
	const first = firstSubcommand(name, args, subcommands);
	if (first === undefined) return name !== "crontab";
	if (!subcommands.includes(first)) return false;
	// `git branch NAME` creates a branch; only listing forms are reads.
	if (name === "git" && first === "branch") {
		return args.slice(args.indexOf("branch") + 1).every((arg) => arg.startsWith("-"));
	}
	return true;
}

/** read = safe to run without asking in auto mode. */
export function classifyCommand(command: string): OperationKind {
	const parsed = parseCommand(command);
	if (parsed.unsafe || parsed.segments.length === 0) return "write";
	return parsed.segments.every((segment) => isReadOnlySegment(segment.words)) ? "read" : "write";
}

const READ_FILE_ACTIONS = new Set(["list", "stat", "read", "get"]);

/** Classify a Termius MCP call by tool name and arguments. */
export function classifyTermiusCall(tool: string, args: Record<string, unknown>): OperationKind {
	if (tool === "exec") return classifyCommand(typeof args.command === "string" ? args.command : "");
	if (tool === "files") {
		const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
		return READ_FILE_ACTIONS.has(action) ? "read" : "write";
	}
	return "read";
}

/** Tools of the Termius server that reach a remote host. */
export const GATED_TERMIUS_TOOLS = new Set(["exec", "files"]);

export function needsApproval(mode: ApprovalMode, kind: OperationKind): boolean {
	if (mode === "dangerously") return false;
	if (mode === "review") return true;
	return kind === "write";
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
