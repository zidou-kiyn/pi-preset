import { createHash } from "node:crypto";
import {
	accessSync,
	constants,
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	type Stats,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { sanitizeTerminalText } from "./skills-sync-output.ts";

export const REQUIRED_SKILLS = ["grill-me", "grilling"] as const;
export type SkillName = (typeof REQUIRED_SKILLS)[number];

export const UPSTREAM_SOURCE = "mattpocock/skills";
export const UPSTREAM_URL = "https://github.com/mattpocock/skills.git";
export const MINIMUM_NODE_VERSION = "22.20.0";

export const UPSTREAM_SKILL_PATHS: Record<SkillName, string> = {
	"grill-me": "skills/productivity/grill-me/SKILL.md",
	grilling: "skills/productivity/grilling/SKILL.md",
};

export interface SkillSyncPaths {
	home: string;
	piSkillsRoot: string;
	agentsSkillsRoot: string;
	lockPath: string;
	skillPaths: Record<SkillName, { pi: string; agents: string }>;
}

export function getSkillSyncPaths(home = homedir(), xdgStateHome = process.env.XDG_STATE_HOME): SkillSyncPaths {
	const piSkillsRoot = join(home, ".pi", "agent", "skills");
	const agentsSkillsRoot = join(home, ".agents", "skills");
	const lockPath = xdgStateHome
		? join(xdgStateHome, "skills", ".skill-lock.json")
		: join(home, ".agents", ".skill-lock.json");

	return {
		home,
		piSkillsRoot,
		agentsSkillsRoot,
		lockPath,
		skillPaths: {
			"grill-me": {
				pi: join(piSkillsRoot, "grill-me"),
				agents: join(agentsSkillsRoot, "grill-me"),
			},
			grilling: {
				pi: join(piSkillsRoot, "grilling"),
				agents: join(agentsSkillsRoot, "grilling"),
			},
		},
	};
}

const FILTERED_SKILLS_ARGUMENTS = [
	"add",
	UPSTREAM_SOURCE,
	"--skill",
	"grill-me",
	"--skill",
	"grilling",
	"--agent",
	"pi",
	"--global",
	"--copy",
	"--yes",
] as const;

export type RunnerKind = "npx" | "npm";

export interface SkillsCliRunner {
	kind: RunnerKind;
	/** Resolved executable used for the no-shell spawn. */
	command: string;
	/** Human-readable executable name used in recovery instructions. */
	name: RunnerKind;
	/** Bootstrap argv used only when Windows requires node + npm CLI instead of a .cmd shell wrapper. */
	prefixArgs?: string[];
	/** Fixed official CLI arguments, excluding any platform bootstrap prefix. */
	args: string[];
}

export function buildRunnerArgs(kind: RunnerKind): string[] {
	if (kind === "npx") return ["--yes", "skills@latest", ...FILTERED_SKILLS_ARGUMENTS];
	return ["exec", "--yes", "--package=skills@latest", "--", "skills", ...FILTERED_SKILLS_ARGUMENTS];
}

export function formatRunnerCommand(runner: Pick<SkillsCliRunner, "name" | "args">): string {
	return [runner.name, ...runner.args].join(" ");
}

export function runnerSpawnArgs(runner: SkillsCliRunner): string[] {
	return [...(runner.prefixArgs ?? []), ...runner.args];
}

export function runnerUsesFixedContract(runner: SkillsCliRunner): boolean {
	const executableName = basename(runner.command).replace(/\.(?:exe|cmd|bat)$/i, "");
	const expectedArgs = buildRunnerArgs(runner.kind);
	const argumentsMatch =
		runner.name === runner.kind &&
		runner.args.length === expectedArgs.length &&
		runner.args.every((argument, index) => argument === expectedArgs[index]);
	if (!argumentsMatch) return false;

	const prefixArgs = runner.prefixArgs ?? [];
	if (prefixArgs.length === 0) return executableName === runner.kind;
	return (
		prefixArgs.length === 1 && executableName === "node" && basename(prefixArgs[0] ?? "") === `${runner.kind}-cli.js`
	);
}

function nodeVersionIsSupported(version: string): boolean {
	const parsed = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!parsed) return false;
	const actual = parsed.slice(1).map(Number);
	const minimum = MINIMUM_NODE_VERSION.split(".").map(Number);
	for (let index = 0; index < minimum.length; index++) {
		const actualPart = actual[index] ?? 0;
		const minimumPart = minimum[index] ?? 0;
		if (actualPart !== minimumPart) return actualPart > minimumPart;
	}
	return true;
}

