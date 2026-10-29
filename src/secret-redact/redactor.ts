/**
 * Replace secrets with placeholders and put them back where it is safe.
 *
 * A secret becomes `[REDACTED:<kind>-<n>]` (`[REDACTED:github-pat-1]`,
 * `[REDACTED:env-OPENAI_API_KEY-1]`). The same value always gets the same
 * placeholder in this pi process, so the agent can tell secrets apart and
 * see where one value recurs. The values live only in memory here; the
 * transcript and the provider see placeholders.
 *
 * `restore` turns placeholders back into values for the file tools (write,
 * edit, apply_patch), so editing a file that holds a secret does not replace
 * it with the placeholder text. Commands and remote tools never get values
 * back (the extension blocks them instead): a command could send the value
 * anywhere.
 */

import { type Detector, type KnownValue, knownSpans, mergeSpans, type Span } from "./detect.ts";

export const PLACEHOLDER = /\[REDACTED:[A-Za-z0-9_.:@-]{1,100}\]/gu;
const MAX_ENTRIES = 20_000;

export interface Registry {
	bySecret: Map<string, string>;
	byPlaceholder: Map<string, string>;
	counters: Map<string, number>;
	/** Replacements made this process, per kind. */
	hits: Map<string, number>;
}

/** One registry per pi process, kept across /reload so earlier placeholders still restore. */
export function processRegistry(): Registry {
	const key = Symbol.for("pi-preset.secret-redact.registry");
	const store = globalThis as unknown as Record<symbol, Registry | undefined>;
	store[key] ??= { bySecret: new Map(), byPlaceholder: new Map(), counters: new Map(), hits: new Map() };
	return store[key]!;
}

export function newRegistry(): Registry {
	return { bySecret: new Map(), byPlaceholder: new Map(), counters: new Map(), hits: new Map() };
}

/** `abuseipdb-api-key.1` → `abuseipdb-api-key`; anything odd → `-`. */
export function kindOf(label: string): string {
	const base = label.replace(/\.\d+$/u, "").replace(/[^A-Za-z0-9_.:@-]+/gu, "-").replace(/^-+|-+$/gu, "");
	return (base || "secret").slice(0, 80);
}

export interface RedactOptions {
	named: boolean;
	known: readonly KnownValue[];
}

export class Redactor {
	readonly registry: Registry;
	private readonly detector?: Detector;

	constructor(detector: Detector | undefined, registry: Registry = processRegistry()) {
		this.detector = detector;
		this.registry = registry;
	}

	/** The placeholder of `secret`, created on first sight. */
	placeholderFor(secret: string, label: string): string {
		const existing = this.registry.bySecret.get(secret);
		if (existing) return existing;
		const kind = kindOf(label);
		const n = (this.registry.counters.get(kind) ?? 0) + 1;
		this.registry.counters.set(kind, n);
		const placeholder = `[REDACTED:${kind}-${n}]`;
		if (this.registry.bySecret.size < MAX_ENTRIES) {
			this.registry.bySecret.set(secret, placeholder);
			this.registry.byPlaceholder.set(placeholder, secret);
		}
		return placeholder;
	}

	private spans(text: string, options: RedactOptions): Span[] {
		const found = [...knownSpans(text, options.known), ...(this.detector?.ruleSpans(text, { named: options.named }) ?? [])];
		// Values already shown as placeholders this session (found by an
		// earlier rule or a since-removed variable) stay hidden too.
		for (const [secret, placeholder] of this.registry.bySecret) {
			if (secret.length < 8 || !text.includes(secret)) continue;
			const label = placeholder.slice("[REDACTED:".length, placeholder.lastIndexOf("-"));
			found.push(...knownSpans(text, [{ value: secret, label }]));
		}
		if (found.length === 0) return [];
		// Leave existing placeholders alone.
		const taken: [number, number][] = [];
		for (const match of text.matchAll(PLACEHOLDER)) taken.push([match.index, match.index + match[0].length]);
		const free = taken.length === 0 ? found : found.filter((span) => !taken.some(([start, end]) => span.start < end && span.end > start));
		return mergeSpans(free);
	}

	/** `text` with every secret replaced; `count` = replacements. */
	redactText(text: string, options: RedactOptions): { text: string; count: number } {
		if (!text) return { text, count: 0 };
		const spans = this.spans(text, options);
		if (spans.length === 0) return { text, count: 0 };
		let out = "";
		let at = 0;
		for (const span of spans) {
			const secret = text.slice(span.start, span.end);
			out += text.slice(at, span.start) + this.placeholderFor(secret, span.label);
			at = span.end;
			const kind = kindOf(span.label);
			this.registry.hits.set(kind, (this.registry.hits.get(kind) ?? 0) + 1);
		}
		return { text: out + text.slice(at), count: spans.length };
	}

	/** Every string inside a JSON-like value redacted; `count` = replacements. */
	redactValue<T>(value: T, options: RedactOptions, depth = 0): { value: T; count: number } {
		if (typeof value === "string") {
			const result = this.redactText(value, options);
			return { value: result.text as T, count: result.count };
		}
		if (depth > 20 || value === null || typeof value !== "object") return { value, count: 0 };
		let count = 0;
		if (Array.isArray(value)) {
			const out = value.map((item) => {
				const result = this.redactValue(item, options, depth + 1);
				count += result.count;
				return result.value;
			});
			return { value: (count > 0 ? out : value) as T, count };
		}
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			const result = this.redactValue(item, options, depth + 1);
			count += result.count;
			out[key] = result.value;
		}
		return { value: (count > 0 ? out : value) as T, count };
	}

	/** Placeholders of this process put back; `unknown` lists the ones it never issued. */
	restore(text: string): { text: string; restored: number; unknown: string[] } {
		let restored = 0;
		const unknown: string[] = [];
		const out = text.replace(PLACEHOLDER, (placeholder) => {
			const secret = this.registry.byPlaceholder.get(placeholder);
			if (secret === undefined) {
				unknown.push(placeholder);
				return placeholder;
			}
			restored++;
			return secret;
		});
		return { text: out, restored, unknown };
	}

	/** Placeholders in `text` that this process issued. */
	issuedIn(text: string): string[] {
		return [...text.matchAll(PLACEHOLDER)].map((match) => match[0]).filter((placeholder) => this.registry.byPlaceholder.has(placeholder));
	}
}
