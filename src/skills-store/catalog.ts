/**
 * The skill store: skills kept on disk but loaded only when enabled.
 *
 * Two layers, merged by name (a local skill shadows a bundled one):
 *   - bundled:  <preset>/skills-store/<group>/<name>/SKILL.md, shipped with
 *               the preset but NOT listed in package.json `pi.skills`, so pi
 *               never loads them on its own. The group directory names the
 *               origin (pi-preset, humanizer, anthropics) and may hold the
 *               upstream LICENSE / NOTICE;
 *   - local:    <agent dir>/pi-preset/skills/<name>/SKILL.md, what the user
 *               installed from GitHub, created, or imported from pi's own
 *               skill directories. Grouped by the repository they came from
 *               (owner/repo), or "local" when created or imported.
 *
 * Neither directory is one pi scans. The extension reports enabled skills
 * through `resources_discover`; everything else stays out of the system
 * prompt.
 *
 * `CURATED` is the preset's short list of recommended third-party skills.
 * They are fetched on demand (see install.ts), never vendored, so there is
 * no license to carry and they are always installed at their latest version.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../paths.ts";

export const PRESET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Bundled skills, shipped with the preset. */
export function bundledStoreDir(root: string = PRESET_ROOT): string {
	return join(root, "skills-store");
}

/** The user's own store. */
export function localStoreDir(): string {
	return join(getAgentDir(), "pi-preset", "skills");
}

/** Metadata written next to an installed skill's SKILL.md, for update checks. */
export const SOURCE_FILE = ".pi-preset-source.json";

export interface InstallRecord {
	/** What the user typed: owner/repo, owner/repo@skill, a URL, or a local path. */
	source: string;
	/** Git URL the files came from (absent for local paths). */
	repo?: string;
	/** Directory of the skill inside the repository ("" = repository root). */
	path: string;
	/** Commit the files were taken from. */
	commit?: string;
	installedAt: string;
}

export type SkillOrigin = "bundled" | "local";

/** Group of skills created or imported by hand. */
export const LOCAL_GROUP = "local";
/** The bundled group of the preset's own skills; shown first. */
export const PRESET_GROUP = "pi-preset";

export interface StoreSkill {
	name: string;
	description: string;
	/** Where it comes from: the bundled group directory, or the owner/repo it was installed from, or LOCAL_GROUP. */
	group: string;
	/** Directory holding SKILL.md. */
	dir: string;
	/** Absolute path of SKILL.md; what resources_discover reports. */
	filePath: string;
	origin: SkillOrigin;
	/** Present when the skill was installed from somewhere (local only). */
	install?: InstallRecord;
	/** A bundled skill of the same name is hidden by this local one. */
	shadows?: boolean;
}

export interface CuratedSkill {
	/** Name the skill will have in the store. */
	name: string;
	/** Install source, as `skills install` takes it. */
	source: string;
	/** One line: what it is for. English for the model; the menu adds its own translation. */
	what: string;
}

/**
 * Recommended third-party skills. Keep this short: a skill belongs here when
 * it is the well-known one for its job, not merely a good one.
 */
export const CURATED: readonly CuratedSkill[] = [
	{
		name: "officecli",
		source: "officecli/officecli@officecli",
		what: "Create, inspect, and edit .docx/.xlsx/.pptx through the officecli binary (installs it on first use); DOM-level edits and a built-in help schema",
	},
	{
		name: "docx",
		source: "anthropics/skills@docx",
		what: "Create and edit Word documents with tracked changes and comments (Anthropic; proprietary license, so fetched rather than bundled)",
	},
	{
		name: "xlsx",
		source: "anthropics/skills@xlsx",
		what: "Create and analyze spreadsheets with formulas and formatting (Anthropic; proprietary license)",
	},
	{
		name: "pptx",
		source: "anthropics/skills@pptx",
		what: "Create and edit PowerPoint presentations (Anthropic; proprietary license)",
	},
	{
		name: "pdf",
		source: "anthropics/skills@pdf",
		what: "Read, fill, merge, and create PDF files (Anthropic; proprietary license)",
	},
	{
		name: "code-review-and-quality",
		source: "addyosmani/agent-skills@code-review-and-quality",
		what: "Review a change for correctness, readability, architecture, security, and performance before it is merged (Addy Osmani)",
	},
	{
		name: "vercel-react-best-practices",
		source: "vercel-labs/agent-skills@vercel-react-best-practices",
		what: "Vercel's React and Next.js best practices",
	},
];

/** The Agent Skills name rule: lowercase letters, digits, single hyphens, at most 64 characters. */
export const NAME_RULE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	/** Everything after the closing `---`. */
	body: string;
}

