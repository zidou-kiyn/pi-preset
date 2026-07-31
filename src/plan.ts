/**
 * Compute what /preset-sync would change.
 *
 * Read-only: this module reads files and probes the font, and computes a plan.
 * It never writes. apply.ts is the single side-effecting point, which is what
 * makes "decline changes nothing" a structural guarantee rather than a promise.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { detectFont, manualFontInstructions } from "./font.ts";
import { flattenLeaves, getPath, isPlainObject, type JsonObject, type JsonValue, readJsonObject } from "./json-merge.ts";
import { FONT, LOCAL_FOOTER_DIR_NAME, REQUIRED_PACKAGES, WEB_SEARCH_PATCH } from "./manifest.ts";
import {
	type FontPlatform,
	getDisabledExtensionsDir,
	getFontPlatform,
	getSettingsPath,
	getUserExtensionsDir,
	getWebSearchConfigPath,
} from "./paths.ts";

// ── package source identity ─────────────────────────────────────────────────
//
// Mirrors pi's getPackageIdentity (package-manager.ts): npm compares the
// package name, git compares host/path with any ref and .git suffix stripped,
// local compares the resolved absolute path. Reimplemented rather than imported
// because it is private to pi, and kept dependency-free (no hosted-git-info).

function parseNpmName(spec: string): string {
	const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
	return match?.[1] ?? spec;
}

function splitGitRef(url: string): { repo: string; ref?: string } {
	const scpLike = url.match(/^git@([^:]+):(.+)$/);
	if (scpLike) {
		const pathWithMaybeRef = scpLike[2] ?? "";
		const sep = pathWithMaybeRef.indexOf("@");
		if (sep < 0) return { repo: url };
		const repoPath = pathWithMaybeRef.slice(0, sep);
		const ref = pathWithMaybeRef.slice(sep + 1);
		if (!repoPath || !ref) return { repo: url };
		return { repo: `git@${scpLike[1] ?? ""}:${repoPath}`, ref };
	}

	if (url.includes("://")) {
		try {
			const parsed = new URL(url);
			const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, "");
			const sep = pathWithMaybeRef.indexOf("@");
			if (sep < 0) return { repo: url };
			const repoPath = pathWithMaybeRef.slice(0, sep);
			const ref = pathWithMaybeRef.slice(sep + 1);
			if (!repoPath || !ref) return { repo: url };
			parsed.pathname = `/${repoPath}`;
			return { repo: parsed.toString().replace(/\/$/, ""), ref };
		} catch {
			return { repo: url };
		}
	}

	const slashIndex = url.indexOf("/");
	if (slashIndex < 0) return { repo: url };
	const host = url.slice(0, slashIndex);
	const pathWithMaybeRef = url.slice(slashIndex + 1);
	const sep = pathWithMaybeRef.indexOf("@");
	if (sep < 0) return { repo: url };
	const repoPath = pathWithMaybeRef.slice(0, sep);
	const ref = pathWithMaybeRef.slice(sep + 1);
	if (!repoPath || !ref) return { repo: url };
	return { repo: `${host}/${repoPath}`, ref };
}

function isLocalPathSource(source: string): boolean {
	return source.startsWith(".") || isAbsolute(source) || source.startsWith("~");
}

/** Stable identity for a settings.json packages[] entry. */
export function packageIdentity(source: string, baseDir: string): string {
	const trimmed = source.trim();

	if (trimmed.startsWith("npm:")) {
		return `npm:${parseNpmName(trimmed.slice("npm:".length).trim())}`;
	}

	const hasGitPrefix = trimmed.startsWith("git:");
	const url = hasGitPrefix ? trimmed.slice("git:".length).trim() : trimmed;
	const looksLikeUrl = /^(https?|ssh|git):\/\//i.test(url) || /^git@[^:]+:/.test(url);

	if (hasGitPrefix || looksLikeUrl) {
		const { repo } = splitGitRef(url);
		let host = "";
		let path = "";

		const scpLike = repo.match(/^git@([^:]+):(.+)$/);
		if (scpLike) {
			host = scpLike[1] ?? "";
			path = scpLike[2] ?? "";
		} else if (repo.includes("://")) {
			try {
				const parsed = new URL(repo);
				host = parsed.hostname;
				path = parsed.pathname.replace(/^\/+/, "");
			} catch {
				return `raw:${trimmed}`;
			}
		} else {
			const slashIndex = repo.indexOf("/");
			if (slashIndex >= 0) {
				host = repo.slice(0, slashIndex);
				path = repo.slice(slashIndex + 1);
			}
		}

		path = path.replace(/\.git$/, "").replace(/^\/+/, "");
		if (host && path) return `git:${host}/${path}`;
		return `raw:${trimmed}`;
	}

	if (isLocalPathSource(trimmed)) {
		return `local:${resolve(baseDir, trimmed.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"))}`;
	}

	// Bare npm name (settings allows "pi-skills" without the npm: prefix).
	return `npm:${parseNpmName(trimmed)}`;
}

