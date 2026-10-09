/**
 * Path-scoped specs: when the model reads or edits a file, specs whose
 * frontmatter `paths:` match it are appended to that tool result.
 *
 * Each spec enters the context once per session. What is "already in the
 * context" is derived from the session itself: the markers of earlier
 * injections in tool results that are still part of the model's context
 * (after the last compaction's kept point). So a spec comes back after a
 * compaction summarized it away, after `/tree` moved to a branch without it,
 * and when its file changed (the marker carries a content hash) — and never
 * otherwise. There is no time-based reminder.
 *
 * Budgets are in characters (see text.ts): per spec body, per tool result,
 * and per session for full bodies. Past a budget a spec is listed by path and
 * description instead of attached.
 */

import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HEAD_MAX_BYTES, parseFrontmatter } from "./frontmatter.ts";
import { compareSpecificity, compileGlob, globError, specificity } from "./glob.ts";
import { truncateChars } from "./text.ts";

export const BUDGET = {
	perSpec: 6000,
	perResult: 8000,
	perSession: 40000,
} as const;

export interface SpecRule {
	/** Repo-relative path of the spec file. */
	path: string;
	globs: Array<{ glob: string; regex: RegExp }>;
	description?: string;
}

export interface SpecProblem {
	path: string;
	message: string;
}

interface CacheEntry {
	mtimeMs: number;
	size: number;
	rule?: SpecRule;
	problems: SpecProblem[];
}

function readHead(path: string): string {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(HEAD_MAX_BYTES);
		const bytes = readSync(fd, buffer, 0, HEAD_MAX_BYTES, 0);
		return buffer.subarray(0, bytes).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function listMarkdown(dir: string, prefix: string, out: string[]): void {
	let names;
	try {
		names = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of names) {
		if (entry.name.startsWith(".")) continue;
		const rel = `${prefix}/${entry.name}`;
		if (entry.isDirectory()) listMarkdown(join(dir, entry.name), rel, out);
		else if (entry.isFile() && entry.name.endsWith(".md")) out.push(rel);
	}
}

/** Scans `.trellis/spec/**\/*.md` heads, re-reading only files whose mtime or size changed. */
export class SpecIndex {
	private cache = new Map<string, CacheEntry>();

	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	scan(): { rules: SpecRule[]; problems: SpecProblem[] } {
		const files: string[] = [];
		listMarkdown(join(this.root, ".trellis", "spec"), ".trellis/spec", files);
		files.sort();
		const rules: SpecRule[] = [];
		const problems: SpecProblem[] = [];
		const seen = new Set<string>();
		for (const path of files) {
			seen.add(path);
			const full = join(this.root, path);
			let info;
			try {
				info = statSync(full);
			} catch {
				continue;
			}
			let entry = this.cache.get(path);
			if (!entry || entry.mtimeMs !== info.mtimeMs || entry.size !== info.size) {
				entry = { mtimeMs: info.mtimeMs, size: info.size, problems: [] };
				try {
					const front = parseFrontmatter(readHead(full));
					if (front?.paths?.length) {
						const globs: SpecRule["globs"] = [];
						for (const glob of front.paths) {
							const error = globError(glob);
							if (error) entry.problems.push({ path, message: `glob "${glob}": ${error}` });
							else globs.push({ glob, regex: compileGlob(glob) });
						}
						if (globs.length > 0) entry.rule = { path, globs, description: front.description };
					}
				} catch (error) {
					entry.problems.push({ path, message: (error as Error).message });
				}
				this.cache.set(path, entry);
			}
			if (entry.rule) rules.push(entry.rule);
			problems.push(...entry.problems);
		}
		for (const path of this.cache.keys()) if (!seen.has(path)) this.cache.delete(path);
		return { rules, problems };
	}

	/** Specs governing `file` (repo-relative), most specific first. */
	match(file: string): SpecRule[] {
		const scored: Array<{ rule: SpecRule; score: number[] }> = [];
		for (const rule of this.scan().rules) {
			let best: number[] | undefined;
			for (const { glob, regex } of rule.globs) {
				if (!regex.test(file)) continue;
				const score = specificity(glob);
				if (!best || compareSpecificity(score, best) < 0) best = score;
			}
			if (best) scored.push({ rule, score: best });
		}
		scored.sort((a, b) => compareSpecificity(a.score, b.score) || (a.rule.path < b.rule.path ? -1 : 1));
		return scored.map((entry) => entry.rule);
	}
}

// ── which files a tool call touched ──────────────────────────────────────────

const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gmu;

/** Paths named by a read/edit/write/apply_patch call, as written by the model. */
export function touchedPaths(toolName: string, input: Record<string, unknown>): string[] {
	if (toolName === "apply_patch") {
		const patch = typeof input.input === "string" ? input.input : typeof input.patch === "string" ? input.patch : "";
		return [...patch.matchAll(PATCH_PATH)].map((match) => (match[1] ?? "").trim()).filter(Boolean);
	}
	if (toolName === "read" || toolName === "edit" || toolName === "write") {
		const path = input.path ?? input.file_path;
		return typeof path === "string" && path.trim() ? [path.trim()] : [];
	}
	return [];
}

function realOrResolved(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// A file that does not exist (yet): resolve its directory instead.
		try {
			return join(realpathSync(dirname(path)), path.slice(dirname(path).length + 1));
		} catch {
			return path;
		}
	}
}

