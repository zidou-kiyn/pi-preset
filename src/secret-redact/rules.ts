/**
 * Secret detection rules from Betterleaks (vendor/betterleaks-rules, MIT).
 *
 * The rule file is the Gitleaks-compatible TOML Betterleaks generates: one
 * `[[rules]]` table per secret type with a Go RE2 `regex`, lowercase
 * `keywords` that must appear before the regex is tried, an optional
 * `secretGroup`, and a `filter` in CEL that discards false positives. This
 * module reads that file as it is (no generated copy to keep in sync) and
 * turns each rule into a JavaScript RegExp:
 *
 *   - leading `(?i)` / `(?s)` / `(?m)` become flags; a flag group in the
 *     middle (`p8e-(?i)[a-z0-9]{32}`) becomes a `(?i:...)` modifier group
 *     that ends with the enclosing group, reopened after each `|` so the
 *     alternation keeps its meaning;
 *   - `(?P<name>...)` becomes a plain capture group (numbering unchanged);
 *   - `\z` becomes `(?![\s\S])`, `\A` becomes `^`, POSIX classes such as
 *     `[[:alnum:]]` become ranges, and a `]` first in a class is escaped.
 *
 * Of the filter only the parts that need no context are used: the entropy
 * threshold and `matchesAny` / `containsAny` lists on the secret. Token
 * efficiency checks and live validation (`validate`, HTTP requests to the
 * provider) are skipped: a redaction filter must not send candidate secrets
 * anywhere, and a missed filter only means one more redaction.
 *
 * Rules that only find identifiers (client ids, user names, hosts) are
 * dropped; `generic-api-key` and `generic-password`, which guess from a
 * variable name, are marked `named` so the user can turn them on.
 */

import { readFileSync } from "node:fs";

export interface SecretRule {
	id: string;
	/** Global, with indices (`d`), plus the flags the rule asked for. */
	regex: RegExp;
	/** Lowercase; the text must contain one of them (none = always tried). */
	keywords: string[];
	/** Capture group holding the secret; undefined = first non-empty group, else the whole match. */
	secretGroup?: number;
	/** Discard a secret whose Shannon entropy is at or below (`<=`) or below (`<`) this. */
	entropy?: { value: number; inclusive: boolean };
	/** Discard a secret matching any of these. */
	excludePatterns: RegExp[];
	/** Discard a secret containing any of these (lowercase). */
	excludeWords: string[];
	/** A guess from a variable name (`password = ...`), off unless the user turns it on. */
	named: boolean;
}

export interface RuleSet {
	rules: SecretRule[];
	/** The file's global filter, applied to every rule. */
	globalExcludePatterns: RegExp[];
	globalExcludeWords: string[];
	/** Rules left out, with the reason (identifier-only, path-only, does not convert). */
	skipped: { id: string; reason: string }[];
}

// ── TOML (the subset the generated file uses) ───────────────────────────────

type TomlValue = string | number | boolean | string[];
type TomlTable = Record<string, TomlValue>;

function parseBasicString(text: string): string {
	return JSON.parse(text) as string;
}

/** Parse the generated rule file: top-level keys and `[[rules]]` tables. */
export function parseRuleToml(source: string): { top: TomlTable; rules: TomlTable[] } {
	const lines = source.split(/\r?\n/u);
	const top: TomlTable = {};
	const rules: TomlTable[] = [];
	let table: TomlTable = top;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		if (trimmed === "[[rules]]") {
			table = {};
			rules.push(table);
			continue;
		}
		if (trimmed.startsWith("[")) {
			// Another table (none today): its keys are ignored.
			table = {};
			continue;
		}
		const match = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/u.exec(trimmed);
		if (!match) continue;
		const key = match[1]!;
		let rest = match[2]!;
		if (rest.startsWith("'''")) {
			rest = rest.slice(3);
			const close = rest.indexOf("'''");
			if (close >= 0) {
				table[key] = rest.slice(0, close);
				continue;
			}
			const parts = rest === "" ? [] : [rest];
			for (i++; i < lines.length; i++) {
				const next = lines[i]!;
				const end = next.indexOf("'''");
				if (end >= 0) {
					parts.push(next.slice(0, end));
					break;
				}
				parts.push(next);
			}
			table[key] = parts.join("\n");
			continue;
		}
		if (rest.startsWith("[")) {
			let body = rest;
			while (!/\]\s*(#.*)?$/u.test(body) && i + 1 < lines.length) body += `\n${lines[++i]!}`;
			const items: string[] = [];
			for (const item of body.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/gu)) {
				items.push(item[1] !== undefined ? parseBasicString(`"${item[1]}"`) : item[2]!);
			}
			table[key] = items;
			continue;
		}
		if (rest.startsWith('"')) {
			const end = /^"((?:[^"\\]|\\.)*)"/u.exec(rest);
			if (end) table[key] = parseBasicString(`"${end[1]}"`);
			continue;
		}
		if (rest.startsWith("'")) {
			const end = /^'([^']*)'/u.exec(rest);
			if (end) table[key] = end[1]!;
			continue;
		}
		const bare = rest.replace(/\s+#.*$/u, "").trim();
		if (bare === "true" || bare === "false") table[key] = bare === "true";
		else if (/^-?\d+(\.\d+)?$/u.test(bare)) table[key] = Number(bare);
	}
	return { top, rules };
}