/** packages[] entries are either a source string or { source, ...filters }. */
export function packageEntrySource(entry: JsonValue): string | undefined {
	if (typeof entry === "string") return entry;
	if (isPlainObject(entry) && typeof entry.source === "string") return entry.source;
	return undefined;
}

// ── plan shape ──────────────────────────────────────────────────────────────

export interface PackagesAddStep {
	kind: "settings.packages.add";
	settingsPath: string;
	/** Sources to append, in manifest order. */
	missing: string[];
}

export interface WebSearchChange {
	key: string;
	path: string[];
	from: JsonValue | undefined;
	to: JsonValue;
}

export interface WebSearchPatchStep {
	kind: "webSearch.patch";
	configPath: string;
	changes: WebSearchChange[];
}

export interface FooterDemoteStep {
	kind: "footer.demote";
	from: string;
	to: string;
}

/** Only ever planned on platforms that actually install fonts (linux, darwin). */
export interface FontInstallStep {
	kind: "font.install";
	family: string;
	platform: Extract<FontPlatform, "linux" | "darwin">;
}

export type Step = PackagesAddStep | WebSearchPatchStep | FooterDemoteStep | FontInstallStep;

export type NoteLevel = "ok" | "info" | "warn";

export interface PlanNote {
	level: NoteLevel;
	text: string;
}

export interface SyncPlan {
	steps: Step[];
	/** Read-only observations: already-matching state, skips, and warnings. */
	notes: PlanNote[];
	/** Conditions that prevented a step from being planned at all (e.g. unparseable JSON). */
	blockers: string[];
}

// ── planning ────────────────────────────────────────────────────────────────

function planPackages(plan: SyncPlan): void {
	const settingsPath = getSettingsPath();
	const baseDir = dirname(settingsPath);

	let settings: JsonObject;
	try {
		settings = readJsonObject(settingsPath).data;
	} catch (error) {
		plan.blockers.push(`settings.json: ${(error as Error).message}`);
		return;
	}

	const rawPackages = settings.packages;
	const existing = Array.isArray(rawPackages) ? rawPackages : [];
	if (rawPackages !== undefined && !Array.isArray(rawPackages)) {
		plan.blockers.push(`settings.json: "packages" is not an array; refusing to touch it`);
		return;
	}

	const installed = new Set<string>();
	for (const entry of existing) {
		const source = packageEntrySource(entry);
		if (source) installed.add(packageIdentity(source, baseDir));
	}

	const missing = REQUIRED_PACKAGES.filter((source) => !installed.has(packageIdentity(source, baseDir)));

	if (missing.length === 0) {
		plan.notes.push({ level: "ok", text: `packages: all ${REQUIRED_PACKAGES.length} already in settings.json` });
		return;
	}

	const alreadyThere = REQUIRED_PACKAGES.length - missing.length;
	if (alreadyThere > 0) {
		plan.notes.push({ level: "ok", text: `packages: ${alreadyThere} already present` });
	}
	plan.steps.push({ kind: "settings.packages.add", settingsPath, missing });
}

