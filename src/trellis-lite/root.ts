/**
 * Project root resolution and legacy detection for trellis-lite.
 *
 * A Trellis project is the nearest ancestor of the session cwd that holds a
 * real `.trellis/` directory with at least one of the data entries below.
 * The walk stops at the first directory containing `.git` (after checking it)
 * and never looks at $HOME or above, so a stray `.trellis` higher up cannot
 * capture unrelated work.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DATA_ENTRIES = ["spec", "workspace", "tasks", ".developer"];

function isRealDir(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isTrellisDir(path: string): boolean {
	return isRealDir(path) && DATA_ENTRIES.some((entry) => existsSync(join(path, entry)));
}

/** The project root for `cwd`, or undefined outside a Trellis project. */
export function findProjectRoot(cwd: string, home: string = homedir()): string | undefined {
	const stopAt = resolve(home);
	let dir = resolve(cwd);
	for (;;) {
		if (dir === stopAt) return undefined;
		if (isTrellisDir(join(dir, ".trellis"))) return dir;
		if (existsSync(join(dir, ".git"))) return undefined;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function listNames(dir: string): string[] {
	try {
		return readdirSync(dir).sort();
	} catch {
		return [];
	}
}

/**
 * pi-visible assets of Trellis or mini-trellis that are still installed in the
 * project. While any exists, trellis-lite stays idle so the model never sees
 * two contradicting workflows. Paths are repo-relative.
 */
export function detectLegacy(root: string): string[] {
	const found: string[] = [];
	for (const name of ["trellis", "mini-trellis"]) {
		if (existsSync(join(root, ".pi", "extensions", name))) found.push(`.pi/extensions/${name}/`);
	}
	for (const dir of [".agents/skills", ".pi/skills"]) {
		for (const name of listNames(join(root, dir))) {
			if (name.startsWith("trellis-") || name.startsWith("mini-trellis")) found.push(`${dir}/${name}`);
		}
	}
	for (const name of listNames(join(root, ".pi", "prompts"))) {
		if (/^(mini-)?trellis-.*\.md$/u.test(name)) found.push(`.pi/prompts/${name}`);
	}
	return found;
}

/** `name=` from `.trellis/.developer`, if set. */
export function readDeveloper(root: string): string | undefined {
	try {
		const text = readFileSync(join(root, ".trellis", ".developer"), "utf8");
		for (const line of text.split(/\r?\n/u)) {
			if (line.startsWith("name=")) {
				const name = line.slice("name=".length).trim();
				return name || undefined;
			}
		}
	} catch {
		// no developer file
	}
	return undefined;
}

export const DEFAULT_MAX_JOURNAL_LINES = 2000;

/** `max_journal_lines` from `.trellis/config.yaml` when present, else 2000. */
export function maxJournalLines(root: string): number {
	try {
		const match = readFileSync(join(root, ".trellis", "config.yaml"), "utf8").match(
			/^max_journal_lines:\s*(\d+)\s*(?:#.*)?$/mu,
		);
		const value = match ? Number(match[1]) : Number.NaN;
		if (Number.isInteger(value) && value > 0) return value;
	} catch {
		// no config
	}
	return DEFAULT_MAX_JOURNAL_LINES;
}

export interface JournalInfo {
	/** Repo-relative path of the newest journal file. */
	path: string;
	part: number;
	lines: number;
	/** Highest session number recorded in any journal of this developer. */
	sessions: number;
}

const JOURNAL_FILE = /^journal-(\d+)\.md$/u;
const SESSION_HEADING = /^## Session (\d+)\b/gmu;

export function journalFiles(root: string, developer: string): Array<{ name: string; part: number }> {
	return listNames(join(root, ".trellis", "workspace", developer))
		.map((name) => ({ name, match: name.match(JOURNAL_FILE) }))
		.filter((entry): entry is { name: string; match: RegExpMatchArray } => entry.match !== null)
		.map(({ name, match }) => ({ name, part: Number(match[1]) }))
		.sort((a, b) => a.part - b.part);
}

export function countLines(text: string): number {
	if (text === "") return 0;
	const newlines = text.split("\n").length - 1;
	return text.endsWith("\n") ? newlines : newlines + 1;
}

export function highestSession(text: string): number {
	let highest = 0;
	for (const match of text.matchAll(SESSION_HEADING)) highest = Math.max(highest, Number(match[1]));
	return highest;
}

export function readJournalInfo(root: string, developer: string): JournalInfo | undefined {
	const files = journalFiles(root, developer);
	const newest = files.at(-1);
	if (!newest) return undefined;
	let sessions = 0;
	let lines = 0;
	for (const file of files) {
		let text = "";
		try {
			text = readFileSync(join(root, ".trellis", "workspace", developer, file.name), "utf8");
		} catch {
			continue;
		}
		sessions = Math.max(sessions, highestSession(text));
		if (file === newest) lines = countLines(text);
	}
	return { path: `.trellis/workspace/${developer}/${newest.name}`, part: newest.part, lines, sessions };
}
