/**
 * Finding skills: the store and the curated list by words in name and
 * description, and the skills.sh registry (the index `npx skills find`
 * searches) through its JSON endpoint, with the CLI as a fallback when the
 * endpoint is unreachable. Results carry the install count the registry
 * reports, the only reputation signal it offers.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CURATED, type StoreSkill } from "./catalog.ts";

const execFileAsync = promisify(execFile);

export interface RegistryHit {
	/** Install source: owner/repo@skill. */
	source: string;
	name: string;
	installs: number;
	url: string;
}

export const REGISTRY_URL = "https://skills.sh/api/search";

/** Words of a query, lowercased, 2+ characters (CJK words are kept whole). */
export function queryWords(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[\s,;/|]+/u)
		.map((word) => word.trim())
		.filter((word) => word.length >= 2 || /[\u3400-\u9fff]/u.test(word));
}

/** Score 0 (no match) upward: a word in the name counts more than one in the description. */
export function matchScore(words: readonly string[], name: string, description: string): number {
	const n = name.toLowerCase();
	const d = description.toLowerCase();
	let score = 0;
	for (const word of words) {
		if (n.includes(word)) score += 3;
		else if (d.includes(word)) score += 1;
	}
	return score;
}

export function searchStore(query: string, skills: readonly StoreSkill[]): StoreSkill[] {
	const words = queryWords(query);
	if (words.length === 0) return [...skills];
	return skills
		.map((skill) => ({ skill, score: matchScore(words, skill.name, skill.description) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
		.map((entry) => entry.skill);
}

export function searchCurated(query: string, installed: ReadonlySet<string>) {
	const words = queryWords(query);
	return CURATED.filter((entry) => !installed.has(entry.name)).filter(
		(entry) => words.length === 0 || matchScore(words, entry.name, entry.what) > 0,
	);
}

interface RegistryResponse {
	skills?: Array<{ source?: string; skillId?: string; name?: string; installs?: number }>;
}

export function parseRegistryResponse(data: unknown, limit: number): RegistryHit[] {
	const hits: RegistryHit[] = [];
	for (const item of (data as RegistryResponse)?.skills ?? []) {
		if (!item?.source || !item.skillId) continue;
		hits.push({
			source: `${item.source}@${item.skillId}`,
			name: item.name ?? item.skillId,
			installs: typeof item.installs === "number" ? item.installs : 0,
			url: `https://skills.sh/${item.source}/${item.skillId}`,
		});
		if (hits.length >= limit) break;
	}
	return hits;
}

const ANSI = /\u001b\[[0-9;]*m/gu;

/** Lines of `npx skills find`: `owner/repo@skill  N installs`. */
export function parseCliOutput(text: string, limit: number): RegistryHit[] {
	const hits: RegistryHit[] = [];
	for (const raw of text.replace(ANSI, "").split("\n")) {
		const match = raw.trim().match(/^([\w.-]+\/[\w.-]+)@([\w.-]+)\s+(\d+)\s+installs?/u);
		if (!match) continue;
		hits.push({
			source: `${match[1]}@${match[2]}`,
			name: match[2]!,
			installs: Number(match[3]),
			url: `https://skills.sh/${match[1]}/${match[2]}`,
		});
		if (hits.length >= limit) break;
	}
	return hits;
}

export interface RegistrySearch {
	hits: RegistryHit[];
	/** Set when neither the endpoint nor the CLI answered. */
	error?: string;
	via: "api" | "cli" | "none";
}

export async function searchRegistry(query: string, limit = 8, signal?: AbortSignal): Promise<RegistrySearch> {
	const q = query.trim();
	if (!q) return { hits: [], via: "none" };
	let apiError: string | undefined;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 8000);
		signal?.addEventListener("abort", () => controller.abort(), { once: true });
		try {
			const response = await fetch(`${REGISTRY_URL}?q=${encodeURIComponent(q)}`, { signal: controller.signal });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return { hits: parseRegistryResponse(await response.json(), limit), via: "api" };
		} finally {
			clearTimeout(timer);
		}
	} catch (error) {
		apiError = (error as Error).message;
	}
	try {
		const { stdout } = await execFileAsync("npx", ["-y", "skills@latest", "find", q], {
			timeout: 60_000,
			maxBuffer: 1024 * 1024,
			signal,
			env: { ...process.env, NO_COLOR: "1", CI: "1" },
		});
		return { hits: parseCliOutput(stdout, limit), via: "cli" };
	} catch (error) {
		return { hits: [], via: "none", error: `skills.sh: ${apiError}; npx skills: ${(error as Error).message}` };
	}
}