function executableCandidates(command: string, platform: NodeJS.Platform): string[] {
	if (platform !== "win32" || /\.(?:exe|cmd|bat)$/i.test(command)) return [command];
	return [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command];
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
	const pathValue = env.PATH || env.Path || "";
	const directories = pathValue
		.split(platform === "win32" ? ";" : ":")
		.map((directory) => directory.replace(/^"|"$/g, ""))
		.filter(Boolean);
	for (const directory of directories) {
		for (const candidate of executableCandidates(join(directory, command), platform)) {
			try {
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				// Continue searching the remaining PATH entries.
			}
		}
	}
	return undefined;
}

function windowsNodeCliRunner(
	kind: RunnerKind,
	wrapperPath: string,
	env: NodeJS.ProcessEnv,
): SkillsCliRunner | undefined {
	if (/\.exe$/i.test(wrapperPath)) {
		return { kind, command: wrapperPath, name: kind, args: buildRunnerArgs(kind) };
	}
	const cliPath = join(dirname(wrapperPath), "node_modules", "npm", "bin", `${kind}-cli.js`);
	if (!existsSync(cliPath)) return undefined;
	const node = resolveExecutable("node", env, "win32");
	if (!node || !/\.exe$/i.test(node)) return undefined;
	return { kind, command: node, name: kind, prefixArgs: [cliPath], args: buildRunnerArgs(kind) };
}

/** Find npx first, then the no-shell npm exec equivalent. */
export function discoverRunner(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): SkillsCliRunner | undefined {
	for (const kind of ["npx", "npm"] as const) {
		const command = resolveExecutable(kind, env, platform);
		if (!command) continue;
		if (platform === "win32") {
			const runner = windowsNodeCliRunner(kind, command, env);
			if (runner) return runner;
			continue;
		}
		return { kind, command, name: kind, args: buildRunnerArgs(kind) };
	}
	return undefined;
}

export interface SkillLocationState {
	name: SkillName;
	path: string;
	skillFilePath: string;
	present: boolean;
	isDirectory: boolean;
	skillFileExists: boolean;
	realPath?: string;
	folderHash?: string;
	frontmatterName?: string;
	frontmatterDescription?: string;
	error?: string;
}

export interface SkillLockEntry {
	source?: unknown;
	sourceType?: unknown;
	sourceUrl?: unknown;
	skillPath?: unknown;
	skillFolderHash?: unknown;
	[key: string]: unknown;
}

export interface SkillLockDocument {
	version?: unknown;
	skills?: Record<string, SkillLockEntry>;
	[key: string]: unknown;
}

export interface SkillLockState {
	path: string;
	exists: boolean;
	data?: SkillLockDocument;
	skillNames: string[];
	error?: string;
}

export interface SkillState {
	locations: Record<SkillName, { pi: SkillLocationState; agents: SkillLocationState }>;
	rootEntries: { pi: string[]; agents: string[] };
	rootExists: { pi: boolean; agents: boolean };
	lock: SkillLockState;
}

export type ValidationIssueCode =
	| "missing-target"
	| "invalid-resource"
	| "frontmatter"
	| "duplicate"
	| "lock"
	| "unrelated-resource"
	| "unrelated-lock-entry";

export interface ValidationIssue {
	code: ValidationIssueCode;
	message: string;
}

