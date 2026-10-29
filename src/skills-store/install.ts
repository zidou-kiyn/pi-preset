/**
 * Installing skills into the local store, and checking them for updates.
 *
 * Sources, as `npx skills add` takes them, plus local paths:
 *   owner/repo             every skill in the repository (one is installed
 *                          without asking; several come back as candidates)
 *   owner/repo@skill       one skill by name
 *   https://github.com/owner/repo[/tree/<ref>/<path>]
 *   git@host:owner/repo.git, any *.git URL
 *   /a/local/directory     a skill directory or a tree holding some
 *
 * A git source is cloned shallowly into a temp directory, the skill
 * directories (those with a SKILL.md) are found, the chosen ones are copied
 * into the store, and `.pi-preset-source.json` records where they came from
 * and the commit, so "check updates" can compare against `git ls-remote`
 * without a clone. Nothing is run from the fetched files.
 */

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { type InstallRecord, NAME_RULE, readStoreSkill, SOURCE_FILE, type StoreSkill, validateSkill } from "./catalog.ts";

const execFileAsync = promisify(execFile);

export interface ParsedSource {
	source: string;
	/** Absent for a local path. */
	repo?: string;
	ref?: string;
	/** Subdirectory to look in ("" = whole tree). */
	path: string;
	/** Skill name asked for with `@name`. */
	skill?: string;
	/** Local directory, when the source is one. */
	local?: string;
}

export function parseSource(input: string): ParsedSource {
	const source = input.trim();
	if (!source) throw new Error("empty source");
	if (source.startsWith("/") || source.startsWith("~") || source.startsWith(".")) {
		const local = source.startsWith("~") ? join(process.env.HOME ?? "", source.slice(1)) : resolve(source);
		if (!existsSync(local)) throw new Error(`${local} does not exist`);
		return { source, path: "", local };
	}
	let match = source.match(/^https?:\/\/(github\.com|gitlab\.com)\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/u);
	if (match) {
		return {
			source,
			repo: `https://${match[1]}/${match[2]}/${match[3]}.git`,
			ref: match[4],
			path: (match[5] ?? "").replace(/\/+$/u, ""),
		};
	}
	if (/^(https?:\/\/|git@|ssh:\/\/)/u.test(source)) return { source, repo: source, path: "" };
	match = source.match(/^([\w.-]+)\/([\w.-]+?)(?:@([\w.-]+))?$/u);
	if (match) {
		return { source, repo: `https://github.com/${match[1]}/${match[2]}.git`, path: "", skill: match[3] };
	}
	throw new Error(`cannot read "${source}" as owner/repo, owner/repo@skill, a git URL, or a local path`);
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "vendor", "test", "tests", "__pycache__"]);

/** Directories holding a SKILL.md under `root`, nearest first, at most `depth` levels down. */
export function findSkillDirs(root: string, depth = 4): string[] {
	const found: string[] = [];
	const walk = (dir: string, level: number) => {
		if (existsSync(join(dir, "SKILL.md"))) {
			found.push(dir);
			return;
		}
		if (level >= depth) return;
		let entries: string[];
		try {
			entries = readdirSync(dir).sort();
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
			const full = join(dir, entry);
			try {
				if (statSync(full).isDirectory()) walk(full, level + 1);
			} catch {
				// unreadable entry
			}
		}
	};
	walk(root, 0);
	return found;
}

export interface Candidate {
	name: string;
	description: string;
	dir: string;
	/** Directory relative to the repository root. */
	path: string;
}

async function git(args: string[], cwd?: string, timeout = 90_000): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
		return stdout.trim();
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new Error(stderr ? stderr.split("\n").at(-1) : (error as Error).message);
	}
}

export interface Fetched {
	parsed: ParsedSource;
	/** Root of the checkout (or the local path). */
	root: string;
	commit?: string;
	candidates: Candidate[];
	cleanup: () => void;
}