/** Repo-relative POSIX path of `path` (as given to a tool in `cwd`), or undefined outside the root. */
export function repoRelative(root: string, cwd: string, path: string): string | undefined {
	let given = path.startsWith("@") ? path.slice(1) : path;
	if (given === "~" || given.startsWith("~/")) given = join(homedir(), given.slice(1));
	const absolute = isAbsolute(given) ? given : resolve(cwd, given);
	const rel = relative(realOrResolved(root), realOrResolved(absolute));
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return rel.split(sep).join("/").normalize("NFC");
}

// ── what the context already holds ──────────────────────────────────────────

export interface Injected {
	sha: string;
	/** Attached in full (counts toward the session budget) or only listed. */
	full: boolean;
	chars: number;
}

const BLOCK = /<spec path="([^"]+)" sha="([0-9a-f]{12})"( listed="budget")?>[\s\S]*?<\/spec>/gu;

/** Markers of earlier injections found in tool-result text. */
export function readMarkers(texts: Iterable<string>): Map<string, Injected> {
	const found = new Map<string, Injected>();
	for (const text of texts) {
		if (!text.includes("<spec-context")) continue;
		for (const match of text.matchAll(BLOCK)) {
			const path = match[1] ?? "";
			const full = match[3] === undefined;
			const previous = found.get(path);
			// A full copy wins over a listing of the same content.
			if (previous && previous.sha === match[2] && previous.full && !full) continue;
			found.set(path, { sha: match[2] ?? "", full, chars: full ? match[0].length : 0 });
		}
	}
	return found;
}

interface BranchEntry {
	type: string;
	id?: string;
	firstKeptEntryId?: string;
	message?: { role?: string; content?: unknown };
}

/** Tool-result texts that are still in the model's context on this branch. */
export function contextToolTexts(branch: readonly BranchEntry[]): string[] {
	let start = 0;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "compaction") continue;
		const kept = entry.firstKeptEntryId ? branch.findIndex((candidate) => candidate.id === entry.firstKeptEntryId) : -1;
		start = kept >= 0 && kept < i ? kept : i + 1;
		break;
	}
	const texts: string[] = [];
	for (const entry of branch.slice(start)) {
		if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
				texts.push(String((part as { text?: unknown }).text ?? ""));
			}
		}
	}
	return texts;
}

// ── building one injection ──────────────────────────────────────────────────

export function contentSha(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export interface InjectionResult {
	text: string;
	/** Specs added by this injection (to update the in-memory state). */
	added: Map<string, Injected>;
}

export interface BuildOptions {
	root: string;
	file: string;
	rules: SpecRule[];
	state: ReadonlyMap<string, Injected>;
	budget?: typeof BUDGET;
	readSpec?: (path: string) => string | undefined;
}

function defaultRead(root: string, path: string): string | undefined {
	try {
		const full = join(root, path);
		if (lstatSync(full).isSymbolicLink()) return undefined;
		return readFileSync(full, "utf8");
	} catch {
		return undefined;
	}
}

function bodyOf(text: string): string {
	try {
		const front = parseFrontmatter(text);
		return (front ? text.slice(front.bodyStart) : text).trim();
	} catch {
		return text.trim();
	}
}

const escapeAttr = (value: string) => value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;");

/** The text to append for `file`, or undefined when nothing new applies. */
export function buildInjection(options: BuildOptions): InjectionResult | undefined {
	const budget = options.budget ?? BUDGET;
	const read = options.readSpec ?? ((path: string) => defaultRead(options.root, path));
	let sessionChars = 0;
	for (const injected of options.state.values()) sessionChars += injected.chars;

	const blocks: string[] = [];
	const added = new Map<string, Injected>();
	let resultChars = 0;

	for (const rule of options.rules) {
		const text = read(rule.path);
		if (text === undefined) continue;
		const sha = contentSha(text);
		const known = options.state.get(rule.path);
		if (known && known.sha === sha) continue;

		const path = escapeAttr(rule.path);
		let body = bodyOf(text);
		if (body.length > budget.perSpec) {
			body = `${truncateChars(body, budget.perSpec)}\n[truncated at ${budget.perSpec} characters; read ${rule.path} for the rest]`;
		}
		const full = `<spec path="${path}" sha="${sha}">\n${body}\n</spec>`;
		if (resultChars + full.length <= budget.perResult && sessionChars + full.length <= budget.perSession) {
			blocks.push(full);
			resultChars += full.length;
			sessionChars += full.length;
			added.set(rule.path, { sha, full: true, chars: full.length });
			continue;
		}
		const note = rule.description ? escapeAttr(rule.description) : "read it before changing this file";
		blocks.push(`<spec path="${path}" sha="${sha}" listed="budget">${note}</spec>`);
		added.set(rule.path, { sha, full: false, chars: 0 });
	}

	if (blocks.length === 0) return undefined;
	return {
		text: [
			`<spec-context file="${escapeAttr(options.file)}">`,
			"Project specs that govern this file (from their `paths:` frontmatter). Follow them when changing it. A listed spec was not attached to save context; read it if it is relevant.",
			...blocks,
			"</spec-context>",
		].join("\n"),
		added,
	};
}

/** Directories never matched: the specs themselves and other Trellis data. */
export function isTrellisPath(file: string): boolean {
	return file === ".trellis" || file.startsWith(".trellis/");
}