// ── Go RE2 → JavaScript ─────────────────────────────────────────────────────

const POSIX_CLASSES: Record<string, string> = {
	alnum: "A-Za-z0-9",
	alpha: "A-Za-z",
	ascii: "\\x00-\\x7F",
	blank: " \\t",
	cntrl: "\\x00-\\x1F\\x7F",
	digit: "0-9",
	graph: "!-~",
	lower: "a-z",
	print: " -~",
	punct: "!-\\/:-@\\[-`{-~",
	space: "\\s",
	upper: "A-Z",
	word: "\\w",
	xdigit: "0-9A-Fa-f",
};

const SUPPORTED_FLAGS = /^[ims]*(-[ims]*)?$/u;

/** A Go RE2 pattern as JavaScript source and flags; throws when it cannot be converted. */
export function convertGoRegex(pattern: string): { source: string; flags: string } {
	let flags = "";
	let rest = pattern;
	for (;;) {
		const lead = /^\(\?([a-zA-Z]+)\)/u.exec(rest);
		if (!lead) break;
		for (const flag of lead[1]!) {
			if (!"ims".includes(flag)) throw new Error(`unsupported flag ${flag}`);
			if (!flags.includes(flag)) flags += flag;
		}
		rest = rest.slice(lead[0].length);
	}
	let out = "";
	// Per open group: inline flag groups opened inside it, to close with it
	// and to reopen after each `|`.
	const stack: string[][] = [[]];
	const closeInline = () => ")".repeat(stack[stack.length - 1]!.length);
	let i = 0;
	while (i < rest.length) {
		const char = rest[i]!;
		if (char === "\\") {
			const next = rest[i + 1];
			if (next === undefined) throw new Error("trailing backslash");
			if (next === "z") out += "(?![\\s\\S])";
			else if (next === "A") out += "^";
			else if (next === "Q" || next === "E" || next === "C") throw new Error(`unsupported escape \\${next}`);
			else if (next === "p" || next === "P") throw new Error("unicode classes need the u flag");
			else out += `\\${next}`;
			i += 2;
			continue;
		}
		if (char === "[") {
			let j = i + 1;
			let cls = "[";
			if (rest[j] === "^") {
				cls += "^";
				j++;
			}
			if (rest[j] === "]") {
				cls += "\\]";
				j++;
			}
			for (; j < rest.length && rest[j] !== "]"; j++) {
				if (rest[j] === "\\") {
					const next = rest[j + 1];
					if (next === "p" || next === "P" || next === "Q") throw new Error(`unsupported escape \\${next}`);
					cls += `\\${next}`;
					j++;
					continue;
				}
				const posix = /^\[:(\^?)([a-z]+):\]/u.exec(rest.slice(j));
				if (posix) {
					const ranges = POSIX_CLASSES[posix[2]!];
					if (!ranges || posix[1]) throw new Error(`unsupported class ${posix[0]}`);
					cls += ranges;
					j += posix[0].length - 1;
					continue;
				}
				if (rest[j] === "[") cls += "\\[";
				else cls += rest[j];
			}
			if (j >= rest.length) throw new Error("unterminated class");
			out += `${cls}]`;
			i = j + 1;
			continue;
		}
		if (char === "(") {
			const named = /^\(\?P?<[A-Za-z_][A-Za-z0-9_]*>/u.exec(rest.slice(i));
			if (named) {
				out += "(";
				stack.push([]);
				i += named[0].length;
				continue;
			}
			const inline = /^\(\?([a-zA-Z-]+)\)/u.exec(rest.slice(i));
			if (inline) {
				if (!SUPPORTED_FLAGS.test(inline[1]!)) throw new Error(`unsupported flags ${inline[1]}`);
				out += `(?${inline[1]}:`;
				stack[stack.length - 1]!.push(inline[1]!);
				i += inline[0].length;
				continue;
			}
			const modifier = /^\(\?([a-zA-Z-]+):/u.exec(rest.slice(i));
			if (modifier && !SUPPORTED_FLAGS.test(modifier[1]!)) throw new Error(`unsupported flags ${modifier[1]}`);
			if (rest.startsWith("(?", i) && !modifier && !rest.startsWith("(?:", i)) throw new Error("unsupported group");
			out += "(";
			stack.push([]);
			i++;
			continue;
		}
		if (char === ")") {
			if (stack.length === 1) throw new Error("unbalanced )");
			out += closeInline();
			stack.pop();
			out += ")";
			i++;
			continue;
		}
		if (char === "|") {
			const open = stack[stack.length - 1]!;
			out += `${closeInline()}|${open.map((group) => `(?${group}:`).join("")}`;
			i++;
			continue;
		}
		out += char;
		i++;
	}
	if (stack.length !== 1) throw new Error("unbalanced (");
	out += closeInline();
	return { source: out, flags };
}

/** Compile a converted pattern; `extra` adds flags such as `gd`. */
export function compileGoRegex(pattern: string, extra = ""): RegExp {
	const { source, flags } = convertGoRegex(pattern);
	return new RegExp(source, `${flags}${extra}`);
}

// ── filters ─────────────────────────────────────────────────────────────────

/** `matchesAny(finding["secret"], [...])` and `containsAny(...)` lists in a CEL filter. */
function secretLists(filter: string): { patterns: string[]; words: string[] } {
	const patterns: string[] = [];
	const words: string[] = [];
	const call = /(matchesAny|containsAny)\(\s*finding\["secret"\]\s*,\s*\[/gu;
	for (let found = call.exec(filter); found; found = call.exec(filter)) {
		// The list runs to the matching `]`; items are `...` or "..." strings.
		let depth = 1;
		let j = found.index + found[0].length;
		const start = j;
		let quote: string | undefined;
		for (; j < filter.length && depth > 0; j++) {
			const c = filter[j]!;
			if (quote) {
				if (c === "\\" && quote === '"') j++;
				else if (c === quote) quote = undefined;
			} else if (c === "`" || c === '"') quote = c;
			else if (c === "[") depth++;
			else if (c === "]") depth--;
		}
		const body = filter.slice(start, j - 1);
		for (const item of body.matchAll(/`([^`]*)`|"((?:[^"\\]|\\.)*)"/gu)) {
			const value = item[1] ?? parseBasicString(`"${item[2]}"`);
			if (found[1] === "matchesAny") patterns.push(value);
			else words.push(value.toLowerCase());
		}
	}
	return { patterns, words };
}

function entropyThreshold(filter: string): SecretRule["entropy"] {
	const found = /(?:^|[\s(|])(?:filter\.)?entropy\(finding\["secret"\]\)\s*(<=|<)\s*(\d+(?:\.\d+)?)/u.exec(filter);
	if (!found) return undefined;
	return { value: Number(found[2]), inclusive: found[1] === "<=" };
}

function compileAll(patterns: string[]): RegExp[] {
	const out: RegExp[] = [];
	for (const pattern of patterns) {
		try {
			out.push(compileGoRegex(pattern));
		} catch {
			// A filter pattern that does not convert only filters less.
		}
	}
	return out;
}

// ── rule selection ──────────────────────────────────────────────────────────

/** Rules that guess from a name: on only when the user asks. */
const NAMED_RULES = new Set(["generic-api-key", "generic-password"]);
/** Composite parts (`skipReport`) that are secrets on their own. */
const SECRET_PART = /secret|token|passphrase|password|private/u;

/** Turn the parsed tables into rules. */
export function buildRuleSet(parsed: { top: TomlTable; rules: TomlTable[] }): RuleSet {
	const globalLists = secretLists(String(parsed.top.filter ?? ""));
	const set: RuleSet = {
		rules: [],
		globalExcludePatterns: compileAll(globalLists.patterns),
		globalExcludeWords: globalLists.words,
		skipped: [],
	};
	for (const table of parsed.rules) {
		const id = String(table.id ?? "");
		if (!id) continue;
		if (typeof table.regex !== "string") {
			set.skipped.push({ id, reason: "path-only" });
			continue;
		}
		if (typeof table.path === "string") {
			set.skipped.push({ id, reason: "applies to file paths only" });
			continue;
		}
		if (table.skipReport === true && !SECRET_PART.test(id)) {
			set.skipped.push({ id, reason: "identifier, not a secret" });
			continue;
		}
		if (id === "generic-username") {
			set.skipped.push({ id, reason: "identifier, not a secret" });
			continue;
		}
		let regex: RegExp;
		try {
			regex = compileGoRegex(table.regex, "gd");
		} catch (error) {
			set.skipped.push({ id, reason: `does not convert: ${(error as Error).message}` });
			continue;
		}
		const filter = typeof table.filter === "string" ? table.filter : "";
		const lists = secretLists(filter);
		set.rules.push({
			id,
			regex,
			keywords: Array.isArray(table.keywords) ? table.keywords.map((word) => word.toLowerCase()) : [],
			secretGroup: typeof table.secretGroup === "number" ? table.secretGroup : undefined,
			entropy: entropyThreshold(filter),
			excludePatterns: compileAll(lists.patterns),
			excludeWords: lists.words,
			named: NAMED_RULES.has(id),
		});
	}
	return set;
}

export function loadRuleSet(path: string): RuleSet {
	return buildRuleSet(parseRuleToml(readFileSync(path, "utf8")));
}
