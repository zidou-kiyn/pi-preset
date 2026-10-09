/**
 * The standing `project-memory` system prompt section.
 *
 * Paths and counts only, never file bodies. Computed once per extension
 * instance (= once per session runtime) and written back byte-for-byte on
 * every turn, so the prompt prefix never changes inside a session.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { maxJournalLines, readDeveloper, readJournalInfo } from "./root.ts";

export const SECTION_NAME = "project-memory";

export const LIMITS = {
	specIndexes: 10,
	tasks: 5,
	research: 6,
	totalChars: 1500,
} as const;

const TASK_FILES = ["prd", "design", "implement"] as const;

function entries(dir: string): Array<{ name: string; dir: boolean }> {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => !entry.name.startsWith("."))
			.map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	} catch {
		return [];
	}
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** `spec/index.md`, then `spec/<layer>/index.md`, then `spec/<pkg>/<layer>/index.md`. */
export function specIndexes(root: string): string[] {
	const specDir = join(root, ".trellis", "spec");
	const found: string[] = [];
	if (isFile(join(specDir, "index.md"))) found.push(".trellis/spec/index.md");
	const nested: string[] = [];
	for (const first of entries(specDir).filter((entry) => entry.dir)) {
		if (isFile(join(specDir, first.name, "index.md"))) found.push(`.trellis/spec/${first.name}/index.md`);
		for (const second of entries(join(specDir, first.name)).filter((entry) => entry.dir)) {
			if (isFile(join(specDir, first.name, second.name, "index.md"))) {
				nested.push(`.trellis/spec/${first.name}/${second.name}/index.md`);
			}
		}
	}
	return [...found, ...nested];
}

/** Open task directories (everything under tasks/ except archive/), newest name first. */
export function openTasks(root: string): Array<{ path: string; files: string[] }> {
	const tasksDir = join(root, ".trellis", "tasks");
	return entries(tasksDir)
		.filter((entry) => entry.dir && entry.name !== "archive")
		.reverse()
		.map((entry) => ({
			path: `.trellis/tasks/${entry.name}/`,
			files: TASK_FILES.filter((name) => isFile(join(tasksDir, entry.name, `${name}.md`))),
		}));
}

/** Top-level research notes; undefined when there is no research directory. */
export function researchTopics(root: string): string[] | undefined {
	const dir = join(root, ".trellis", "research");
	try {
		if (!statSync(dir).isDirectory()) return undefined;
	} catch {
		return undefined;
	}
	return entries(dir)
		.filter((entry) => entry.name !== "archive" && entry.name.toLowerCase() !== "readme.md")
		.filter((entry) => entry.dir || entry.name.endsWith(".md"))
		.map((entry) => (entry.dir ? `${entry.name}/` : entry.name));
}

function capped(items: string[], limit: number): string {
	const shown = items.slice(0, limit).join(", ");
	return items.length > limit ? `${shown} (+${items.length - limit} more)` : shown;
}

export interface SnapshotOptions {
	/** Whether path-scoped spec injection is on (adds one line). */
	specInjection: boolean;
}

/** Build the section body (pi wraps it in `<project-memory>` tags). */
export function buildSnapshot(root: string, options: SnapshotOptions): string {
	const specs = specIndexes(root);
	const tasks = openTasks(root);
	const research = researchTopics(root);
	const developer = readDeveloper(root);

	let journalLine: string;
	if (!developer) {
		journalLine = "- Journal: no developer set in .trellis/.developer (the user can run /trellis-lite init)";
	} else {
		const info = readJournalInfo(root, developer);
		journalLine = info
			? `- Journal: ${info.path} (${info.sessions} sessions, ${info.lines}/${maxJournalLines(root)} lines)`
			: `- Journal: none yet; the first entry creates .trellis/workspace/${developer}/journal-1.md`;
	}

	const specLine = (full: boolean) =>
		specs.length === 0
			? "- Spec: none yet under .trellis/spec/"
			: full
				? `- Spec indexes (read the one for the area you change before editing code there): ${capped(specs, LIMITS.specIndexes)}`
				: `- Spec indexes: ${specs.length} under .trellis/spec/ (read the one for the area you change before editing code there)`;
	const taskLine = (full: boolean) =>
		tasks.length === 0
			? "- Open tasks: none"
			: full
				? `- Open tasks: ${capped(
						tasks.map((task) => (task.files.length ? `${task.path} (${task.files.join(", ")})` : task.path)),
						LIMITS.tasks,
					)}`
				: `- Open tasks: ${tasks.length} under .trellis/tasks/`;
	const researchLine = (full: boolean) =>
		research === undefined
			? undefined
			: research.length === 0
				? "- Research notes: none yet in .trellis/research/"
				: full
					? `- Research notes in .trellis/research/: ${capped(research, LIMITS.research)}`
					: `- Research notes: ${research.length} in .trellis/research/`;

	const render = (fullSpecs: boolean, fullTasks: boolean, fullResearch: boolean) =>
		[
			"This project keeps durable memory in .trellis/. Read files there when they are relevant; do not load them all up front.",
			specLine(fullSpecs),
			journalLine,
			taskLine(fullTasks),
			researchLine(fullResearch),
			options.specInjection
				? "Specs whose frontmatter `paths:` match a file you read or edit are attached to that tool result."
				: undefined,
		]
			.filter((line): line is string => line !== undefined)
			.join("\n");

	// Degrade the longest lists to counts until the section fits.
	for (const variant of [
		[true, true, true],
		[true, true, false],
		[true, false, false],
		[false, false, false],
	] as const) {
		const text = render(...variant);
		if (text.length <= LIMITS.totalChars || variant[0] === false) return text;
	}
	return render(false, false, false);
}