export interface ValidationResult {
	valid: boolean;
	issues: ValidationIssue[];
	state: SkillState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFrontmatter(filePath: string): { name?: string; description?: string } {
	try {
		const content = readFileSync(filePath, "utf8");
		const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
		if (!frontmatter) return {};
		const fields: { name?: string; description?: string } = {};
		for (const line of frontmatter[1].split(/\r?\n/)) {
			const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line.trim());
			if (!match) continue;
			const key = match[1]?.toLowerCase();
			const value = (match[2] ?? "").trim().replace(/^['"]|['"]$/g, "");
			if (key === "name") fields.name = value;
			if (key === "description") fields.description = value;
		}
		return fields;
	} catch {
		return {};
	}
}

function readRealPath(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

function readStats(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

function hashDirectoryEntry(hash: ReturnType<typeof createHash>, path: string, relativePath: string): void {
	const stats = readStats(path);
	if (!stats) return;

	if (stats.isSymbolicLink()) {
		hash.update(`symlink\0${relativePath}\0${readlinkForHash(path)}\0`);
		return;
	}

	if (stats.isDirectory()) {
		hash.update(`directory\0${relativePath}\0`);
		const entries = readdirSync(path).sort();
		for (const entry of entries) hashDirectoryEntry(hash, join(path, entry), join(relativePath, entry));
		return;
	}

	if (stats.isFile()) {
		hash.update(`file\0${relativePath}\0${stats.size}\0`);
		hash.update(readFileSync(path));
		hash.update("\0");
		return;
	}

	hash.update(`other\0${relativePath}\0${stats.mode}\0`);
}

function readlinkForHash(path: string): string {
	try {
		return readlinkSync(path);
	} catch {
		return "<unreadable-symlink>";
	}
}

export function folderContentHash(path: string): string | undefined {
	const stats = readStats(path);
	if (!stats || (!stats.isDirectory() && !stats.isSymbolicLink())) return undefined;
	try {
		const root = stats.isSymbolicLink() ? realpathSync(path) : path;
		const rootStats = statSync(root);
		if (!rootStats.isDirectory()) return undefined;
		const hash = createHash("sha256");
		hashDirectoryEntry(hash, root, ".");
		return hash.digest("hex");
	} catch {
		return undefined;
	}
}

function readLocation(name: SkillName, path: string): SkillLocationState {
	const stats = readStats(path);
	const skillFilePath = join(path, "SKILL.md");
	const isDirectory = Boolean(stats && (stats.isDirectory() || stats.isSymbolicLink()) && existsSync(skillFilePath));
	const skillFileExists = existsSync(skillFilePath);
	const realPath = skillFileExists ? readRealPath(skillFilePath) : readRealPath(path);
	const frontmatter = skillFileExists ? readFrontmatter(skillFilePath) : {};
	const folderHash = isDirectory ? folderContentHash(path) : undefined;

	return {
		name,
		path,
		skillFilePath,
		present: Boolean(stats),
		isDirectory,
		skillFileExists,
		realPath,
		folderHash,
		frontmatterName: frontmatter.name,
		frontmatterDescription: frontmatter.description,
		error:
			stats && !stats.isDirectory() && !stats.isSymbolicLink()
				? "resource is not a directory"
				: isDirectory && !folderHash
					? "resource content is unreadable"
					: undefined,
	};
}

function rootUsabilityError(path: string): string | undefined {
	const stats = readStats(path);
	if (!stats) return undefined;
	try {
		if (stats.isDirectory() || (stats.isSymbolicLink() && statSync(path).isDirectory())) return undefined;
	} catch {
		return `${path} is not a usable directory`;
	}
	return `${path} is not a usable directory`;
}

function lockUsabilityError(path: string): string | undefined {
	const stats = readStats(path);
	if (!stats || stats.isFile()) return undefined;
	if (stats.isSymbolicLink()) {
		try {
			return statSync(path).isFile() ? undefined : `${path} is not a usable lock file`;
		} catch {
			return undefined;
		}
	}
	return `${path} is not a usable lock file`;
}

function readRootEntries(path: string): { exists: boolean; entries: string[] } {
	const stats = readStats(path);
	if (!stats) return { exists: false, entries: [] };
	try {
		if (!(stats.isDirectory() || (stats.isSymbolicLink() && statSync(path).isDirectory()))) {
			return { exists: true, entries: [] };
		}
		return { exists: true, entries: readdirSync(path).sort() };
	} catch {
		return { exists: true, entries: [] };
	}
}

function readLock(path: string): SkillLockState {
	if (!existsSync(path)) return { path, exists: false, skillNames: [] };
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed)) return { path, exists: true, skillNames: [], error: "lock file is not a JSON object" };
		const rawSkills = parsed.skills;
		const skills = isRecord(rawSkills) ? (rawSkills as Record<string, SkillLockEntry>) : undefined;
		return {
			path,
			exists: true,
			data: { ...parsed, skills },
			skillNames: skills ? Object.keys(skills).sort() : [],
			error: skills ? undefined : 'lock file has no "skills" object',
		};
	} catch (error) {
		return { path, exists: true, skillNames: [], error: `cannot parse lock file: ${(error as Error).message}` };
	}
}

export function inspectSkillState(paths: SkillSyncPaths): SkillState {
	const piRoot = readRootEntries(paths.piSkillsRoot);
	const agentsRoot = readRootEntries(paths.agentsSkillsRoot);

	return {
		locations: {
			"grill-me": {
				pi: readLocation("grill-me", paths.skillPaths["grill-me"].pi),
				agents: readLocation("grill-me", paths.skillPaths["grill-me"].agents),
			},
			grilling: {
				pi: readLocation("grilling", paths.skillPaths.grilling.pi),
				agents: readLocation("grilling", paths.skillPaths.grilling.agents),
			},
		},
		rootEntries: { pi: piRoot.entries, agents: agentsRoot.entries },
		rootExists: { pi: piRoot.exists, agents: agentsRoot.exists },
		lock: readLock(paths.lockPath),
	};
}

function addIssue(issues: ValidationIssue[], code: ValidationIssueCode, message: string): void {
	issues.push({ code, message });
}

function validateRootLocation(issues: ValidationIssue[], location: SkillLocationState, required: boolean): void {
	if (!location.present) {
		if (required) addIssue(issues, "missing-target", `${location.name}: missing Pi target ${location.path}`);
		return;
	}
	if (!location.isDirectory || !location.skillFileExists || location.error) {
		addIssue(
			issues,
			"invalid-resource",
			`${location.name}: ${location.path} is not a usable skill directory${location.error ? ` (${location.error})` : ""}`,
		);
		return;
	}
	if (location.frontmatterName !== location.name) {
		addIssue(
			issues,
			"frontmatter",
			`${location.name}: ${location.skillFilePath} declares ${location.frontmatterName ?? "no name"}`,
		);
	}
	if (!location.frontmatterDescription) {
		addIssue(issues, "frontmatter", `${location.name}: ${location.skillFilePath} has no description`);
	}
}

function normalizeSourceUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.replace(/\/+$/, "").replace(/\.git$/, "");
}