function planWebSearch(plan: SyncPlan): void {
	const configPath = getWebSearchConfigPath();

	let config: JsonObject;
	try {
		config = readJsonObject(configPath).data;
	} catch (error) {
		plan.blockers.push(`web-search.json: ${(error as Error).message}`);
		return;
	}

	const changes: WebSearchChange[] = [];
	let matching = 0;
	for (const leaf of flattenLeaves(WEB_SEARCH_PATCH as unknown as JsonObject)) {
		const current = getPath(config, leaf.path);
		if (current === leaf.value) {
			matching++;
			continue;
		}
		changes.push({ key: leaf.path.join("."), path: leaf.path, from: current, to: leaf.value });
	}

	if (matching > 0) {
		plan.notes.push({ level: "ok", text: `web-search: ${matching} key(s) already match` });
	}
	if (changes.length === 0) return;

	plan.steps.push({ kind: "webSearch.patch", configPath, changes });
}

function planFooterDemote(plan: SyncPlan): void {
	const localFooter = join(getUserExtensionsDir(), LOCAL_FOOTER_DIR_NAME);
	if (!existsSync(localFooter)) return;

	const target = join(getDisabledExtensionsDir(), `${LOCAL_FOOTER_DIR_NAME}.local.bak`);
	const destination = existsSync(target) ? `${target}.${new Date().toISOString().replace(/[:.]/g, "-")}` : target;

	plan.steps.push({ kind: "footer.demote", from: localFooter, to: destination });
}

async function planFont(plan: SyncPlan): Promise<void> {
	const fontPlatform = getFontPlatform();

	// Platforms this package refuses to write fonts on never get a step: a step
	// that cannot write would make the plan permanently non-empty there, so every
	// run would prompt and no run could ever report "already in sync". The
	// instructions ride along as a note instead, which is rendered either way.
	if (fontPlatform === "win32" || fontPlatform === "unsupported") {
		plan.notes.push({
			level: fontPlatform === "win32" ? "info" : "warn",
			text: `font: no automatic install on this platform.\n${manualFontInstructions()}`,
		});
		return;
	}

	const found = await detectFont();
	if (found) {
		plan.notes.push({ level: "ok", text: `font: ${FONT.family} already installed` });
		return;
	}

	plan.steps.push({ kind: "font.install", family: FONT.family, platform: fontPlatform });
}

/**
 * Build the full plan. Steps only exist when something actually needs to change,
 * so an empty steps array means "already in sync".
 */
export async function plan(): Promise<SyncPlan> {
	const result: SyncPlan = { steps: [], notes: [], blockers: [] };

	planPackages(result);
	planWebSearch(result);
	planFooterDemote(result);
	await planFont(result);

	return result;
}

/** Render a plan as the confirmation body / non-interactive report. */
export function renderPlan(syncPlan: SyncPlan): string {
	const lines: string[] = [];

	for (const step of syncPlan.steps) {
		switch (step.kind) {
			case "settings.packages.add":
				lines.push(`+ settings.json packages[]: add ${step.missing.length}`);
				for (const source of step.missing) lines.push(`    ${source}`);
				break;
			case "webSearch.patch":
				lines.push(`~ web-search.json: set ${step.changes.length} key(s)`);
				for (const change of step.changes) {
					const from = change.from === undefined ? "unset" : JSON.stringify(change.from);
					lines.push(`    ${change.key}: ${from} -> ${JSON.stringify(change.to)}`);
				}
				break;
			case "footer.demote":
				lines.push("~ local vibrant-footer would double-load: move it aside");
				lines.push(`    ${step.from}`);
				lines.push(`    -> ${step.to}`);
				break;
			case "font.install":
				lines.push(`+ font ${step.family}: download latest release and install`);
				break;
		}
	}

	for (const note of syncPlan.notes) {
		const marker = note.level === "ok" ? "=" : note.level === "warn" ? "!" : "i";
		lines.push(`${marker} ${note.text}`);
	}

	for (const blocker of syncPlan.blockers) {
		lines.push(`! blocked: ${blocker}`);
	}

	if (lines.length === 0) lines.push("nothing to do");
	return lines.join("\n");
}
