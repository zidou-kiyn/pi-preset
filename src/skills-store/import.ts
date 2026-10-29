/**
 * Moving skills out of pi's always-loaded directories into the store, so
 * they become on-demand. Offered once from /skills when those directories
 * hold something; also available any time from the menu.
 *
 * Covers the two user-level directories pi scans: <agent dir>/skills and
 * ~/.agents/skills (where `npx skills add -g` writes). Project directories
 * and ~/.claude are left alone. A moved directory goes to
 * <agent dir>/pi-preset/skills-import-backup/<stamp>/ rather than being
 * deleted; symlinks (the skills CLI's mirrors) are removed, not followed.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, getLegacySkillRoots } from "../paths.ts";
import { readStoreSkill, type StoreSkill } from "./catalog.ts";

export interface ImportCandidate {
	name: string;
	description: string;
	/** Directory in pi's skill tree (the directory holding SKILL.md). */
	dir: string;
	/** Which pi directory it is under. */
	root: string;
	/** A store skill of the same name exists already. */
	conflict: boolean;
}

export function importRoots(): string[] {
	return getLegacySkillRoots();
}

/** Skills in pi's user-level skill directories (top-level entries only, symlinks included). */
export function findImportable(storeNames: ReadonlySet<string>, roots: string[] = importRoots()): ImportCandidate[] {
	const found: ImportCandidate[] = [];
	for (const root of roots) {
		if (!existsSync(root)) continue;
		let entries: string[];
		try {
			entries = readdirSync(root).sort();
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.startsWith(".")) continue;
			const dir = join(root, entry);
			const skill = readStoreSkill(dir, "local");
			if (!skill) continue;
			found.push({ name: skill.name, description: skill.description, dir, root, conflict: storeNames.has(skill.name) });
		}
	}
	return found;
}

export function backupDir(): string {
	return join(getAgentDir(), "pi-preset", "skills-import-backup");
}

export interface ImportOutcome {
	skill: StoreSkill;
	backup: string;
}

/** Copy one candidate into the store and move the original into the backup directory. */
export function importSkill(candidate: ImportCandidate, localDir: string, stamp: string = new Date().toISOString().replace(/[:.]/gu, "-")): ImportOutcome {
	const target = join(localDir, candidate.name);
	mkdirSync(localDir, { recursive: true });
	rmSync(target, { recursive: true, force: true });
	cpSync(candidate.dir, target, { recursive: true, dereference: true, filter: (src) => basename(src) !== ".git" });
	const skill = readStoreSkill(target, "local");
	if (!skill) throw new Error(`${candidate.name}: SKILL.md is not loadable after copying`);
	const backupRoot = join(backupDir(), stamp, basename(candidate.root) === "skills" ? basename(join(candidate.root, "..")) : basename(candidate.root));
	mkdirSync(backupRoot, { recursive: true });
	const backup = join(backupRoot, basename(candidate.dir));
	if (lstatSync(candidate.dir).isSymbolicLink()) {
		rmSync(candidate.dir, { force: true });
		return { skill, backup: "" };
	}
	renameSync(candidate.dir, backup);
	return { skill, backup };
}