function validateLock(issues: ValidationIssue[], state: SkillState): void {
	if (!state.lock.exists) {
		addIssue(issues, "lock", `missing global skill lock ${state.lock.path}`);
		return;
	}
	if (state.lock.error) {
		addIssue(issues, "lock", state.lock.error);
		return;
	}

	const version = state.lock.data?.version;
	if (typeof version !== "number" || version < 3) {
		addIssue(issues, "lock", `global skill lock must use schema v3 or newer (found ${String(version)})`);
	}

	for (const name of REQUIRED_SKILLS) {
		const entry = state.lock.data?.skills?.[name];
		if (!entry) {
			addIssue(issues, "lock", `global skill lock is missing ${name}`);
			continue;
		}
		if (entry.source !== UPSTREAM_SOURCE) {
			addIssue(issues, "lock", `${name}: lock source is not ${UPSTREAM_SOURCE}`);
		}
		if (entry.sourceType !== "github") {
			addIssue(issues, "lock", `${name}: lock source type is not github`);
		}
		if (normalizeSourceUrl(entry.sourceUrl) !== normalizeSourceUrl(UPSTREAM_URL)) {
			addIssue(issues, "lock", `${name}: lock source URL is not ${UPSTREAM_URL}`);
		}
		if (entry.skillPath !== UPSTREAM_SKILL_PATHS[name]) {
			addIssue(issues, "lock", `${name}: lock skill path is not ${UPSTREAM_SKILL_PATHS[name]}`);
		}
		if (typeof entry.skillFolderHash !== "string" || entry.skillFolderHash.length === 0) {
			addIssue(issues, "lock", `${name}: lock entry has no upstream folder hash`);
		}
	}
}

function validateDuplicates(issues: ValidationIssue[], state: SkillState): void {
	for (const name of REQUIRED_SKILLS) {
		const locations = [state.locations[name].pi, state.locations[name].agents].filter(
			(location) => location.skillFileExists && location.realPath,
		);
		const realPaths = new Set(locations.map((location) => location.realPath));
		if (realPaths.size > 1) {
			addIssue(
				issues,
				"duplicate",
				`${name}: independent same-name skills found at ${locations.map((location) => location.path).join(" and ")}`,
			);
		}
	}
}

