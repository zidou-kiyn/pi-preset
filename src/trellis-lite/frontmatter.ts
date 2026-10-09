/**
 * Spec frontmatter: the optional `---` block at the top of a spec file.
 *
 * Recognized keys: `paths` (a list of globs, block or `[a, b]` form),
 * `description`, `name`. Everything else is ignored, so a spec can carry
 * other metadata. A leading `---` followed by no recognized key is a
 * Markdown rule, not frontmatter. Two cases are errors, because routing on
 * them would be guesswork: `paths` given as a single scalar, and a block that
 * never closes within the bounded head.
 */

export const HEAD_MAX_BYTES = 16 * 1024;
export const HEAD_MAX_LINES = 200;

export interface Frontmatter {
	paths?: string[];
	description?: string;
	name?: string;
	/** Character offset where the body starts (after the closing `---` line). */
	bodyStart: number;
}

const KNOWN = new Set(["paths", "description", "name"]);
const KEY_LINE = /^([A-Za-z_][\w-]*)\s*:(.*)$/u;
const BLOCK_SCALAR = /^[|>][+-]?$/u;

function stripComment(value: string): string {
	let quote: string | undefined;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (quote) {
			if (ch === quote) quote = undefined;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === "#" && (i === 0 || /\s/u.test(value[i - 1] ?? ""))) {
			return value.slice(0, i);
		}
	}
	return value;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0]) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function scalar(raw: string): string {
	return unquote(stripComment(raw));
}

/**
 * Parse the frontmatter at the start of `text`. Returns undefined when there
 * is none; throws Error for the two malformed cases described above.
 */
export function parseFrontmatter(text: string): Frontmatter | undefined {
	const head = text.startsWith("\uFEFF") ? text.slice(1) : text;
	const offsetBase = text.length - head.length;
	const lines = head.split("\n");
	if ((lines[0] ?? "").replace(/\r$/u, "").trimEnd() !== "---") return undefined;

	const result: Frontmatter = { bodyStart: 0 };
	let sawKnown = false;
	let listKey: string | undefined;
	let blockIndent: number | undefined;
	let offset = (lines[0] ?? "").length + 1;
	const limit = Math.min(lines.length, HEAD_MAX_LINES);

	for (let i = 1; i < limit; i++) {
		const line = (lines[i] ?? "").replace(/\r$/u, "");
		const lineLength = (lines[i] ?? "").length + 1;
		if (offset > HEAD_MAX_BYTES) break;
		const trimmed = line.trim();
		const indent = line.length - line.trimStart().length;

		if (blockIndent !== undefined) {
			if (trimmed === "" || indent > blockIndent) {
				offset += lineLength;
				continue;
			}
			blockIndent = undefined;
		}

		if (trimmed === "---" && indent === 0) {
			if (!sawKnown) return undefined;
			result.bodyStart = offsetBase + offset + lineLength;
			return result;
		}
		offset += lineLength;
		if (trimmed === "" || trimmed.startsWith("#")) continue;

		if (trimmed === "-" || trimmed.startsWith("- ")) {
			if (listKey === "paths") {
				const item = scalar(trimmed.slice(1));
				if (item) result.paths?.push(item);
			}
			continue;
		}

		const match = trimmed.match(KEY_LINE);
		if (!match) continue;
		const key = match[1] ?? "";
		const raw = (match[2] ?? "").trim();
		if (KNOWN.has(key)) sawKnown = true;
		listKey = undefined;

		if (BLOCK_SCALAR.test(stripComment(raw).trim())) {
			if (key === "paths") throw new Error("`paths` must be a list of globs");
			blockIndent = indent;
			continue;
		}
		const value = stripComment(raw).trim();
		if (key === "paths") {
			if (value === "") {
				result.paths = [];
				listKey = "paths";
			} else if (value.startsWith("[") && value.endsWith("]")) {
				result.paths = value
					.slice(1, -1)
					.split(",")
					.map((item) => unquote(item))
					.filter(Boolean);
			} else {
				throw new Error("`paths` must be a list of globs");
			}
		} else if (key === "description" || key === "name") {
			const text = unquote(value);
			if (text) result[key] = text;
		}
	}

	if (!sawKnown) return undefined;
	throw new Error(`frontmatter is not closed within ${HEAD_MAX_LINES} lines / ${HEAD_MAX_BYTES} bytes`);
}
