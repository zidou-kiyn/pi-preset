/**
 * Find secrets in a text: the Betterleaks rules (rules.ts) and known values
 * (known.ts). Returns spans; redactor.ts replaces them.
 *
 * Every rule is tried only when one of its keywords occurs in the text, as
 * in Gitleaks, so a typical tool result runs a handful of the ~420 regexes.
 * JavaScript regexes backtrack where Go's RE2 does not, so a rule that takes
 * longer than SLOW_RULE_MS on one text is switched off for the rest of the
 * session instead of stalling every later result.
 */

import type { RuleSet, SecretRule } from "./rules.ts";

export interface Span {
	start: number;
	end: number;
	/** Rule id, or the known value's label. */
	label: string;
}

export interface KnownValue {
	value: string;
	/** Where it came from, e.g. `env-OPENAI_API_KEY`. */
	label: string;
}

export interface DetectOptions {
	/** Use the rules that guess from a variable name (generic-api-key, generic-password). */
	named: boolean;
}

export const SLOW_RULE_MS = 250;
/** Secrets shorter than this are never reported. */
export const MIN_SECRET_LENGTH = 8;

/** Shannon entropy in bits per character, as Gitleaks computes it. */
export function shannonEntropy(text: string): number {
	if (!text) return 0;
	const counts = new Map<string, number>();
	for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
	const length = [...text].length;
	let entropy = 0;
	for (const count of counts.values()) {
		const p = count / length;
		entropy -= p * Math.log2(p);
	}
	return entropy;
}

function discarded(secret: string, rule: SecretRule, set: RuleSet): boolean {
	if (secret.length < MIN_SECRET_LENGTH) return true;
	if (rule.entropy) {
		const entropy = shannonEntropy(secret);
		if (rule.entropy.inclusive ? entropy <= rule.entropy.value : entropy < rule.entropy.value) return true;
	}
	const lower = secret.toLowerCase();
	for (const word of rule.excludeWords) if (lower.includes(word)) return true;
	for (const word of set.globalExcludeWords) if (lower.includes(word)) return true;
	for (const pattern of rule.excludePatterns) if (pattern.test(secret)) return true;
	for (const pattern of set.globalExcludePatterns) if (pattern.test(secret)) return true;
	return false;
}

function secretRange(match: RegExpExecArray, rule: SecretRule): [number, number] | undefined {
	const indices = match.indices;
	if (!indices) return undefined;
	if (rule.secretGroup !== undefined) return indices[rule.secretGroup] ?? undefined;
	for (let group = 1; group < match.length; group++) {
		if (match[group]) return indices[group];
	}
	return indices[0];
}

export class Detector {
	readonly set: RuleSet;
	/** Rules switched off this session because they were too slow. */
	readonly slow = new Set<string>();

	constructor(set: RuleSet) {
		this.set = set;
	}

	/** Rule matches in `text`. */
	ruleSpans(text: string, options: DetectOptions): Span[] {
		const lower = text.toLowerCase();
		const spans: Span[] = [];
		for (const rule of this.set.rules) {
			if (rule.named && !options.named) continue;
			if (this.slow.has(rule.id)) continue;
			if (rule.keywords.length > 0 && !rule.keywords.some((word) => lower.includes(word))) continue;
			const started = performance.now();
			const regex = rule.regex;
			regex.lastIndex = 0;
			for (let match = regex.exec(text); match; match = regex.exec(text)) {
				if (match[0] === "") {
					regex.lastIndex++;
					continue;
				}
				const range = secretRange(match, rule);
				if (!range) continue;
				const secret = text.slice(range[0], range[1]);
				if (discarded(secret, rule, this.set)) continue;
				spans.push({ start: range[0], end: range[1], label: rule.id });
			}
			if (performance.now() - started > SLOW_RULE_MS) this.slow.add(rule.id);
		}
		return spans;
	}
}

/** Exact occurrences of known values (longest first wins on overlap). */
export function knownSpans(text: string, known: readonly KnownValue[]): Span[] {
	const spans: Span[] = [];
	for (const { value, label } of known) {
		if (value.length < MIN_SECRET_LENGTH) continue;
		for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + value.length)) {
			spans.push({ start: at, end: at + value.length, label });
		}
	}
	return spans;
}

/**
 * Non-overlapping spans, in order. Of overlapping spans the one starting
 * first wins and grows to cover the others, so no piece of either stays.
 */
export function mergeSpans(spans: Span[]): Span[] {
	const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
	const out: Span[] = [];
	for (const span of sorted) {
		const last = out[out.length - 1];
		if (last && span.start < last.end) {
			if (span.end > last.end) last.end = span.end;
			continue;
		}
		out.push({ ...span });
	}
	return out;
}
