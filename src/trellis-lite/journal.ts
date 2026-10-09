/**
 * Journal entries in `.trellis/workspace/<developer>/journal-N.md`.
 *
 * File format (compatible with existing Trellis journals): a header per file,
 * then one `## Session N: <title>` section per entry with Date / Task / Branch
 * lines, a Summary, a Git Commits table, and a Status. Session numbers run on
 * across files. A file is full when the new entry would take it past
 * `max_journal_lines` (default 2000); the entry then starts `journal-(N+1).md`.
 * When the developer's `index.md` has the auto-maintained marker blocks, they
 * are refreshed; without markers it is left alone. Nothing is committed.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countLines, highestSession, journalFiles, maxJournalLines, readDeveloper } from "./root.ts";

export interface JournalInput {
	title: string;
	summary: string;
	commits?: string[];
	task?: string;
	status?: string;
}

export interface Git {
	branch(): string | undefined;
	subject(hash: string): string | undefined;
}

export function realGit(cwd: string): Git {
	const run = (args: string[]) => {
		try {
			return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
		} catch {
			return undefined;
		}
	};
	return {
		// symbolic-ref also works before the first commit; detached HEAD has no branch.
		branch: () => run(["symbolic-ref", "--short", "-q", "HEAD"]),
		subject: (hash) => run(["log", "-1", "--format=%s", hash]),
	};
}

export interface JournalResult {
	path: string;
	session: number;
	newFile: boolean;
	indexUpdated: boolean;
}

export function journalHeader(developer: string, part: number, date: string): string {
	return `# Journal - ${developer} (Part ${part})\n\n> AI development session journal\n> Started: ${date}\n\n---\n`;
}

const cell = (text: string) => text.replace(/\|/gu, "\\|").replace(/\s*\n\s*/gu, " ").trim();

export function formatEntry(session: number, input: JournalInput, date: string, branch: string | undefined, git: Git): string {
	const commits = (input.commits ?? []).filter(Boolean);
	const status = input.status?.trim() || "Completed";
	const lines = [
		`## Session ${session}: ${cell(input.title)}`,
		"",
		`**Date**: ${date}`,
		`**Task**: ${cell(input.task || input.title)}`,
		`**Branch**: ${branch ? `\`${branch}\`` : "-"}`,
		"",
		"### Summary",
		"",
		input.summary.trim(),
		"",
		"### Git Commits",
		"",
	];
	if (commits.length === 0) {
		lines.push("(No commits)");
	} else {
		lines.push("| Hash | Message |", "|------|---------|");
		for (const hash of commits) lines.push(`| \`${hash}\` | ${cell(git.subject(hash) ?? "(see git log)")} |`);
	}
	lines.push("", "### Status", "", /^completed?$/iu.test(status) ? "[OK] **Completed**" : `**${cell(status)}**`);
	return lines.join("\n");
}

function replaceBlock(text: string, name: string, body: string): string | undefined {
	const start = `<!-- @@@auto:${name} -->`;
	const end = `<!-- @@@/auto:${name} -->`;
	const from = text.indexOf(start);
	const to = text.indexOf(end);
	if (from < 0 || to < from) return undefined;
	return `${text.slice(0, from + start.length)}\n${body}\n${text.slice(to)}`;
}

/** Refresh the marker blocks of a developer index.md; undefined when it has none. */
export function updateIndex(
	text: string,
	info: { file: string; sessions: number; date: string; files: Array<{ name: string; lines: number }>; row: string },
): string | undefined {
	let next: string | undefined = text;
	let touched = false;
	const status = replaceBlock(
		next,
		"current-status",
		`- **Active File**: \`${info.file}\`\n- **Total Sessions**: ${info.sessions}\n- **Last Active**: ${info.date}`,
	);
	if (status !== undefined) {
		next = status;
		touched = true;
	}
	const documents = replaceBlock(
		next,
		"active-documents",
		[
			"| File | Lines | Status |",
			"|------|-------|--------|",
			...info.files.map((file) => `| \`${file.name}\` | ~${file.lines} | ${file.name === info.file ? "Active" : "Archived"} |`),
		].join("\n"),
	);
	if (documents !== undefined) {
		next = documents;
		touched = true;
	}
	const startMarker = "<!-- @@@auto:session-history -->";
	const from = next.indexOf(startMarker);
	const to = next.indexOf("<!-- @@@/auto:session-history -->");
	if (from >= 0 && to > from) {
		const inner = next.slice(from + startMarker.length, to).split("\n");
		const separator = inner.findIndex((line) => /^\|[-| ]+\|$/u.test(line.trim()));
		if (separator >= 0) {
			inner.splice(separator + 1, 0, info.row);
		} else {
			const header = ["| # | Date | Title | Commits | Branch |", "|---|------|-------|---------|--------|", info.row];
			inner.splice(1, 0, ...header);
		}
		next = `${next.slice(0, from + startMarker.length)}${inner.join("\n")}${next.slice(to)}`;
		touched = true;
	}
	return touched ? next : undefined;
}

export function appendJournal(root: string, input: JournalInput, git: Git, date: string): JournalResult {
	const developer = readDeveloper(root);
	if (!developer) throw new Error("No developer in .trellis/.developer; run /trellis-lite init first.");
	if (!input.title.trim()) throw new Error("A title is required.");
	if (!input.summary.trim()) throw new Error("A summary is required (on stdin).");

	const dir = join(root, ".trellis", "workspace", developer);
	mkdirSync(dir, { recursive: true });
	const files = journalFiles(root, developer);
	let sessions = 0;
	const contents = new Map<string, string>();
	for (const file of files) {
		const text = readFileSync(join(dir, file.name), "utf8");
		contents.set(file.name, text);
		sessions = Math.max(sessions, highestSession(text));
	}
	const session = sessions + 1;
	const branch = git.branch();
	const entry = formatEntry(session, input, date, branch, git);

	const newest = files.at(-1);
	let name: string;
	let text: string;
	let newFile = false;
	const current = newest ? (contents.get(newest.name) ?? "") : undefined;
	const addition = (base: string) => `${base.endsWith("\n") ? base : `${base}\n`}\n\n${entry}\n`;
	if (newest && current !== undefined && countLines(addition(current)) <= maxJournalLines(root)) {
		name = newest.name;
		text = addition(current);
	} else {
		const part = (newest?.part ?? 0) + 1;
		name = `journal-${part}.md`;
		text = addition(journalHeader(developer, part, date));
		newFile = true;
	}
	writeFileSync(join(dir, name), text);
	contents.set(name, text);

	let indexUpdated = false;
	const indexPath = join(dir, "index.md");
	if (existsSync(indexPath)) {
		const commits = (input.commits ?? []).filter(Boolean);
		const row = `| ${session} | ${date} | ${cell(input.title)} | ${commits.length ? commits.map((hash) => `\`${hash}\``).join(", ") : "-"} | ${branch ? `\`${branch}\`` : "-"} |`;
		const updated = updateIndex(readFileSync(indexPath, "utf8"), {
			file: name,
			sessions: session,
			date,
			files: journalFiles(root, developer).map((file) => ({ name: file.name, lines: countLines(contents.get(file.name) ?? "") })),
			row,
		});
		if (updated !== undefined) {
			writeFileSync(indexPath, updated);
			indexUpdated = true;
		}
	}
	return { path: `.trellis/workspace/${developer}/${name}`, session, newFile, indexUpdated };
}

export function today(now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