/** Clone (or open) the source and list the skills in it. Call `cleanup()` when done. */
export async function fetchSource(input: string): Promise<Fetched> {
	const parsed = parseSource(input);
	let root: string;
	let commit: string | undefined;
	let cleanup = () => {};
	if (parsed.local) root = parsed.local;
	else {
		const tmp = mkdtempSync(join(tmpdir(), "pi-preset-skill-"));
		cleanup = () => rmSync(tmp, { recursive: true, force: true });
		const args = ["clone", "--depth", "1", "--quiet"];
		if (parsed.ref) args.push("--branch", parsed.ref);
		args.push(parsed.repo!, tmp);
		try {
			await git(args);
			commit = await git(["rev-parse", "HEAD"], tmp);
		} catch (error) {
			cleanup();
			throw new Error(`clone failed: ${(error as Error).message}`);
		}
		root = tmp;
	}
	const base = parsed.path ? join(root, parsed.path) : root;
	const candidates: Candidate[] = [];
	for (const dir of findSkillDirs(base)) {
		const skill = readStoreSkill(dir, "local");
		if (!skill) continue;
		candidates.push({ name: skill.name, description: skill.description, dir, path: relative(root, dir) });
	}
	return { parsed, root, commit, candidates, cleanup };
}

/** The candidates the source asks for: the `@name` one, or all of them. */
export function chooseCandidates(fetched: Fetched): Candidate[] {
	const wanted = fetched.parsed.skill;
	if (!wanted) return fetched.candidates;
	const exact = fetched.candidates.filter((c) => c.name === wanted || basename(c.dir) === wanted);
	if (exact.length > 0) return exact;
	throw new Error(`no skill named "${wanted}" in ${fetched.parsed.source} (found: ${fetched.candidates.map((c) => c.name).join(", ") || "none"})`);
}

export interface InstallResult {
	skill: StoreSkill;
	replaced: boolean;
}

/** Copy one candidate into the store, recording its source. Overwrites an existing directory of the same name. */
export function installCandidate(fetched: Fetched, candidate: Candidate, localDir: string): InstallResult {
	if (!NAME_RULE.test(candidate.name)) throw new Error(`"${candidate.name}" is not a valid skill name`);
	const target = join(localDir, candidate.name);
	const replaced = existsSync(target);
	const staging = `${target}.installing`;
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(localDir, { recursive: true });
	cpSync(candidate.dir, staging, { recursive: true, filter: (src) => basename(src) !== ".git" });
	const record: InstallRecord = {
		source: fetched.parsed.source,
		path: candidate.path,
		installedAt: new Date().toISOString(),
	};
	if (fetched.parsed.repo) record.repo = fetched.parsed.repo;
	if (fetched.parsed.ref) (record as InstallRecord & { ref?: string }).ref = fetched.parsed.ref;
	if (fetched.commit) record.commit = fetched.commit;
	writeFileSync(join(staging, SOURCE_FILE), `${JSON.stringify(record, null, 2)}\n`);
	rmSync(target, { recursive: true, force: true });
	cpSync(staging, target, { recursive: true });
	rmSync(staging, { recursive: true, force: true });
	const skill = readStoreSkill(target, "local");
	if (!skill) throw new Error(`${candidate.name}: SKILL.md is not loadable after copying`);
	return { skill, replaced };
}

/** Remove a local skill directory. */
export function removeSkill(skill: StoreSkill): void {
	if (skill.origin !== "local") throw new Error(`${skill.name} is bundled with the preset and cannot be removed`);
	rmSync(skill.dir, { recursive: true, force: true });
}

export interface UpdateCheck {
	name: string;
	/** undefined = not checkable (no repo or commit recorded, or the remote failed). */
	outdated?: boolean;
	remote?: string;
	error?: string;
}

/** Compare a skill's recorded commit with the remote head. One `git ls-remote`, no clone. */
export async function checkUpdate(skill: StoreSkill): Promise<UpdateCheck> {
	const install = skill.install;
	if (!install?.repo || !install.commit) return { name: skill.name, error: "no source recorded" };
	const ref = (install as InstallRecord & { ref?: string }).ref ?? "HEAD";
	try {
		const out = await git(["ls-remote", install.repo, ref], undefined, 20_000);
		const remote = out.split(/\s+/u)[0];
		if (!remote) return { name: skill.name, error: `${ref} not found on remote` };
		return { name: skill.name, remote, outdated: remote !== install.commit };
	} catch (error) {
		return { name: skill.name, error: (error as Error).message };
	}
}

/** Write a new skill into the store from SKILL.md text; returns the skill. */
export function createSkill(localDir: string, name: string, text: string, replace = false): StoreSkill {
	const problem = validateSkill(text, name);
	if (problem) throw new Error(problem);
	const dir = join(localDir, name);
	if (existsSync(join(dir, "SKILL.md")) && !replace) throw new Error(`${name} already exists in the store; pass replace to overwrite SKILL.md`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), text.endsWith("\n") ? text : `${text}\n`);
	const skill = readStoreSkill(dir, "local");
	if (!skill) throw new Error("SKILL.md is not loadable after writing");
	return skill;
}