function stableSerialize(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
			.join(",")}}`;
	}
	const serialized = JSON.stringify(value);
	return serialized === undefined ? String(value) : serialized;
}

function validateNewEntries(issues: ValidationIssue[], baseline: SkillState | undefined, state: SkillState): void {
	if (!baseline) return;
	for (const root of ["pi", "agents"] as const) {
		const before = new Set(baseline.rootEntries[root]);
		const after = new Set(state.rootEntries[root]);
		for (const entry of after) {
			if (!before.has(entry) && !REQUIRED_SKILLS.includes(entry as SkillName)) {
				addIssue(issues, "unrelated-resource", `new unrelated skill resource appeared in ${root}: ${entry}`);
			}
		}
		for (const entry of before) {
			if (!after.has(entry) && !REQUIRED_SKILLS.includes(entry as SkillName)) {
				addIssue(issues, "unrelated-resource", `unrelated skill resource disappeared from ${root}: ${entry}`);
			}
		}
	}

	const beforeLock = new Set(baseline.lock.skillNames);
	for (const name of state.lock.skillNames) {
		if (!beforeLock.has(name) && !REQUIRED_SKILLS.includes(name as SkillName)) {
			addIssue(issues, "unrelated-lock-entry", `new unrelated skill lock entry appeared: ${name}`);
		}
	}

	const beforeSkills = baseline.lock.data?.skills;
	const afterSkills = state.lock.data?.skills;
	if (beforeSkills && afterSkills) {
		for (const name of Object.keys(beforeSkills)) {
			if (REQUIRED_SKILLS.includes(name as SkillName)) continue;
			if (!(name in afterSkills)) {
				addIssue(issues, "unrelated-lock-entry", `unrelated skill lock entry was removed: ${name}`);
				continue;
			}
			if (stableSerialize(beforeSkills[name]) !== stableSerialize(afterSkills[name])) {
				addIssue(issues, "unrelated-lock-entry", `unrelated skill lock entry was changed: ${name}`);
			}
		}
	}
}

export function validateSkillState(paths: SkillSyncPaths, baseline?: SkillState): ValidationResult {
	const state = inspectSkillState(paths);
	const issues: ValidationIssue[] = [];

	for (const name of REQUIRED_SKILLS) {
		validateRootLocation(issues, state.locations[name].pi, true);
		validateRootLocation(issues, state.locations[name].agents, false);
	}
	validateLock(issues, state);
	validateDuplicates(issues, state);
	validateNewEntries(issues, baseline, state);

	return { valid: issues.length === 0, issues, state };
}

export type SyncOperation = "install" | "repair" | "refresh";

export interface SkillSyncPlan {
	paths: SkillSyncPaths;
	runner?: SkillsCliRunner;
	operation: SyncOperation;
	before: SkillState;
	current: ValidationResult;
	blockers: string[];
}

export interface CreateSkillSyncPlanOptions {
	home?: string;
	xdgStateHome?: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	nodeVersion?: string;
	runner?: SkillsCliRunner;
}

export function createSkillSyncPlan(options: CreateSkillSyncPlanOptions = {}): SkillSyncPlan {
	const paths = getSkillSyncPaths(options.home, options.xdgStateHome);
	const before = inspectSkillState(paths);
	const current = validateSkillState(paths);
	const runner = options.runner ?? discoverRunner(options.env, options.platform);
	const blockers = current.issues
		.filter((issue) => issue.code === "duplicate" || issue.code === "invalid-resource")
		.map((issue) => issue.message);
	for (const root of [paths.piSkillsRoot, paths.agentsSkillsRoot]) {
		const error = rootUsabilityError(root);
		if (error) blockers.push(error);
	}
	const lockError = lockUsabilityError(paths.lockPath);
	if (lockError) blockers.push(lockError);
	if (!runner) blockers.push("Node.js/npm is required: neither npx nor npm is executable on PATH");
	else if (!runnerUsesFixedContract(runner))
		blockers.push("skills CLI runner does not match the fixed Pi-only argv contract");
	const nodeVersion = options.nodeVersion ?? process.versions.node;
	if (!nodeVersionIsSupported(nodeVersion)) {
		blockers.push(`Node.js ${MINIMUM_NODE_VERSION} or newer is required (found ${nodeVersion})`);
	}

	const hasExistingState =
		before.lock.exists ||
		REQUIRED_SKILLS.some((name) => before.locations[name].pi.present || before.locations[name].agents.present);
	const operation: SyncOperation = current.valid ? "refresh" : hasExistingState ? "repair" : "install";

	return { paths, runner, operation, before, current, blockers };
}

export function renderSkillSyncPlan(plan: SkillSyncPlan): string {
	const display = (value: string): string => sanitizeTerminalText(value, 2_000).replace(/\n+/g, " ");
	const lines = [
		`operation: ${plan.operation}`,
		`source: ${UPSTREAM_SOURCE} (Matt Pocock, MIT)`,
		"skills: grill-me, grilling",
		`runner: ${plan.runner ? display(formatRunnerCommand(plan.runner)) : "unavailable"}`,
		`Pi targets: ${display(plan.paths.piSkillsRoot)}`,
		`duplicate-check root: ${display(plan.paths.agentsSkillsRoot)}`,
		`lock: ${display(plan.paths.lockPath)}`,
		"action: the filtered official skills CLI will use network access and write only after confirmation",
	];

	for (const blocker of plan.blockers) lines.push(`BLOCKED: ${display(blocker)}`);
	if (plan.blockers.length === 0) {
		lines.push(
			`argv: ${plan.runner ? display(formatRunnerCommand(plan.runner)) : "npx --yes skills@latest add ..."}`,
			"refreshes both skills with the same explicit --agent pi --global --copy selection",
		);
	}
	return lines.join("\n");
}
