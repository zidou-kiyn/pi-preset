/**
 * UI language for the preset's own extensions: English or Chinese.
 *
 * Which one, first match wins:
 *   1. PI_PRESET_LANG (en | zh, or a locale such as zh_CN.UTF-8);
 *   2. the choice saved from /pi-preset (<agent dir>/pi-preset/settings.json,
 *      "language": "auto" | "en" | "zh");
 *   3. the system locale: LC_ALL, LC_MESSAGES, LANG (the first one set), then
 *      Intl (Windows rarely sets LANG).
 *
 * Each feature keeps one catalog of its UI text:
 *
 *   const en = { hosts: "Hosts", hostCount: (n: number) => `${n} hosts` };
 *   const zh: typeof en = { hosts: "主机", hostCount: (n) => `${n} 台` };
 *   export const catalogs = { en, zh };
 *   export const messages = localized(catalogs);
 *
 * and calls `const m = messages()` where it builds UI. `typeof en` makes an
 * editor flag a missing or extra entry; test/i18n.test.ts checks every
 * catalog the same way, because the test run does not type-check.
 *
 * Only text the user reads goes through catalogs. Text for the model (tool
 * descriptions, block reasons, errors it reads, injected notes) stays English.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "./paths.ts";

export type Lang = "en" | "zh";
export type LanguageChoice = "auto" | Lang;
export const LANGUAGE_CHOICES: readonly LanguageChoice[] = ["auto", "en", "zh"];

/** The preset's own settings (not pi's settings.json, which pi rewrites from its own snapshot). */
export function presetSettingsPath(): string {
	return join(getAgentDir(), "pi-preset", "settings.json");
}

/** "zh", "zh_CN.UTF-8", "zh-Hans" → zh; anything else that names a language → en. */
export function langOf(value: string | undefined): Lang | undefined {
	const text = value?.trim();
	if (!text) return undefined;
	return /^zh([_.\-@]|$)/i.test(text) ? "zh" : "en";
}

/** The language the system locale asks for. */
export function localeLang(env: NodeJS.ProcessEnv = process.env): Lang {
	for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
		const lang = langOf(env[name]);
		if (lang) return lang;
	}
	try {
		return langOf(Intl.DateTimeFormat().resolvedOptions().locale) ?? "en";
	} catch {
		return "en";
	}
}

let cached: { path: string; mtimeMs: number; choice: LanguageChoice } | undefined;

/** The saved /pi-preset choice; "auto" when nothing is saved. Re-read when the file changes. */
export function readLanguageChoice(): LanguageChoice {
	const path = presetSettingsPath();
	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		return "auto";
	}
	if (cached?.path === path && cached.mtimeMs === mtimeMs) return cached.choice;
	let choice: LanguageChoice = "auto";
	try {
		const value = JSON.parse(readFileSync(path, "utf8"))?.language;
		if ((LANGUAGE_CHOICES as readonly unknown[]).includes(value)) choice = value;
	} catch {
		// unreadable: auto
	}
	cached = { path, mtimeMs, choice };
	return choice;
}

/** Save the /pi-preset choice, keeping any other keys in the file. */
export function writeLanguageChoice(choice: LanguageChoice): void {
	const path = presetSettingsPath();
	let data: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
	} catch {
		// missing or unreadable: start over
	}
	if (choice === "auto") delete data.language;
	else data.language = choice;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
	cached = undefined;
}

/** The UI language in effect now. */
export function currentLang(env: NodeJS.ProcessEnv = process.env): Lang {
	const forced = langOf(env.PI_PRESET_LANG);
	if (forced) return forced;
	const choice = readLanguageChoice();
	return choice === "auto" ? localeLang(env) : choice;
}

/** A getter for the catalog of the language in effect. */
export function localized<T>(catalogs: Record<Lang, T>): () => T {
	return () => catalogs[currentLang()];
}

/**
 * Differences between the catalogs: entries missing from one language,
 * entries whose kind differs (text vs function), and functions whose
 * parameter counts differ. Empty when they match.
 */
export function catalogMismatches(catalogs: Record<Lang, object>): string[] {
	const problems: string[] = [];
	const [base, ...rest] = Object.keys(catalogs) as Lang[];
	const reference = catalogs[base!] as Record<string, unknown>;
	for (const lang of rest) {
		const other = catalogs[lang] as Record<string, unknown>;
		for (const key of Object.keys(reference)) {
			if (!(key in other)) problems.push(`${lang} is missing ${key}`);
		}
		for (const key of Object.keys(other)) {
			if (!(key in reference)) {
				problems.push(`${lang} has ${key}, ${base} does not`);
				continue;
			}
			const a = reference[key];
			const b = other[key];
			if (typeof a !== typeof b) problems.push(`${key}: ${base} is ${typeof a}, ${lang} is ${typeof b}`);
			else if (typeof a === "function" && (a as () => unknown).length !== (b as () => unknown).length) {
				problems.push(`${key}: ${base} takes ${(a as () => unknown).length} argument(s), ${lang} takes ${(b as () => unknown).length}`);
			} else if (typeof a === "string" && (a === "" || b === "")) problems.push(`${key}: empty text`);
		}
	}
	return problems;
}
