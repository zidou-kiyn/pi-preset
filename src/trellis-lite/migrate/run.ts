/**
 * Migration from Trellis (or mini-trellis) to trellis-lite: the deterministic
 * part. `scanMigration` classifies every file Trellis could have installed;
 * `applyMigration` deletes what is provably an unmodified template or runtime
 * leftover and makes the exact shared-file edits. Anything that needs
 * judgment (modified templates, unregistered files in Trellis directories) is
 * kept and reported as needs-review for the AI-guided step.
 *
 * Classification, first match wins:
 *   1 user data      .trellis/{spec,workspace,tasks,research}/**, .developer   untouched
 *   2 runtime        __pycache__/, *.pyc, .trellis/{.runtime/,.backup-*,...}  delete
 *   3 shared         AGENTS.md, .pi/settings.json, .trellis/.gitignore, .gitignore  exact edit
 *   4 other host     registered files outside .trellis/.pi/.agents        kept unless removeHosts
 *   5 pristine       registered, sha256 matches                            delete
 *   6 modified       registered, sha256 differs                            needs-review
 *   7 unregistered   in a Trellis-owned path, not registered               needs-review
 * Without a usable hash table, 5 and 6 cannot be told apart: every file in a
 * Trellis-owned path is needs-review.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyInit, planInit } from "../init.ts";
import { today } from "../journal.ts";
import { parseFrontmatter } from "../frontmatter.ts";
import { readDeveloper } from "../root.ts";
import { cleanPiSettings, cleanRootGitignore, cleanTrellisGitignore, type EditOutcome, removeManagedBlock } from "./edits.ts";

const USER_DATA = [".trellis/spec/", ".trellis/workspace/", ".trellis/tasks/", ".trellis/research/"];
const RUNTIME_DIRS = [/^\.trellis\/\.runtime$/u, /^\.trellis\/\.backup-[^/]+$/u];
const RUNTIME_FILES = new Set([
	".trellis/.current-task",
	".trellis/.ralph-state.json",
	".trellis/.version",
	".trellis/.agent-log",
	".trellis/.session-id",
	".trellis/.plan-log",
]);
const HASH_FILE = ".trellis/.template-hashes.json";
const SHARED = [".pi/settings.json", ".trellis/.gitignore", "AGENTS.md", ".gitignore"];
const PI_AREAS = new Set([".trellis", ".pi", ".agents"]);
const KNOWN_HOSTS = [".claude", ".codex", ".cursor", ".opencode", ".gemini", ".kiro", ".qoder", ".codebuddy", ".factory", ".kilocode", ".windsurf"];

/** Paths Trellis owns even when a file there is not in the hash table. */
export function isTrellisOwned(path: string): boolean {
	if (/^\.trellis\/(scripts|agents|workflows)\//u.test(path)) return true;
	if (path === ".trellis/workflow.md" || path === ".trellis/config.yaml") return true;
	if (path.startsWith(".trellis/")) return false;
	return path.split("/").some((segment) => /^(mini-)?trellis(-.*)?(\.md)?$/u.test(segment) || /^(mini-)?trellis-/u.test(segment));
}

export interface PathItem {
	path: string;
	reason: string;
	/** A directory removed as a whole (runtime leftovers), with its file count. */
	files?: number;
}

export interface EditItem {
	path: string;
	action: "edit" | "delete";
	removed: string[];
	text?: string;
}

export interface StaleReference {
	file: string;
	line: number;
	term: string;
	text: string;
}

export interface MigrationPlan {
	root: string;
	trellisVersion?: string;
	hashTable: boolean;
	git: { repo: boolean; clean: boolean; dirty: string[] };
	delete: PathItem[];
	edit: EditItem[];
	needsReview: PathItem[];
	hosts: Record<string, { delete: PathItem[]; review: PathItem[] }>;
	staleReferences: StaleReference[];
	pathHints: Array<{ spec: string; dirs: string[] }>;
	activeTasks: Array<{ path: string; trellisFiles: string[] }>;
	nothingToDo: boolean;
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readHashes(root: string): Map<string, string> | undefined {
	try {
		const data = JSON.parse(readFileSync(join(root, ".trellis", ".template-hashes.json"), "utf8")) as {
			hashes?: Record<string, unknown>;
		};
		if (!data.hashes || typeof data.hashes !== "object") return undefined;
		const map = new Map<string, string>();
		for (const [path, hash] of Object.entries(data.hashes)) if (typeof hash === "string") map.set(path, hash);
		return map;
	} catch {
		return undefined;
	}
}

function walk(root: string, rel: string, out: string[], runtimeDirs: Array<{ path: string; files: number }>): void {
	let entries;
	try {
		entries = readdirSync(join(root, rel), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			if (USER_DATA.some((prefix) => `${path}/` === prefix)) continue;
			if (entry.name === "__pycache__" || RUNTIME_DIRS.some((pattern) => pattern.test(path))) {
				const files: string[] = [];
				walk(root, path, files, []);
				runtimeDirs.push({ path: `${path}/`, files: files.length });
				continue;
			}
			walk(root, path, out, runtimeDirs);
		} else {
			out.push(path);
		}
	}
}

function git(root: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
	} catch {
		return undefined;
	}
}

export function gitState(root: string): MigrationPlan["git"] {
	const status = git(root, ["status", "--porcelain", "--untracked-files=all"]);
	if (status === undefined) return { repo: false, clean: false, dirty: [] };
	const dirty = status
		.split("\n")
		.filter(Boolean)
		.map((line) => line.slice(3));
	return { repo: true, clean: dirty.length === 0, dirty };
}

const STALE_TERMS = [
	"task.py",
	"add_session.py",
	"get_context.py",
	"init_developer.py",
	"trellis_subagent",
	"workflow-state",
	"implement.jsonl",
	"check.jsonl",
	".current-task",
	".trellis/workflow.md",
	"trellis-before-dev",
	"trellis-check",
	"trellis-implement",
	"trellis-research",
	"trellis-update-spec",
	"trellis-brainstorm",
	"trellis-break-loop",
	"/trellis:finish-work",
	"/trellis:continue",
	"/trellis:start",
];
const escapeRegex = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
const STALE_PATTERN = new RegExp(
	`(?<![A-Za-z0-9_-])(${STALE_TERMS.map(escapeRegex).join("|")})(?![A-Za-z0-9_-])`,
	"gu",
);

/** References to removed Trellis machinery, with word boundaries (no `test_x_task.py` hits). */
export function findStaleReferences(file: string, text: string): StaleReference[] {
	const found: StaleReference[] = [];
	text.split("\n").forEach((line, index) => {
		for (const match of line.matchAll(STALE_PATTERN)) {
			found.push({ file, line: index + 1, term: match[1] ?? "", text: line.trim().slice(0, 200) });
		}
	});
	return found;
}

function markdownFiles(root: string, rel: string): string[] {
	const out: string[] = [];
	const visit = (dir: string) => {
		let entries;
		try {
			entries = readdirSync(join(root, dir), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = `${dir}/${entry.name}`;
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && entry.name.endsWith(".md")) out.push(path);
		}
	};
	visit(rel);
	return out.sort();
}

const PATH_TOKEN = /`([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@[\]()-]+)+\/?)`/gu;

/** For specs without `paths:`, the repository directories their text refers to most. */
export function pathHints(root: string, specs: string[]): MigrationPlan["pathHints"] {
	const hints: MigrationPlan["pathHints"] = [];
	for (const spec of specs) {
		const text = readFileSync(join(root, spec), "utf8");
		try {
			if (parseFrontmatter(text)?.paths?.length) continue;
		} catch {
			continue;
		}
		const counts = new Map<string, number>();
		for (const match of text.matchAll(PATH_TOKEN)) {
			const token = (match[1] ?? "").replace(/\/$/u, "");
			if (token.startsWith(".trellis/") || !existsSync(join(root, token))) continue;
			const parts = token.split("/");
			let dir: string;
			try {
				dir = statSync(join(root, token)).isDirectory() ? parts.slice(0, 2).join("/") : parts.slice(0, Math.min(2, parts.length - 1)).join("/");
			} catch {
				continue;
			}
			if (!dir) continue;
			counts.set(dir, (counts.get(dir) ?? 0) + 1);
		}
		const dirs = [...counts.entries()]
			.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
			.slice(0, 3)
			.map(([dir, n]) => `${dir}/** (${n})`);
		if (dirs.length > 0) hints.push({ spec, dirs });
	}
	return hints;
}

function sharedEdit(path: string, text: string): EditOutcome {
	if (path === "AGENTS.md") return removeManagedBlock(text);
	if (path === ".pi/settings.json") return cleanPiSettings(text);
	if (path === ".trellis/.gitignore") return cleanTrellisGitignore(text);
	return cleanRootGitignore(text);
}

export function scanMigration(root: string): MigrationPlan {
	const hashes = readHashes(root);
	let trellisVersion: string | undefined;
	try {
		trellisVersion = readFileSync(join(root, ".trellis", ".version"), "utf8").trim() || undefined;
	} catch {
		// no version file
	}

	const hostDirs = new Set<string>();
	for (const path of hashes?.keys() ?? []) {
		const top = path.split("/")[0] ?? "";
		if (path.includes("/") && !PI_AREAS.has(top)) hostDirs.add(top);
	}
	for (const dir of KNOWN_HOSTS) if (existsSync(join(root, dir))) hostDirs.add(dir);

	const files: string[] = [];
	const runtimeDirs: Array<{ path: string; files: number }> = [];
	for (const area of [...PI_AREAS, ...hostDirs]) {
		try {
			if (lstatSync(join(root, area)).isDirectory()) walk(root, area, files, runtimeDirs);
		} catch {
			// area absent
		}
	}

	const plan: MigrationPlan = {
		root,
		trellisVersion,
		hashTable: hashes !== undefined,
		git: gitState(root),
		delete: [],
		edit: [],
		needsReview: [],
		hosts: {},
		staleReferences: [],
		pathHints: [],
		activeTasks: [],
		nothingToDo: false,
	};
	const host = (dir: string) => {
		plan.hosts[dir] ??= { delete: [], review: [] };
		return plan.hosts[dir];
	};

	// Runtime leftovers in another host's directory belong to that host's group.
	const runtime = (item: PathItem) => {
		const top = item.path.split("/")[0] ?? "";
		if (PI_AREAS.has(top)) plan.delete.push(item);
		else host(top).delete.push(item);
	};
	for (const dir of runtimeDirs.sort((a, b) => (a.path < b.path ? -1 : 1))) {
		runtime({ path: dir.path, reason: "runtime", files: dir.files });
	}

	for (const path of files.sort()) {
		if (path === ".trellis/.developer" || path === HASH_FILE || SHARED.includes(path)) continue;
		if (path.endsWith(".pyc") || RUNTIME_FILES.has(path)) {
			runtime({ path, reason: "runtime" });
			continue;
		}
		const top = path.split("/")[0] ?? "";
		const registered = hashes?.get(path);
		const owned = isTrellisOwned(path);
		const isHost = !PI_AREAS.has(top);
		if (registered === undefined && !owned) continue;

		let item: PathItem;
		let pristine = false;
		if (registered === undefined) {
			item = { path, reason: hashes ? "not in Trellis's hash table" : "no hash table to verify it" };
		} else if (sha256(join(root, path)) === registered) {
			item = { path, reason: "unmodified template" };
			pristine = true;
		} else {
			item = { path, reason: "modified template" };
		}
		if (isHost) {
			(pristine ? host(top).delete : host(top).review).push(item);
		} else if (pristine) {
			plan.delete.push(item);
		} else {
			plan.needsReview.push(item);
		}
	}

	for (const path of SHARED) {
		let text: string;
		try {
			text = readFileSync(join(root, path), "utf8");
		} catch {
			continue;
		}
		const outcome = sharedEdit(path, text);
		if (outcome.kind === "edit") plan.edit.push({ path, action: "edit", removed: outcome.removed, text: outcome.text });
		else if (outcome.kind === "delete") plan.edit.push({ path, action: "delete", removed: outcome.removed });
		else if (outcome.kind === "review") plan.needsReview.push({ path, reason: outcome.reason });
	}

	const specs = markdownFiles(root, ".trellis/spec");
	for (const file of specs) plan.staleReferences.push(...findStaleReferences(file, readFileSync(join(root, file), "utf8")));
	// AGENTS.md as it will be after the edit: the managed block is going anyway.
	// (Line numbers then refer to the edited file.)
	const agents = plan.edit.find((item) => item.path === "AGENTS.md");
	if (agents?.action !== "delete" && existsSync(join(root, "AGENTS.md"))) {
		plan.staleReferences.push(...findStaleReferences("AGENTS.md", agents?.text ?? readFileSync(join(root, "AGENTS.md"), "utf8")));
	}
	plan.pathHints = pathHints(root, specs);

	try {
		for (const entry of readdirSync(join(root, ".trellis", "tasks"), { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === "archive" || entry.name.startsWith(".")) continue;
			const trellisFiles = readdirSync(join(root, ".trellis", "tasks", entry.name)).filter(
				(name) => name === "task.json" || name.endsWith(".jsonl"),
			);
			plan.activeTasks.push({ path: `.trellis/tasks/${entry.name}/`, trellisFiles: trellisFiles.sort() });
		}
	} catch {
		// no tasks
	}

	// Files of other hosts that are kept are information, not pending work.
	plan.nothingToDo = plan.delete.length === 0 && plan.edit.length === 0 && plan.needsReview.length === 0;
	return plan;
}

export interface ApplyOptions {
	removeHosts?: readonly string[];
	date?: string;
	now?: string;
}

export interface ApplyReport {
	deleted: string[];
	edited: string[];
	created: string[];
	needsReview: PathItem[];
	trellisVersion?: string;
}

function removeEmptyParents(root: string, path: string, stops: Set<string>): void {
	let dir = dirname(path);
	while (dir !== "." && dir !== "" && !stops.has(dir)) {
		try {
			if (readdirSync(join(root, dir)).length > 0) return;
			rmdirSync(join(root, dir));
		} catch {
			return;
		}
		dir = dirname(dir);
	}
}

/** Re-scan and apply. Refuses outside git or with a dirty work tree (git is the rollback). */
export function applyMigration(root: string, options: ApplyOptions = {}): ApplyReport {
	const plan = scanMigration(root);
	if (!plan.git.repo) throw new Error("Not a git repository; migration needs git to be undoable.");
	if (!plan.git.clean) {
		throw new Error(`The work tree has uncommitted changes; commit or stash them first:\n${plan.git.dirty.slice(0, 20).join("\n")}`);
	}
	const report: ApplyReport = { deleted: [], edited: [], created: [], needsReview: [...plan.needsReview], trellisVersion: plan.trellisVersion };
	const removeHosts = new Set(options.removeHosts ?? []);
	const toDelete = [...plan.delete];
	for (const [dir, group] of Object.entries(plan.hosts)) {
		if (removeHosts.has(dir) || removeHosts.has(dir.replace(/^\./u, ""))) {
			toDelete.push(...group.delete);
			report.needsReview.push(...group.review);
		}
	}
	const stops = new Set([".trellis", ".trellis/spec", ".trellis/workspace", ".trellis/tasks"]);
	for (const item of toDelete) {
		rmSync(join(root, item.path), { recursive: true, force: true });
		report.deleted.push(item.path);
		removeEmptyParents(root, item.path.replace(/\/$/u, ""), stops);
	}
	for (const item of plan.edit) {
		const full = join(root, item.path);
		if (item.action === "delete") rmSync(full, { force: true });
		else writeFileSync(full, item.text ?? "");
		report.edited.push(`${item.path} (${item.action === "delete" ? "deleted, only Trellis content" : "Trellis parts removed"})`);
		if (item.action === "delete") removeEmptyParents(root, item.path, stops);
	}
	// The hash table keeps verifying what is left (other hosts' files, files
	// kept for review); it goes once nothing it lists remains.
	const hashFile = join(root, HASH_FILE);
	if (existsSync(hashFile)) {
		const data = JSON.parse(readFileSync(hashFile, "utf8")) as Record<string, unknown> & { hashes?: Record<string, unknown> };
		const remaining = Object.fromEntries(Object.entries(data.hashes ?? {}).filter(([path]) => !SHARED.includes(path) && existsSync(join(root, path))));
		if (Object.keys(remaining).length === 0) {
			rmSync(hashFile);
			report.deleted.push(HASH_FILE);
		} else if (Object.keys(remaining).length !== Object.keys(data.hashes ?? {}).length) {
			writeFileSync(hashFile, `${JSON.stringify({ ...data, hashes: remaining }, null, 2)}\n`);
			report.edited.push(`${HASH_FILE} (kept for ${Object.keys(remaining).length} remaining Trellis file(s))`);
		}
	}
	const steps = planInit(root, readDeveloper(root), options.date ?? today(), options.now ?? new Date().toISOString().slice(0, 19));
	applyInit(root, steps);
	report.created = steps.map((step) => step.path);
	return report;
}