/** Minimal frontmatter reader: `name:` and `description:` (plain, quoted, or `>`/`|` block scalars). */
export function parseSkillFrontmatter(text: string): SkillFrontmatter | undefined {
	const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
	const lines = source.split(/\r?\n/u);
	if ((lines[0] ?? "").trim() !== "---") return undefined;
	const result: SkillFrontmatter = { body: "" };
	let blockKey: "name" | "description" | undefined;
	let block: string[] = [];
	const flush = () => {
		if (blockKey) result[blockKey] = block.join(" ").trim();
		blockKey = undefined;
		block = [];
	};
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.trim() === "---") {
			flush();
			result.body = lines.slice(i + 1).join("\n");
			return result;
		}
		if (blockKey && (line.trim() === "" || /^\s/u.test(line))) {
			if (line.trim()) block.push(line.trim());
			continue;
		}
		flush();
		const match = line.match(/^([A-Za-z_][\w-]*)\s*:(.*)$/u);
		if (!match) continue;
		const key = match[1];
		if (key !== "name" && key !== "description") continue;
		const raw = (match[2] ?? "").trim();
		if (/^[|>][+-]?$/u.test(raw)) {
			blockKey = key;
			continue;
		}
		const value =
			raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw.at(-1) === raw[0] ? raw.slice(1, -1) : raw;
		result[key] = value.trim();
	}
	return undefined;
}

/** Why a SKILL.md cannot be a skill, or undefined when it is fine. */
export function validateSkill(text: string, expectedName?: string): string | undefined {
	const fm = parseSkillFrontmatter(text);
	if (!fm) return "SKILL.md must start with a `---` frontmatter block that closes with `---`";
	if (!fm.name) return "frontmatter has no `name`";
	if (!NAME_RULE.test(fm.name) || fm.name.length > NAME_MAX) {
		return `name "${fm.name}" is not lowercase letters, digits, and single hyphens (max ${NAME_MAX})`;
	}
	if (expectedName && fm.name !== expectedName) return `name "${fm.name}" differs from the directory "${expectedName}"`;
	if (!fm.description) return "frontmatter has no `description` (pi does not load a skill without one)";
	if (fm.description.length > DESCRIPTION_MAX) return `description is ${fm.description.length} characters; the limit is ${DESCRIPTION_MAX}`;
	if (!fm.body.trim()) return "SKILL.md has no instructions after the frontmatter";
	return undefined;
}

/** "owner/repo" for any source form; undefined for a local path. */
export function sourceRepo(source: string): string | undefined {
	const s = source.trim();
	let match = s.match(/^https?:\/\/(?:github\.com|gitlab\.com)\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/.*)?$/u);
	if (match) return `${match[1]}/${match[2]}`;
	match = s.match(/^(?:git@[^:]+:|ssh:\/\/[^/]+\/)([^/]+)\/([^/]+?)(?:\.git)?$/u);
	if (match) return `${match[1]}/${match[2]}`;
	match = s.match(/^([\w.-]+)\/([\w.-]+?)(?:@[\w.-]+)?$/u);
	if (match) return `${match[1]}/${match[2]}`;
	return undefined;
}

function readInstall(dir: string): InstallRecord | undefined {
	try {
		const data = JSON.parse(readFileSync(join(dir, SOURCE_FILE), "utf8")) as InstallRecord;
		return data && typeof data.source === "string" ? data : undefined;
	} catch {
		return undefined;
	}
}

/** Read one skill directory; undefined when it holds no usable SKILL.md. */
export function readStoreSkill(dir: string, origin: SkillOrigin, group?: string): StoreSkill | undefined {
	const filePath = join(dir, "SKILL.md");
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	const fm = parseSkillFrontmatter(text);
	if (!fm?.name || !fm.description) return undefined;
	const skill: StoreSkill = { name: fm.name, description: fm.description, group: group ?? LOCAL_GROUP, dir, filePath, origin };
	if (origin === "local") {
		const install = readInstall(dir);
		if (install) {
			skill.install = install;
			skill.group = sourceRepo(install.source) ?? LOCAL_GROUP;
		}
	}
	return skill;
}

function subdirs(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.sort()
		.filter((entry) => {
			if (entry.startsWith(".")) return false;
			try {
				return statSync(join(dir, entry)).isDirectory();
			} catch {
				return false;
			}
		});
}

/** The local store: every `<dir>/<name>/SKILL.md`, grouped by install source. */
export function scanLocalDir(dir: string): StoreSkill[] {
	const skills: StoreSkill[] = [];
	for (const entry of subdirs(dir)) {
		const skill = readStoreSkill(join(dir, entry), "local");
		if (skill) skills.push(skill);
	}
	return skills;
}

/** The bundled store: every `<dir>/<group>/<name>/SKILL.md`. */
export function scanBundledDir(dir: string): StoreSkill[] {
	const skills: StoreSkill[] = [];
	for (const group of subdirs(dir)) {
		for (const entry of subdirs(join(dir, group))) {
			const skill = readStoreSkill(join(dir, group, entry), "bundled", group);
			if (skill) skills.push(skill);
		}
	}
	return skills;
}


export interface Store {
	bundledDir: string;
	localDir: string;
}

export function defaultStore(): Store {
	return { bundledDir: bundledStoreDir(), localDir: localStoreDir() };
}

/** Both layers merged by name, local first; sorted by name. */
export function loadStore(store: Store = defaultStore()): StoreSkill[] {
	const byName = new Map<string, StoreSkill>();
	for (const skill of scanBundledDir(store.bundledDir)) byName.set(skill.name, skill);
	for (const skill of scanLocalDir(store.localDir)) {
		if (byName.has(skill.name)) skill.shadows = true;
		byName.set(skill.name, skill);
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The curated skills not yet in the store. */
export function missingCurated(skills: readonly StoreSkill[]): CuratedSkill[] {
	const names = new Set(skills.map((skill) => skill.name));
	return CURATED.filter((entry) => !names.has(entry.name));
}
