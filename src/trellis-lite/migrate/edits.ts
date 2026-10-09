/**
 * Exact edits to files shared between Trellis and the project: only the
 * Trellis-owned parts are removed, everything else stays byte for byte
 * (AGENTS.md, .gitignore files) or key for key (.pi/settings.json).
 */

export type EditOutcome =
	| { kind: "unchanged" }
	| { kind: "edit"; text: string; removed: string[] }
	| { kind: "delete"; removed: string[] }
	| { kind: "review"; reason: string };

const START = "<!-- TRELLIS:START -->";
const END = "<!-- TRELLIS:END -->";

function count(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

/** Remove the managed TRELLIS:START..END block from AGENTS.md. */
export function removeManagedBlock(text: string): EditOutcome {
	const starts = count(text, START);
	const ends = count(text, END);
	if (starts === 0 && ends === 0) return { kind: "unchanged" };
	if (starts !== 1 || ends !== 1) return { kind: "review", reason: "TRELLIS:START/END markers are not a single pair" };
	const startMarker = text.indexOf(START);
	const endMarker = text.indexOf(END);
	if (endMarker < startMarker) return { kind: "review", reason: "TRELLIS:END comes before TRELLIS:START" };

	const from = text.lastIndexOf("\n", startMarker - 1) + 1;
	if (text.slice(from, startMarker).trim() !== "") return { kind: "review", reason: "TRELLIS:START is not on its own line" };
	let to = text.indexOf("\n", endMarker);
	to = to < 0 ? text.length : to + 1;
	if (text.slice(endMarker + END.length, to).trim() !== "") return { kind: "review", reason: "TRELLIS:END is not on its own line" };
	// One blank line that only separated the block from what follows goes with it.
	const blank = text.slice(to).match(/^[ \t]*\r?\n/u);
	if (blank) to += blank[0].length;

	const removed = text.slice(from, to).replace(/\n$/u, "").split("\n");
	const next = text.slice(0, from) + text.slice(to);
	if (next.trim() === "") return { kind: "delete", removed };
	return { kind: "edit", text: next, removed };
}

const TRELLIS_EXTENSION = /(^|\/)extensions\/(mini-)?trellis(\/|$)/u;
const PROMPTS_DIR = /^(\.\/)?prompts\/?$/u;
const TRELLIS_RESOURCE = /(^|\/)(mini-)?trellis-[^/]*$/u;

function filterResources(value: unknown, drop: (entry: string) => boolean, removed: string[], key: string): unknown {
	if (!Array.isArray(value)) return value;
	return value.filter((entry) => {
		const source = typeof entry === "string" ? entry : undefined;
		if (source !== undefined && drop(source)) {
			removed.push(`${key}: ${source}`);
			return false;
		}
		return true;
	});
}

/**
 * Drop Trellis entries from a project `.pi/settings.json`: extension entries
 * under extensions/trellis/ (or mini-trellis/), the `./prompts` entry (pi
 * discovers `.pi/prompts/` by itself), and trellis-* skills or prompts.
 * Empty arrays are removed; a file left with nothing but pi defaults is deleted.
 */
export function cleanPiSettings(text: string): EditOutcome {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return { kind: "review", reason: "not plain JSON" };
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) return { kind: "review", reason: "not a JSON object" };
	const removed: string[] = [];
	const next: Record<string, unknown> = { ...(data as Record<string, unknown>) };
	const rules: Record<string, (entry: string) => boolean> = {
		extensions: (entry) => TRELLIS_EXTENSION.test(entry),
		prompts: (entry) => PROMPTS_DIR.test(entry) || TRELLIS_RESOURCE.test(entry.replace(/\.md$/u, "")),
		skills: (entry) => TRELLIS_RESOURCE.test(entry.replace(/\/SKILL\.md$/u, "")),
	};
	for (const [key, drop] of Object.entries(rules)) {
		if (!(key in next)) continue;
		const filtered = filterResources(next[key], drop, removed, key);
		if (Array.isArray(filtered) && filtered.length === 0 && Array.isArray(next[key]) && (next[key] as unknown[]).length > 0) {
			delete next[key];
		} else {
			next[key] = filtered;
		}
	}
	if (removed.length === 0) return { kind: "unchanged" };
	const keys = Object.keys(next);
	if (keys.length === 0 || (keys.length === 1 && next.enableSkillCommands === true)) {
		return { kind: "delete", removed };
	}
	return { kind: "edit", text: `${JSON.stringify(next, null, 2)}\n`, removed };
}

/** Runtime patterns Trellis writes into .trellis/.gitignore (facts, not prose). */
export const TRELLIS_IGNORE_PATTERNS = [
	".current-task",
	".runtime/",
	".ralph-state.json",
	".agents/",
	".agent-log",
	".session-id",
	".plan-log",
	"*.tmp",
	".backup-*",
	"*.new",
	"**/__pycache__/",
	"**/*.pyc",
	".version",
	".template-hashes.json",
];

function removeLines(text: string, isTrellisLine: (line: string) => boolean): EditOutcome {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/u);
	const drop = new Set<number>();
	lines.forEach((line, index) => {
		if (!isTrellisLine(line.trim())) return;
		drop.add(index);
		// The comment lines directly above a removed rule describe it.
		for (let up = index - 1; up >= 0 && (lines[up] ?? "").trim().startsWith("#"); up--) drop.add(up);
	});
	if (drop.size === 0) return { kind: "unchanged" };
	const removed = [...drop].sort((a, b) => a - b).map((index) => lines[index] ?? "");
	const kept: string[] = [];
	for (const [index, line] of lines.entries()) {
		if (drop.has(index)) continue;
		if (line.trim() === "" && (kept.length === 0 || kept.at(-1)?.trim() === "")) continue;
		kept.push(line);
	}
	while (kept.length > 0 && kept.at(-1)?.trim() === "") kept.pop();
	if (kept.every((line) => line.trim() === "" || line.trim().startsWith("#"))) return { kind: "delete", removed };
	return { kind: "edit", text: kept.join(eol) + eol, removed };
}

/** `.trellis/.gitignore`: drop Trellis runtime rules, keep `.developer` and anything else. */
export function cleanTrellisGitignore(text: string): EditOutcome {
	const known = new Set(TRELLIS_IGNORE_PATTERNS);
	return removeLines(text, (line) => known.has(line.replace(/^\//u, "")));
}

/** Root `.gitignore`: drop only `.trellis/<runtime rule>` lines. */
export function cleanRootGitignore(text: string): EditOutcome {
	const known = new Set(TRELLIS_IGNORE_PATTERNS);
	return removeLines(text, (line) => {
		const match = line.match(/^\/?\.trellis\/(.+)$/u);
		return match !== null && known.has(match[1] ?? "");
	});
}
